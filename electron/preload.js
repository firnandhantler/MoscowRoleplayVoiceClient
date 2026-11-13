'use strict';

/**
 * Безопасный мост между renderer и главным процессом.
 *
 * Renderer не получает ни `require`, ни `ipcRenderer`, ни доступ к файловой
 * системе. Наружу отдаётся только перечисленный ниже whitelist действий,
 * каждое из которых проверяется в главном процессе.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Подписывается на событие главного процесса и возвращает функцию отписки.
 *
 * @param {string} channel
 * @param {(payload: unknown) => void} handler
 * @returns {() => void}
 */
function subscribe(channel, handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('Обработчик события должен быть функцией.');
  }

  const listener = (_event, payload) => {
    handler(payload);
  };

  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = Object.freeze({
  /** Сведения о приложении и версиях среды. */
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),

  /** Адрес сервера и путь WebSocket из client-config.json. */
  getConfig: () => ipcRenderer.invoke('app:get-config'),

  settings: Object.freeze({
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    reset: () => ipcRenderer.invoke('settings:reset'),
  }),

  auth: Object.freeze({
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    relink: () => ipcRenderer.invoke('auth:relink'),
  }),

  signaling: Object.freeze({
    connect: () => ipcRenderer.invoke('signal:connect'),
    disconnect: () => ipcRenderer.invoke('signal:disconnect'),
    send: (message) => ipcRenderer.invoke('signal:send', message),
    status: () => ipcRenderer.invoke('signal:status'),
  }),

  shortcuts: Object.freeze({
    apply: (payload) => ipcRenderer.invoke('shortcuts:apply', payload),
  }),

  events: Object.freeze({
    onAuthChanged: (handler) => subscribe('auth:changed', handler),
    onSignalState: (handler) => subscribe('signal:state', handler),
    onSignalMessage: (handler) => subscribe('signal:message', handler),
    onShortcutTrigger: (handler) => subscribe('shortcut:trigger', handler),
    onSettingsChanged: (handler) => subscribe('settings:changed', handler),
    onNotice: (handler) => subscribe('app:notice', handler),
  }),
});

contextBridge.exposeInMainWorld('moscowRoleplay', api);
