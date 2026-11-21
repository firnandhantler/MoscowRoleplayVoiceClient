'use strict';

/**
 * Авторизация клиента через Discord OAuth2 в системном браузере.
 *
 * Схема:
 * 1. Главный процесс поднимает временный HTTP-сервер на 127.0.0.1 (loopback).
 * 2. В системном браузере открывается `/auth/discord/start` с адресом возврата
 *    и challenge — SHA-256 от случайного verifier'а.
 * 3. Пользователь входит в Discord; сервер проверяет код, ER:LC Россия и Roblox,
 *    затем перенаправляет браузер на loopback-адрес с одноразовым кодом.
 * 4. Клиент обменивает код и verifier на токен сессии и сохраняет его только
 *    в главном процессе (и в изолированной cookie-сессии для восстановления).
 *
 * Renderer не получает ни токен, ни cookie, ни verifier.
 */

const { createHash, randomBytes } = require('node:crypto');
const http = require('node:http');
const { session, shell } = require('electron');
const { requestJson, readServerError } = require('./http');

const SESSION_COOKIE_NAME = 'mrv_session';
const AUTH_PARTITION = 'persist:mrv-auth';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const COOKIE_LOOKUP_ATTEMPTS = 6;
const COOKIE_LOOKUP_DELAY_MS = 200;

/** Путь возврата. Совпадает с проверкой на сервере. */
const CALLBACK_PATH = '/mrv-auth/callback';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Сообщения об ошибках, которые сервер передаёт в адресе возврата.
 * Неизвестный код не раскрывается пользователю.
 */
const HANDOFF_ERROR_MESSAGES = {
  oauth_access_denied: 'Вход через Discord был отменён. Попробуйте снова.',
  oauth_error: 'Discord вернул ошибку входа. Попробуйте снова.',
  oauth_state_mismatch: 'Проверка безопасности входа не пройдена. Начните вход заново.',
  oauth_state_expired: 'Срок действия попытки входа истёк. Начните вход заново.',
  oauth_missing_code: 'Discord не передал код авторизации. Начните вход заново.',
  invalid_handoff: 'Клиент передал некорректные параметры входа. Обновите приложение.',
  handoff_disabled: 'Сервер не поддерживает вход через системный браузер. Обновите сервер.',
  auth_disabled: 'На сервере не настроена авторизация через Discord.',
};

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

/**
 * Страница, которую видит пользователь в браузере после возврата в клиент.
 * Без внешних ресурсов и пользовательских данных.
 *
 * @param {boolean} ok
 * @returns {string}
 */
function resultPage(ok) {
  const title = ok ? 'Вход выполнен' : 'Вход не завершён';

  return [
    '<!doctype html>',
    '<html lang="ru">',
    '<head><meta charset="utf-8"><title>',
    title,
    '</title></head>',
    '<body style="font-family:Segoe UI,Arial,sans-serif;background:#0b1118;color:#e6edf5;padding:48px">',
    '<h1>',
    title,
    '</h1>',
    '<p>',
    ok
      ? 'Вернитесь в приложение MoscowRoleplay Voice — оно уже завершает вход.'
      : 'Вернитесь в приложение MoscowRoleplay Voice и попробуйте войти снова.',
    '</p>',
    '</body>',
    '</html>',
  ].join('');
}

/**
 * Отвечает в браузер простой страницей.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {boolean} ok
 */
function sendBrowserPage(res, statusCode, ok) {
  const body = Buffer.from(resultPage(ok), 'utf8');

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', body.byteLength);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(body);
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
    /** Пометка о выполняющемся входе, чтобы не открыть два браузера. */
    this.loginInProgress = false;
    /** @type {import('node:http').Server|null} */
    this.callbackServer = null;
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
        await this.#refreshAuthEnabled();
        this.#clear();
      } else {
        await this.#applyToken(token);
      }
    } catch (err) {
      this.lastError = {
        code: err?.code ?? 'auth_restore_failed',
        message: err instanceof Error ? err.message : 'Не удалось проверить сессию.',
      };
      this.#clear();
    }

    // Сообщаем renderer'у итоговый статус: окно могло загрузиться раньше,
    // чем завершилась проверка /auth/session.
    this.#emit();

    return this.getStatus();
  }

  /**
   * Узнаёт у сервера, включена ли авторизация, даже если cookie ещё нет.
   *
   * @returns {Promise<void>}
   */
  async #refreshAuthEnabled() {
    const response = await requestJson(`${this.config.serverUrl}/auth/session`, {
      timeoutMs: 10_000,
    });

    if (response.status !== 200 || typeof response.data !== 'object' || response.data === null) {
      const error = readServerError(response, 'Сервер не подтвердил сессию.');
      throw new AuthError(error.message, error.code);
    }

    this.authEnabled = response.data.authEnabled === true;
    this.lastError =
      this.authEnabled === false
        ? {
            code: 'auth_disabled',
            message: 'На сервере не настроена авторизация через Discord.',
          }
        : null;
  }

  /**
   * Открывает вход в системном браузере и дожидается возврата сессии.
   *
   * @param {Electron.BrowserWindow|null} parentWindow Не используется: вход идёт
   *   во внешнем браузере. Параметр сохранён для совместимости IPC-вызова.
   * @returns {Promise<object>} Статус авторизации.
   */
  async login(parentWindow = null) {
    void parentWindow;

    if (this.loginInProgress) {
      throw new AuthError('Вход уже выполняется в браузере.', 'login_in_progress');
    }

    // Проверяем сервер до открытия браузера: иначе пользователь увидит
    // ERR_CONNECTION_REFUSED или страницу с JSON вместо понятной ошибки.
    if (this.authEnabled !== true) {
      await this.#refreshAuthEnabled();
    }

    if (this.authEnabled === false) {
      throw new AuthError('На сервере не настроена авторизация через Discord.', 'auth_disabled');
    }

    this.loginInProgress = true;

    try {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier, 'utf8').digest('hex');

      const { redirectUri, callback } = await this.#startCallbackServer();

      const startUrl = new URL(`${this.config.serverUrl}/auth/discord/start`);
      startUrl.searchParams.set('redirect_uri', redirectUri);
      startUrl.searchParams.set('challenge', challenge);

      const result = await this.#waitForLogin(callback, startUrl.toString());

      const token = await this.#exchangeCode(result.code, verifier);

      await this.#applyToken(token);
      await this.#storeSessionCookie(token);
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
      this.loginInProgress = false;
      await this.#stopCallbackServer();
    }
  }

  /**
   * Поднимает временный loopback-сервер, который принимает код возврата.
   *
   * @returns {Promise<{
   *   redirectUri: string,
   *   callback: {promise: Promise<{code: string}>, cancel: () => void},
   * }>}
   */
  #startCallbackServer() {
    return new Promise((resolve, reject) => {
      /** @type {(value: {code: string}) => void} */
      let resolveResult;
      /** @type {(reason: Error) => void} */
      let rejectResult;
      let settled = false;

      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolveResult = resolvePromise;
        rejectResult = rejectPromise;
      });

      const finish = (fn, value) => {
        if (settled) {
          return;
        }

        settled = true;
        fn(value);
      };

      const server = http.createServer((req, res) => {
        // Защита от DNS-rebinding: только собственный адрес и порт.
        const address = server.address();
        const expectedHost =
          address !== null && typeof address === 'object'
            ? `127.0.0.1:${address.port}`
            : null;

        if (expectedHost === null || req.headers.host !== expectedHost) {
          res.statusCode = 421;
          res.end();
          return;
        }

        let url;

        try {
          url = new URL(req.url ?? '/', 'http://127.0.0.1');
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }

        if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
          res.statusCode = 404;
          res.end();
          return;
        }

        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (typeof error === 'string' && error !== '') {
          sendBrowserPage(res, 400, false);
          finish(
            rejectResult,
            new AuthError(
              HANDOFF_ERROR_MESSAGES[error] ?? 'Вход через Discord не был завершён.',
              error,
            ),
          );
          return;
        }

        if (typeof code !== 'string' || !TOKEN_PATTERN.test(code)) {
          sendBrowserPage(res, 400, false);
          finish(
            rejectResult,
            new AuthError('Сервер вернул некорректный код входа.', 'login_invalid_code'),
          );
          return;
        }

        sendBrowserPage(res, 200, true);
        finish(resolveResult, { code });
      });

      server.once('error', (err) => {
        reject(
          new AuthError(
            `Не удалось поднять локальный адрес для входа: ${err.message}`,
            'login_loopback_failed',
          ),
        );
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();

        if (address === null || typeof address !== 'object') {
          server.close();
          reject(new AuthError('Не удалось определить локальный адрес для входа.', 'login_loopback_failed'));
          return;
        }

        this.callbackServer = server;

        resolve({
          redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
          callback: {
            promise,
            cancel: () => {
              finish(rejectResult, new AuthError('Вход отменён.', 'login_cancelled'));
            },
          },
        });
      });
    });
  }

  /**
   * Закрывает временный loopback-сервер.
   *
   * @returns {Promise<void>}
   */
  #stopCallbackServer() {
    const server = this.callbackServer;

    this.callbackServer = null;

    if (server === null) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });

      server.closeAllConnections?.();
    });
  }

  /**
   * Открывает браузер и ждёт код возврата.
   *
   * @param {{promise: Promise<{code: string}>, cancel: () => void}} callback
   * @param {string} startUrl
   * @returns {Promise<{code: string}>}
   */
  async #waitForLogin(callback, startUrl) {
    /** @type {NodeJS.Timeout|undefined} */
    let timer;

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new AuthError('Время ожидания входа истекло. Попробуйте снова.', 'login_timeout'),
        );
      }, LOGIN_TIMEOUT_MS);

      timer.unref?.();
    });

    try {
      await shell.openExternal(startUrl, { activate: true });

      return await Promise.race([callback.promise, timeout]);
    } catch (err) {
      callback.cancel();
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Обменивает одноразовый код и verifier на токен сессии.
   *
   * @param {string} code
   * @param {string} verifier
   * @returns {Promise<string>}
   */
  async #exchangeCode(code, verifier) {
    const url = new URL(`${this.config.serverUrl}/auth/handoff/exchange`);
    url.searchParams.set('code', code);
    url.searchParams.set('verifier', verifier);

    let response;

    try {
      response = await requestJson(url.toString(), { method: 'POST', timeoutMs: 15_000 });
    } catch (err) {
      throw new AuthError(
        err instanceof Error ? err.message : 'Не удалось завершить вход на сервере.',
        'handoff_exchange_failed',
      );
    }

    if (response.status !== 200 || typeof response.data !== 'object' || response.data === null) {
      const error = readServerError(response, 'Не удалось завершить вход на сервере.');
      throw new AuthError(error.message, error.code);
    }

    const token = response.data.token;

    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw new AuthError('Сервер не выдал токен сессии. Попробуйте снова.', 'handoff_invalid_token');
    }

    return token;
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

      if (typeof value === 'string' && TOKEN_PATTERN.test(value)) {
        return value;
      }

      if (attempt < COOKIE_LOOKUP_ATTEMPTS - 1) {
        await delay(COOKIE_LOOKUP_DELAY_MS);
      }
    }

    return null;
  }

  /**
   * Сохраняет токен в изолированную cookie-сессию, чтобы вход пережил перезапуск.
   *
   * @param {string} token
   * @returns {Promise<void>}
   */
  async #storeSessionCookie(token) {
    try {
      await this.authSession.cookies.set({
        url: this.config.serverUrl,
        name: SESSION_COOKIE_NAME,
        value: token,
        path: '/',
        httpOnly: true,
        secure: this.config.serverUrl.startsWith('https:'),
        sameSite: 'lax',
      });
    } catch {
      // Cookie нужна только для восстановления после перезапуска:
      // текущая сессия уже работает через заголовок Authorization.
    }
  }

  /**
   * Проверяет токен на сервере и сохраняет данные пользователя.
   *
   * @param {string} token
   * @returns {Promise<void>}
   */
  async #applyToken(token) {
    const response = await requestJson(`${this.config.serverUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
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
          headers: { Authorization: `Bearer ${token}` },
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
   * Повторно проверяет привязку Roblox через ER:LC Россия.
   *
   * @returns {Promise<object>}
   */
  async relink() {
    if (this.token === null) {
      throw new AuthError('Сначала войдите в систему.', 'not_authenticated');
    }

    const response = await requestJson(`${this.config.serverUrl}/auth/roblox/relink`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
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

module.exports = { AuthManager, AuthError, AUTH_PARTITION, SESSION_COOKIE_NAME };
