'use strict';

/**
 * Конфигурация клиента.
 *
 * Источники (в порядке приоритета):
 * 1. переменные окружения MVR_SERVER_URL и MVR_WS_PATH;
 * 2. client-config.json в папке пользовательских данных приложения;
 * 3. client-config.json рядом с ресурсами приложения (для сборки);
 * 4. значения по умолчанию (локальный сервер разработки).
 *
 * В файле конфигурации нет секретов: только адрес сервера. Токены и ключи
 * в клиент не попадают и хранятся только на сервере.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE_NAME = 'client-config.json';
const DEFAULT_SERVER_URL = 'http://localhost:3000';
const DEFAULT_WS_PATH = '/ws';

/**
 * Разбирает и нормализует адрес сервера.
 *
 * @param {unknown} raw
 * @returns {string|null} Нормализованный URL без завершающего слэша.
 */
function parseServerUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  let url;

  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  if (url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') {
    return null;
  }

  return url.origin + url.pathname.replace(/\/+$/, '');
}

/**
 * Проверяет путь WebSocket.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function parseWsPath(raw) {
  if (typeof raw !== 'string') {
    return null;
  }

  const value = raw.trim();

  if (!value.startsWith('/') || /\s/.test(value) || /[?#]/.test(value) || value.length > 128) {
    return null;
  }

  return value;
}

/**
 * Читает JSON-файл, не бросая исключение наружу.
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Собирает адреса для HTTP и WebSocket.
 *
 * @param {string} serverUrl
 * @param {string} wsPath
 * @returns {{httpOrigin: string, wsUrl: string}}
 */
function buildEndpoints(serverUrl, wsPath) {
  const url = new URL(serverUrl);
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${wsPath}`;

  return { httpOrigin: serverUrl, wsUrl };
}

/**
 * Загружает конфигурацию клиента.
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   userDataPath?: string|null,
 *   resourcesPath?: string|null,
 *   appPath?: string|null,
 * }} options
 * @returns {{
 *   serverUrl: string,
 *   wsPath: string,
 *   wsUrl: string,
 *   source: string,
 *   warnings: string[],
 * }}
 */
function loadClientConfig({
  env = process.env,
  userDataPath = null,
  resourcesPath = null,
  appPath = null,
} = {}) {
  const warnings = [];
  const candidates = [];

  if (userDataPath) {
    candidates.push({ file: path.join(userDataPath, CONFIG_FILE_NAME), source: 'userData' });
  }

  if (resourcesPath) {
    candidates.push({ file: path.join(resourcesPath, CONFIG_FILE_NAME), source: 'resources' });
  }

  if (appPath) {
    candidates.push({ file: path.join(appPath, CONFIG_FILE_NAME), source: 'app' });
  }

  let fileConfig = null;
  let source = 'default';

  for (const candidate of candidates) {
    const parsed = readJsonFile(candidate.file);

    if (parsed !== null) {
      fileConfig = parsed;
      source = candidate.source;
      break;
    }
  }

  if (fileConfig !== null && typeof fileConfig.serverUrl === 'string') {
    const fromFile = parseServerUrl(fileConfig.serverUrl);

    if (fromFile === null) {
      warnings.push(
        'В client-config.json указан некорректный serverUrl. Использован адрес по умолчанию.',
      );
      source = 'default';
    }
  }

  const envServerUrl = parseServerUrl(env.MVR_SERVER_URL);
  const fileServerUrl = fileConfig === null ? null : parseServerUrl(fileConfig.serverUrl);

  const serverUrl = envServerUrl ?? fileServerUrl ?? DEFAULT_SERVER_URL;

  if (envServerUrl !== null) {
    source = 'env';
  } else if (fileServerUrl === null) {
    source = 'default';
  }

  const envWsPath = parseWsPath(env.MVR_WS_PATH);
  const fileWsPath = fileConfig === null ? null : parseWsPath(fileConfig.wsPath);
  const wsPath = envWsPath ?? fileWsPath ?? DEFAULT_WS_PATH;

  const { httpOrigin, wsUrl } = buildEndpoints(serverUrl, wsPath);

  return {
    serverUrl: httpOrigin,
    wsPath,
    wsUrl,
    source,
    warnings,
  };
}

module.exports = {
  CONFIG_FILE_NAME,
  DEFAULT_SERVER_URL,
  DEFAULT_WS_PATH,
  loadClientConfig,
  parseServerUrl,
  parseWsPath,
};
