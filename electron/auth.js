'use strict';

/**
 * Авторизация клиента через Discord OAuth2.
 *
 * Схема:
 * 1. В отдельном окне открывается `/auth/discord/start` на сервере.
 * 2. Пользователь входит в Discord; сервер проверяет код, Bloxlink и Roblox,
 *    после чего выставляет HttpOnly-cookie сессии `mrv_session`.
 * 3. Главный процесс читает cookie из изолированной сессии Electron
 *    (renderer её прочитать не может) и запрашивает `/auth/session`.
 * 4. Токен остаётся в главном процессе и передаётся только WebSocket-клиенту.
 *
 * Renderer не получает ни токен, ни cookie.
 */

const { BrowserWindow, session } = require('electron');
const { requestJson, readServerError } = require('./http');

const SESSION_COOKIE_NAME = 'mrv_session';
const AUTH_PARTITION = 'persist:mrv-auth';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const COOKIE_LOOKUP_ATTEMPTS = 6;
const COOKIE_LOOKUP_DELAY_MS = 200;

/**
 * Проверяет, разрешена ли навигация в окне входа.
 * Разрешены только страницы сервера и домены Discord.
 *
 * @param {string} urlString
 * @param {string} serverOrigin
 * @returns {boolean}
 */
function isAllowedAuthUrl(urlString, serverOrigin) {
  if (urlString === 'about:blank') {
    return true;
  }

  let url;

  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false;
  }

  if (url.origin === new URL(serverOrigin).origin) {
    return true;
  }

  const host = url.hostname.toLowerCase();

  return (
    url.protocol === 'https:' &&
    (host === 'discord.com' ||
      host.endsWith('.discord.com') ||
      host.endsWith('.discordapp.com') ||
      host.endsWith('.discordapp.net'))
  );
}

/**
 * Ждёт заданное время.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Ошибка авторизации с машиночитаемым кодом.
 */
class AuthError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

class AuthManager {
  /**
   * @param {{config: {serverUrl: string}, onChanged?: ((status: object) => void)|null}} options
   */
  constructor({ config, onChanged = null }) {
    this.config = config;
    this.onChanged = onChanged;
    this.authSession = session.fromPartition(AUTH_PARTITION);
    this.token = null;
    this.user = null;
    this.expiresAt = null;
    this.authEnabled = null;
    this.lastError = null;
    this.loginWindow = null;

    // Окно входа не нуждается ни в каких разрешениях браузера.
    this.authSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });

    this.authSession.setPermissionCheckHandler(() => false);
  }

  /** @returns {object} */
  getStatus() {
    return {
      authenticated: this.token !== null && this.user !== null,
      user: this.user,
      expiresAt: this.expiresAt,
      authEnabled: this.authEnabled,
      serverUrl: this.config.serverUrl,
      error: this.lastError,
    };
  }

  /** @returns {string|null} Токен сессии (только для WebSocket-клиента). */
  getToken() {
    return this.token;
  }

  /**
   * Восстанавливает сессию при запуске: если cookie ещё жива, повторный вход не нужен.
   *
   * @returns {Promise<object>} Статус авторизации.
   */
  async restore() {
    try {
      const token = await this.#readSessionCookie();

      if (token === null) {
        this.#clear();
        return this.getStatus();
      }

      await this.#applyToken(token);
    } catch (err) {
      this.lastError = {
        code: err?.code ?? 'auth_restore_failed',
        message: err instanceof Error ? err.message : 'Не удалось проверить сессию.',
      };
      this.#clear();
    }

    return this.getStatus();
  }

  /**
   * Открывает окно входа и дожидается сессии.
   *
   * @param {BrowserWindow|null} parentWindow
   * @returns {Promise<object>} Статус авторизации.
   */
  async login(parentWindow = null) {
    if (this.loginWindow !== null) {
      throw new AuthError('Окно входа уже открыто.', 'login_in_progress');
    }

    const serverOrigin = new URL(this.config.serverUrl).origin;

    const window = new BrowserWindow({
      width: 520,
      height: 720,
      minWidth: 420,
      minHeight: 560,
      parent: parentWindow ?? undefined,
      modal: parentWindow !== null,
      show: true,
      title: 'Вход через Discord',
      backgroundColor: '#0b1118',
      autoHideMenuBar: true,
      webPreferences: {
        partition: AUTH_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        webSecurity: true,
        webviewTag: false,
      },
    });

    this.loginWindow = window;
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedAuthUrl(url, serverOrigin)) {
        event.preventDefault();
      }
    });

    try {
      const token = await this.#waitForCallback(window, serverOrigin);

      await window.close();
      await this.#applyToken(token);
      this.lastError = null;
      this.#emit();

      return this.getStatus();
    } catch (err) {
      this.lastError = {
        code: err?.code ?? 'login_failed',
        message: err instanceof Error ? err.message : 'Не удалось выполнить вход.',
      };
      this.#emit();
      throw err;
    } finally {
      this.loginWindow = null;

      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
  }

  /**
   * Открывает страницу входа и ждёт, пока сервер выставит cookie сессии.
   *
   * @param {BrowserWindow} window
   * @param {string} serverOrigin
   * @returns {Promise<string>} Токен сессии.
   */
  #waitForCallback(window, serverOrigin) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (fn, value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        window.webContents.off('did-finish-load', onLoad);
        window.off('closed', onClosed);
        fn(value);
      };

      const timer = setTimeout(() => {
        finish(reject, new AuthError('Время ожидания входа истекло. Попробуйте снова.', 'login_timeout'));
      }, LOGIN_TIMEOUT_MS);

      timer.unref?.();

      const onClosed = () => {
        finish(reject, new AuthError('Окно входа закрыто. Попробуйте снова.', 'login_cancelled'));
      };

      const onLoad = async () => {
        const currentUrl = window.webContents.getURL();
        let parsed;

        try {
          parsed = new URL(currentUrl);
        } catch {
          return;
        }

        if (parsed.origin !== serverOrigin || parsed.pathname !== '/auth/discord/callback') {
          return;
        }

        const token = await this.#readSessionCookie();

        if (token !== null) {
          finish(resolve, token);
          return;
        }

        // Cookie не появилась: сервер вернул ошибку входа текстом JSON.
        const message = await this.#readPageError(window);
        finish(reject, new AuthError(message ?? 'Сервер не подтвердил вход. Попробуйте снова.', 'login_rejected'));
      };

      window.on('closed', onClosed);
      window.webContents.on('did-finish-load', () => {
        void onLoad();
      });

      void window.loadURL(`${this.config.serverUrl}/auth/discord/start`).catch((err) => {
        finish(reject, new AuthError(`Не удалось открыть страницу входа: ${err.message}`, 'login_open_failed'));
      });
    });
  }

  /**
   * Пытается прочитать сообщение об ошибке со страницы ответа сервера.
   *
   * @param {BrowserWindow} window
   * @returns {Promise<string|null>}
   */
  async #readPageError(window) {
    try {
      const text = await window.webContents.executeJavaScript(
        'document.body ? document.body.innerText : ""',
        true,
      );

      if (typeof text !== 'string' || text.length === 0 || text.length > 4096) {
        return null;
      }

      const parsed = JSON.parse(text);

      if (parsed && typeof parsed.error?.message === 'string') {
        return parsed.error.message;
      }
    } catch {
      // Страница могла быть уже закрыта — используем общее сообщение.
    }

    return null;
  }

  /**
   * Читает HttpOnly-cookie сессии из изолированной сессии Electron.
   * Несколько попыток нужны, потому что cookie может записываться асинхронно.
   *
   * @returns {Promise<string|null>}
   */
  async #readSessionCookie() {
    for (let attempt = 0; attempt < COOKIE_LOOKUP_ATTEMPTS; attempt += 1) {
      const cookies = await this.authSession.cookies.get({
        url: this.config.serverUrl,
        name: SESSION_COOKIE_NAME,
      });

      const value = cookies[0]?.value;

      if (typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)) {
        return value;
      }

      if (attempt < COOKIE_LOOKUP_ATTEMPTS - 1) {
        await delay(COOKIE_LOOKUP_DELAY_MS);
      }
    }

    return null;
  }

  /**
   * Проверяет токен на сервере и сохраняет данные пользователя.
   *
   * @param {string} token
   * @returns {Promise<void>}
   */
  async #applyToken(token) {
    const response = await requestJson(`${this.config.serverUrl}/auth/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      timeoutMs: 10_000,
    });

    if (response.status !== 200 || typeof response.data !== 'object' || response.data === null) {
      const error = readServerError(response, 'Сервер не подтвердил сессию.');
      throw new AuthError(error.message, error.code);
    }

    this.authEnabled = response.data.authEnabled === true;

    if (response.data.authenticated !== true) {
      throw new AuthError(
        this.authEnabled === false
          ? 'На сервере не настроена авторизация через Discord.'
          : 'Сессия недействительна. Войдите заново.',
        'not_authenticated',
      );
    }

    this.token = token;
    this.user = response.data.user ?? null;
    this.expiresAt = typeof response.data.expiresAt === 'string' ? response.data.expiresAt : null;
    this.lastError = null;
  }

  /**
   * Завершает сессию на сервере и локально.
   *
   * @returns {Promise<object>}
   */
  async logout() {
    const token = this.token;

    this.#clear();

    if (token !== null) {
      try {
        await requestJson(`${this.config.serverUrl}/auth/logout`, {
          method: 'POST',
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
          timeoutMs: 10_000,
        });
      } catch {
        // Сессия уже удалена локально: ошибка сети не должна мешать выходу.
      }
    }

    try {
      await this.authSession.cookies.remove(this.config.serverUrl, SESSION_COOKIE_NAME);
    } catch {
      // Cookie могла отсутствовать.
    }

    this.#emit();

    return this.getStatus();
  }

  /**
   * Повторно проверяет привязку Roblox через Bloxlink.
   *
   * @returns {Promise<object>}
   */
  async relink() {
    if (this.token === null) {
      throw new AuthError('Сначала войдите в систему.', 'not_authenticated');
    }

    const response = await requestJson(`${this.config.serverUrl}/auth/roblox/relink`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${this.token}` },
      timeoutMs: 15_000,
    });

    if (response.status !== 200) {
      const error = readServerError(response, 'Не удалось проверить привязку Roblox.');
      throw new AuthError(error.message, error.code);
    }

    const data = response.data;

    if (data && typeof data === 'object' && data.user) {
      this.user = data.user;
    }

    this.#emit();

    return { status: this.getStatus(), linkStatus: data?.linkStatus ?? 'unknown' };
  }

  /** Очищает локальное состояние сессии. */
  #clear() {
    this.token = null;
    this.user = null;
    this.expiresAt = null;
  }

  /** Сообщает об изменении авторизации. */
  #emit() {
    this.onChanged?.(this.getStatus());
  }
}

module.exports = { AuthManager, AuthError, AUTH_PARTITION, SESSION_COOKIE_NAME, isAllowedAuthUrl };
