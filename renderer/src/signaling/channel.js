/**
 * Канал сигнализации в renderer.
 *
 * Сам WebSocket живёт в главном процессе (токен не попадает в renderer),
 * поэтому здесь только:
 * - отправка сообщений через IPC;
 * - сопоставление запросов и ответов по полю `id`;
 * - подписка на поток серверных сообщений.
 */

import { PROTOCOL_VERSION } from './protocol.js';

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Ошибка протокола с машиночитаемым кодом.
 */
export class SignalingError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'SignalingError';
    this.code = code;
  }
}

/**
 * Понятное описание причины, по которой сообщение не удалось отправить.
 *
 * @param {string} reason
 * @returns {string}
 */
function describeSendFailure(reason) {
  switch (reason) {
    case 'not_connected':
      return 'Нет соединения с сервером.';
    case 'not_ready':
      return 'Соединение ещё не авторизовано.';
    case 'too_large':
      return 'Сообщение слишком велико для отправки.';
    case 'invalid_message':
      return 'Внутренняя ошибка клиента: некорректное сообщение.';
    default:
      return 'Не удалось отправить сообщение на сервер.';
  }
}

let counter = 0;

/**
 * Короткий уникальный идентификатор запроса.
 * Формат соответствует требованиям сервера: [A-Za-z0-9_-]{1,64}.
 *
 * @returns {string}
 */
function createRequestId() {
  counter = (counter + 1) % 1_000_000;

  return `r${Date.now().toString(36)}${counter.toString(36)}`;
}

export class SignalingChannel {
  /**
   * @param {{
   *   bridge: object,
   *   onMessage?: ((message: object) => void)|null,
   *   onState?: ((state: object) => void)|null,
   * }} options
   */
  constructor({ bridge, onMessage = null, onState = null }) {
    this.bridge = bridge;
    this.onMessage = onMessage;
    this.onState = onState;
    /** @type {Map<string, {resolve: Function, reject: Function, types: Set<string>, timer: number}>} */
    this.pending = new Map();
    this.authenticated = false;
    this.state = { state: 'idle', attempt: 0, error: null };
    this.disposers = [];

    this.disposers.push(
      bridge.events.onSignalMessage((message) => {
        this.#handleMessage(message);
      }),
    );

    this.disposers.push(
      bridge.events.onSignalState((state) => {
        this.#handleState(state);
      }),
    );
  }

  /** @returns {boolean} */
  isReady() {
    return this.authenticated;
  }

  /** @returns {object} */
  getState() {
    return this.state;
  }

  /** Подключается к серверу. */
  async connect() {
    this.authenticated = false;
    await this.bridge.signaling.connect();
  }

  /** Отключается (например, при выходе из аккаунта). */
  async disconnect() {
    this.authenticated = false;
    this.#rejectAll(new SignalingError('Соединение закрыто.', 'disconnected'));
    await this.bridge.signaling.disconnect();
  }

  /**
   * Отправляет сообщение без ожидания ответа.
   *
   * @param {string} type
   * @param {object} data
   * @returns {Promise<void>}
   */
  async send(type, data = {}) {
    const result = await this.bridge.signaling.send({
      v: PROTOCOL_VERSION,
      type,
      data,
    });

    if (!result?.ok) {
      throw new SignalingError(describeSendFailure(result?.reason), result?.reason ?? 'send_failed');
    }
  }

  /**
   * Отправляет запрос и ждёт ответ одного из ожидаемых типов.
   *
   * @param {string} type
   * @param {object} data
   * @param {string[]} expectedTypes
   * @param {{timeoutMs?: number}} options
   * @returns {Promise<object>} Полезная нагрузка ответа.
   */
  async request(type, data, expectedTypes, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const id = createRequestId();

    const response = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new SignalingError('Сервер не ответил вовремя.', 'timeout'));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        types: new Set(expectedTypes),
        timer,
      });
    });

    try {
      const result = await this.bridge.signaling.send({
        v: PROTOCOL_VERSION,
        type,
        id,
        data,
      });

      if (!result?.ok) {
        const entry = this.pending.get(id);

        if (entry) {
          window.clearTimeout(entry.timer);
          this.pending.delete(id);
        }

        throw new SignalingError(
          describeSendFailure(result?.reason),
          result?.reason ?? 'send_failed',
        );
      }
    } catch (err) {
      const entry = this.pending.get(id);

      if (entry) {
        window.clearTimeout(entry.timer);
        this.pending.delete(id);
      }

      throw err;
    }

    return response;
  }

  /** Освобождает подписки. */
  dispose() {
    for (const dispose of this.disposers) {
      dispose();
    }

    this.disposers = [];
    this.#rejectAll(new SignalingError('Клиент закрыт.', 'disposed'));
  }

  /**
   * @param {object} message
   */
  #handleMessage(message) {
    if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
      return;
    }

    const id = typeof message.id === 'string' ? message.id : null;

    if (id !== null && this.pending.has(id)) {
      const entry = this.pending.get(id);

      if (message.type === 'server.error') {
        window.clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(
          new SignalingError(
            message.data?.message ?? 'Сервер отклонил запрос.',
            message.data?.code ?? 'server_error',
          ),
        );
        return;
      }

      if (entry.types.has(message.type)) {
        window.clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.resolve(message.data ?? {});
      }
    }

    if (message.type === 'server.authenticated') {
      this.authenticated = true;
    }

    this.onMessage?.(message);
  }

  /**
   * @param {object} state
   */
  #handleState(state) {
    this.state = state;

    if (state.state !== 'ready') {
      this.authenticated = false;
    }

    this.onState?.(state);
  }

  /**
   * @param {Error} error
   */
  #rejectAll(error) {
    for (const [, entry] of this.pending) {
      window.clearTimeout(entry.timer);
      entry.reject(error);
    }

    this.pending.clear();
  }
}
