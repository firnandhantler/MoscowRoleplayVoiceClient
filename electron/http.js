'use strict';

/**
 * Минимальный HTTP-клиент для обращения к серверу MoscowRoleplay Voice
 * из главного процесса Electron.
 *
 * Используется именно `node:http`/`node:https`, а не `fetch`, потому что
 * сервер ожидает HttpOnly-cookie сессии в заголовке Cookie. Браузерный fetch
 * запрещает вручную задавать этот заголовок, а главный процесс — нет.
 */

const http = require('node:http');
const https = require('node:https');

const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Приводит сетевую ошибку к понятному русскому сообщению.
 *
 * @param {NodeJS.ErrnoException} err
 * @returns {Error & {code: string}}
 */
function toNetworkError(err) {
  const code = typeof err?.code === 'string' ? err.code : 'network_error';

  const messages = {
    ENOTFOUND: 'Сервер не найден. Проверьте адрес в client-config.json.',
    ECONNREFUSED: 'Сервер отклонил подключение. Возможно, он не запущен.',
    ECONNRESET: 'Соединение с сервером было сброшено.',
    ETIMEDOUT: 'Превышено время ожидания ответа сервера.',
    CERT_HAS_EXPIRED: 'Сертификат сервера просрочен.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Сервер использует самоподписанный сертификат.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Не удалось проверить сертификат сервера.',
  };

  const error = new Error(messages[code] ?? 'Не удалось связаться с сервером.');
  error.code = code;
  return error;
}

/**
 * Выполняет HTTP-запрос и разбирает JSON-ответ.
 *
 * @param {string} urlString
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: unknown,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{status: number, headers: Record<string, string|string[]|undefined>, data: unknown}>}
 */
function requestJson(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;

    try {
      url = new URL(urlString);
    } catch {
      reject(new Error('Некорректный адрес сервера в конфигурации клиента.'));
      return;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error('Сервер должен использовать протокол http или https.'));
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const payload =
      body === null || body === undefined
        ? null
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

    const request = transport.request(
      {
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'MoscowRoleplayVoice-Client',
          ...(payload === null
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (response) => {
        let size = 0;
        const chunks = [];

        response.on('data', (chunk) => {
          size += chunk.length;

          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Ответ сервера превышает допустимый размер.'));
            return;
          }

          chunks.push(chunk);
        });

        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;

          if (text !== '') {
            try {
              data = JSON.parse(text);
            } catch {
              data = null;
            }
          }

          resolve({ status: response.statusCode ?? 0, headers: response.headers, data });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Превышено время ожидания ответа сервера.'));
    });

    request.on('error', (err) => {
      reject(err instanceof Error && !err.code ? err : toNetworkError(err));
    });

    if (payload !== null) {
      request.write(payload);
    }

    request.end();
  });
}

/**
 * Извлекает сообщение об ошибке из ответа сервера.
 *
 * @param {{status: number, data: unknown}} response
 * @param {string} fallback
 * @returns {{code: string, message: string, status: number}}
 */
function readServerError(response, fallback) {
  const data = response.data;
  const error = data && typeof data === 'object' ? data.error : null;

  return {
    code: typeof error?.code === 'string' ? error.code : 'server_error',
    message: typeof error?.message === 'string' && error.message !== '' ? error.message : fallback,
    status: response.status,
  };
}

module.exports = { requestJson, readServerError };
