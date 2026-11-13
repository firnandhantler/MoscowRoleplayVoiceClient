'use strict';

/**
 * WebSocket-клиент сигнализации живёт в главном процессе.
 *
 * Причины:
 * - токен сессии не попадает в renderer;
 * - переподключение и heartbeat выполняются в одном месте;
 * - renderer получает только готовые сообщения протокола и состояние соединения.
 *
 * Повторная авторизация после обрыва выполняется автоматически тем же токеном.
 */

const { WebSocket } = require('ws');

const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 12_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

/** Код закрытия, которым сервер сообщает о входе с другого подключения. */
const CLOSE_REPLACED = 4001;

const SignalingState = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  AUTHENTICATING: 'authenticating',
  READY: 'ready',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
  ERROR: 'error',
  REPLACED: 'replaced',
});

/**
 * Создаёт сообщение протокола.
 *
 * @param {string} type
 * @param {object} data
 * @returns {object}
 */
function createMessage(type, data) {
  return { v: PROTOCOL_VERSION, type, data };
}

class SignalingClient {
  /**
   * @param {{
   *   getWsUrl: () => string,
   *   getToken: () => string|null,
   *   refreshToken: () => Promise<boolean>,
   *   onState: (state: object) => void,
   *   onMessage: (message: object) => void,
   * }} options
   */
  constructor({ getWsUrl, getToken, refreshToken, onState, onMessage }) {
    this.getWsUrl = getWsUrl;
    this.getToken = getToken;
    this.refreshToken = refreshToken;
    this.onState = onState;
    this.onMessage = onMessage;

    this.socket = null;
    this.state = SignalingState.IDLE;
    this.intent = false;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastPongAt = 0;
    this.lastError = null;
    this.connectedAt = null;
    this.refreshing = false;
  }

  /** @returns {{state: string, attempt: number, error: object|null}} */
  getStatus() {
    return {
      state: this.state,
      attempt: this.attempt,
      error: this.lastError,
      wsUrl: this.getWsUrl(),
    };
  }

  /**
   * Устанавливает соединение. Повторный вызов безопасен.
   */
  connect() {
    this.intent = true;

    if (
      this.state === SignalingState.CONNECTING ||
      this.state === SignalingState.AUTHENTICATING ||
      this.state === SignalingState.READY
    ) {
      return;
    }

    this.attempt = 0;
    this.#open();
  }

  /** Разрывает соединение по инициативе пользователя. */
  disconnect() {
    this.intent = false;
    this.attempt = 0;
    this.#clearTimers();

    if (this.socket !== null) {
      const socket = this.socket;

      this.socket = null;

      try {
        socket.close(1000, 'Клиент завершает работу');
      } catch {
        // Сокет уже мог быть закрыт.
      }
    }

    this.#setState(SignalingState.CLOSED);
  }

  /**
   * Отправляет сообщение серверу.
   *
   * @param {unknown} message
   * @returns {{sent: boolean, reason?: string}}
   */
  send(message) {
    if (
      typeof message !== 'object' ||
      message === null ||
      typeof message.type !== 'string' ||
      !message.type.startsWith('client.')
    ) {
      return { sent: false, reason: 'invalid_message' };
    }

    const socket = this.socket;

    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return { sent: false, reason: 'not_connected' };
    }

    if (this.state !== SignalingState.READY && message.type !== 'client.authenticate') {
      return { sent: false, reason: 'not_ready' };
    }

    const payload = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: message.type,
      ...(typeof message.id === 'string' ? { id: message.id } : {}),
      data: typeof message.data === 'object' && message.data !== null ? message.data : {},
    });

    if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) {
      return { sent: false, reason: 'too_large' };
    }

    try {
      socket.send(payload);
      return { sent: true };
    } catch {
      return { sent: false, reason: 'send_failed' };
    }
  }

  /** Закрывает соединение при выходе из приложения. */
  dispose() {
    this.disconnect();
  }

  #open() {
    const wsUrl = this.getWsUrl();
    const token = this.getToken();

    if (token === null) {
      this.#failWith({
        code: 'not_authenticated',
        message: 'Требуется вход через Discord.',
      });
      return;
    }

    this.#setState(this.attempt === 0 ? SignalingState.CONNECTING : SignalingState.RECONNECTING);

    let socket;

    try {
      socket = new WebSocket(wsUrl, {
        handshakeTimeout: 10_000,
        maxPayload: 256 * 1024,
      });
    } catch (err) {
      this.#handleDisconnect({
        code: 'connect_failed',
        message: err instanceof Error ? err.message : 'Не удалось подключиться к серверу.',
      });
      return;
    }

    this.socket = socket;

    socket.on('open', () => {
      this.#setState(SignalingState.AUTHENTICATING);

      const sent = this.send(createMessage('client.authenticate', { token: this.getToken() }));

      if (!sent.sent) {
        this.#handleDisconnect({ code: 'authenticate_failed', message: 'Не удалось отправить данные входа.' });
        return;
      }

      this.#startHeartbeat();
    });

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        return;
      }

      let message;

      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
        return;
      }

      this.#handleServerMessage(message);
    });

    socket.on('pong', () => {
      this.lastPongAt = Date.now();
    });

    socket.on('error', (err) => {
      this.lastError = {
        code: err?.code ?? 'socket_error',
        message: err instanceof Error ? err.message : 'Ошибка WebSocket-соединения.',
      };
    });

    socket.on('close', (code, reason) => {
      this.#clearHeartbeat();
      this.socket = null;

      if (!this.intent) {
        this.#setState(SignalingState.CLOSED);
        return;
      }

      if (code === CLOSE_REPLACED) {
        this.intent = false;
        this.#failWith({
          code: 'session_replaced',
          message: 'Выполнен вход с другого подключения. Закройте лишний клиент.',
        });
        return;
      }

      this.#handleDisconnect({
        code: 'connection_closed',
        message:
          code === 1000
            ? 'Соединение закрыто сервером.'
            : `Соединение прервано${reason?.length ? `: ${reason.toString('utf8')}` : '.'}`,
        closeCode: code,
      });
    });
  }

  /**
   * Обрабатывает сообщение сервера.
   *
   * @param {{type: string, data?: object, id?: string}} message
   */
  #handleServerMessage(message) {
    if (message.type === 'server.hello') {
      return;
    }

    if (message.type === 'server.pong') {
      this.lastPongAt = Date.now();
      return;
    }

    if (message.type === 'server.error') {
      const code = message.data?.code;

      if (code === 'not_authenticated' && this.state === SignalingState.AUTHENTICATING) {
        void this.#handleAuthFailure(message.data?.message);
        return;
      }

      this.onMessage(message);
      return;
    }

    if (message.type === 'server.authenticated') {
      this.attempt = 0;
      this.lastError = null;
      this.connectedAt = Date.now();
      this.lastPongAt = Date.now();
      this.#setState(SignalingState.READY);
      this.onMessage(message);
      return;
    }

    this.onMessage(message);
  }

  /**
   * Пытается обновить сессию и повторить вход после отказа авторизации.
   *
   * @param {string|undefined} serverMessage
   * @returns {Promise<void>}
   */
  async #handleAuthFailure(serverMessage) {
    if (this.refreshing) {
      return;
    }

    this.refreshing = true;

    try {
      const refreshed = await this.refreshToken();

      if (!refreshed) {
        this.intent = false;
        this.#clearTimers();

        if (this.socket !== null) {
          try {
            this.socket.close(1000, 'Сессия истекла');
          } catch {
            // ignore
          }

          this.socket = null;
        }

        this.#failWith({
          code: 'not_authenticated',
          message: serverMessage ?? 'Сессия истекла. Войдите заново.',
        });
        return;
      }

      // Сессия обновлена: повторяем вход тем же соединением.
      this.send(createMessage('client.authenticate', { token: this.getToken() }));
    } finally {
      this.refreshing = false;
    }
  }

  #startHeartbeat() {
    this.#clearHeartbeat();
    this.lastPongAt = Date.now();

    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;

      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS) {
        this.lastError = {
          code: 'heartbeat_timeout',
          message: 'Сервер не отвечает, соединение перезапускается.',
        };

        try {
          socket.terminate();
        } catch {
          // ignore
        }

        return;
      }

      socket.ping();
      this.send(createMessage('client.ping', { nonce: String(Date.now()) }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  #clearHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  #clearTimers() {
    this.#clearHeartbeat();

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Планирует переподключение с экспоненциальной задержкой.
   *
   * @param {{code: string, message: string, closeCode?: number}} error
   */
  #handleDisconnect(error) {
    this.lastError = { code: error.code, message: error.message };

    if (!this.intent) {
      this.#setState(SignalingState.CLOSED);
      return;
    }

    this.attempt += 1;

    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** Math.min(this.attempt - 1, 5),
    );
    const jitter = Math.round(delay * 0.2 * Math.random());

    this.#setState(SignalingState.RECONNECTING);

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.intent) {
        this.#open();
      }
    }, delay + jitter);

    this.reconnectTimer.unref?.();
  }

  /**
   * Останавливает переподключение и сообщает об ошибке.
   *
   * @param {{code: string, message: string}} error
   */
  #failWith(error) {
    this.lastError = error;
    this.intent = false;
    this.#clearTimers();
    this.#setState(SignalingState.ERROR);
  }

  /**
   * @param {string} state
   */
  #setState(state) {
    if (this.state === state) {
      return;
    }

    this.state = state;

    this.onState({
      state,
      attempt: this.attempt,
      error: this.lastError,
      connectedAt: this.connectedAt,
    });
  }
}

module.exports = { SignalingClient, SignalingState };
