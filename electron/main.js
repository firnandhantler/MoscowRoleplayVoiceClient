'use strict';

/**
 * Главный процесс MoscowRoleplay Voice.
 *
 * Здесь находятся только инфраструктурные задачи:
 * - окно приложения и его безопасные настройки;
 * - вход через Discord и хранение токена сессии (renderer токена не получает);
 * - WebSocket-соединение с сервером и автопереподключение;
 * - пользовательские настройки и глобальные клавиши;
 * - IPC-интерфейс с жёстким whitelist действий.
 *
 * Голос (mediasoup-client, Web Audio) работает в renderer — там есть WebRTC
 * и доступ к микрофону.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const { loadClientConfig } = require('./config');
const { AuthManager } = require('./auth');
const { SettingsStore } = require('./settings');
const { SignalingClient, SignalingState } = require('./signaling');
const { ShortcutManager } = require('./shortcuts');

app.enableSandbox();
app.setName('MoscowRoleplay Voice');
app.setAppUserModelId('com.moscowroleplay.voice');

// Голосовой чат должен воспроизводиться без дополнительного клика:
// входящие потоки приходят в любой момент, в том числе когда окно свёрнуто.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const isDevelopment = !app.isPackaged;
const rendererEntryPath = path.join(__dirname, '..', 'renderer', 'index.html');
const rendererEntryUrl = pathToFileURL(rendererEntryPath).href;

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {AuthManager|null} */
let auth = null;
/** @type {SettingsStore|null} */
let settings = null;
/** @type {SignalingClient|null} */
let signaling = null;
/** @type {ShortcutManager|null} */
let shortcuts = null;
/** @type {ReturnType<typeof loadClientConfig>|null} */
let clientConfig = null;

/**
 * Проверяет, что IPC-запрос пришёл из локального renderer-файла приложения.
 *
 * @param {Electron.IpcMainInvokeEvent|Electron.IpcMainEvent} event
 * @returns {boolean}
 */
function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url ?? '';
  return senderUrl === rendererEntryUrl;
}

/**
 * Проверяет, что webContents принадлежит окну приложения.
 *
 * @param {Electron.WebContents|null} webContents
 * @returns {boolean}
 */
function isTrustedWebContents(webContents) {
  return webContents !== null && webContents !== undefined && webContents.getURL() === rendererEntryUrl;
}

/**
 * Безопасно отправляет событие в renderer.
 *
 * @param {string} channel
 * @param {unknown} payload
 */
function sendToRenderer(channel, payload) {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

/**
 * Обработчик IPC-вызова: проверяет источник и приводит ошибки к безопасному виду.
 *
 * @param {string} name
 * @param {(event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown} handler
 */
function handleIpc(name, handler) {
  ipcMain.handle(name, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error('Недоверенный источник IPC-запроса.');
    }

    try {
      return await handler(event, ...args);
    } catch (err) {
      const error = new Error(err instanceof Error ? err.message : 'Неизвестная ошибка.');
      error.code = typeof err?.code === 'string' ? err.code : 'internal_error';
      throw error;
    }
  });
}

/**
 * Создаёт главное окно.
 */
function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'MoscowRoleplay Voice',
    backgroundColor: '#0b1118',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: isDevelopment,
    },
  });

  mainWindow = window;

  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererEntryUrl) {
      event.preventDefault();
    }
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  void window.loadFile(rendererEntryPath);
}

/**
 * Разрешения браузера: только микрофон для собственного renderer-файла.
 */
function configurePermissions() {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== 'media' || !isTrustedWebContents(webContents)) {
      callback(false);
      return;
    }

    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];

    // Видео и захват экрана приложению не нужны.
    callback(mediaTypes.length === 0 || (mediaTypes.includes('audio') && !mediaTypes.includes('video')));
  });

  defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media' && isTrustedWebContents(webContents);
  });
}

/**
 * Применяет глобальную клавишу радиосвязи из настроек.
 *
 * @returns {{registered: boolean, error: {code: string, message: string}|null}}
 */
function applyShortcuts() {
  if (settings === null || shortcuts === null) {
    return { registered: false, error: null };
  }

  const ptt = settings.get().ptt;

  return shortcuts.apply({
    accelerator: ptt.radioKey,
    enabled: ptt.radioGlobal === true,
  });
}

/**
 * Регистрирует IPC-обработчики.
 */
function registerIpc() {
  handleIpc('app:get-info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    isPackaged: app.isPackaged,
  }));

  handleIpc('app:get-config', () => ({
    serverUrl: clientConfig.serverUrl,
    wsPath: clientConfig.wsPath,
    source: clientConfig.source,
    warnings: clientConfig.warnings,
  }));

  handleIpc('settings:get', () => settings.get());

  handleIpc('settings:update', (_event, patch) => {
    const updated = settings.update(patch);
    const shortcutResult = applyShortcuts();

    sendToRenderer('settings:changed', updated);

    return { settings: updated, shortcut: shortcutResult };
  });

  handleIpc('settings:reset', () => {
    const updated = settings.reset();
    const shortcutResult = applyShortcuts();

    sendToRenderer('settings:changed', updated);

    return { settings: updated, shortcut: shortcutResult };
  });

  handleIpc('shortcuts:apply', (_event, payload) => {
    if (settings !== null) {
      settings.update({ ptt: payload ?? {} });
    }

    return applyShortcuts();
  });

  handleIpc('auth:status', () => auth.getStatus());

  handleIpc('auth:login', async () => {
    const status = await auth.login(mainWindow);
    return status;
  });

  handleIpc('auth:logout', async () => {
    signaling?.disconnect();
    return auth.logout();
  });

  handleIpc('auth:relink', () => auth.relink());

  handleIpc('signal:status', () => signaling.getStatus());

  handleIpc('signal:connect', () => {
    if (!auth.getStatus().authenticated) {
      throw Object.assign(new Error('Сначала войдите через Discord.'), { code: 'not_authenticated' });
    }

    signaling.connect();

    return signaling.getStatus();
  });

  handleIpc('signal:disconnect', () => {
    signaling.disconnect();
    return signaling.getStatus();
  });

  handleIpc('signal:send', (_event, message) => {
    const result = signaling.send(message);

    if (!result.sent) {
      return { ok: false, reason: result.reason ?? 'not_connected' };
    }

    return { ok: true };
  });
}

/**
 * Создаёт AuthManager и SignalingClient и связывает их с окном.
 */
function createServices() {
  auth = new AuthManager({
    config: clientConfig,
    onChanged: (status) => {
      sendToRenderer('auth:changed', status);

      if (!status.authenticated) {
        signaling?.disconnect();
      }
    },
  });

  signaling = new SignalingClient({
    getWsUrl: () => clientConfig.wsUrl,
    getToken: () => auth.getToken(),
    refreshToken: async () => {
      const status = await auth.restore();
      return status.authenticated === true;
    },
    onState: (state) => {
      sendToRenderer('signal:state', state);
    },
    onMessage: (message) => {
      sendToRenderer('signal:message', message);
    },
  });
}

/**
 * Запускает приложение после готовности Electron.
 */
async function bootstrap() {
  clientConfig = loadClientConfig({
    env: process.env,
    userDataPath: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });

  settings = new SettingsStore({ userDataPath: app.getPath('userData') });
  shortcuts = new ShortcutManager({
    onTrigger: () => {
      // Когда окно активно, удержание клавиши обрабатывает renderer
      // (keydown/keyup). Глобальный переключатель нужен только в фоне,
      // иначе одно нажатие сработало бы дважды.
      if (mainWindow !== null && mainWindow.isFocused()) {
        return;
      }

      sendToRenderer('shortcut:trigger', {});
    },
  });

  createServices();
  configurePermissions();
  registerIpc();

  createWindow();

  // Глобальная клавиша регистрируется после появления окна: так пользователь
  // увидит предупреждение, если клавиша занята другим приложением.
  const shortcutResult = applyShortcuts();

  if (shortcutResult.error) {
    sendToRenderer('app:notice', shortcutResult.error);
  }

  const status = await auth.restore();

  if (!status.authenticated && status.authEnabled === null) {
    // Сервер недоступен: сообщим об этом после загрузки интерфейса.
    sendToRenderer('auth:changed', status);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

// Один экземпляр клиента: второй заменил бы первую сессию на сервере.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((err) => {
    // Ошибка запуска не должна оставаться незамеченной.
    console.error('Не удалось запустить клиент:', err instanceof Error ? err.message : err);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  signaling?.dispose();
  shortcuts?.dispose();
});

process.on('uncaughtException', (err) => {
  console.error('Необработанная ошибка главного процесса:', err instanceof Error ? err.message : err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Необработанный отказ Promise:', reason instanceof Error ? reason.message : reason);
});

module.exports = { SignalingState };
