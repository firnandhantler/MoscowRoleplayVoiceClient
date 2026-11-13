/**
 * Список аудиоустройств Windows, доступных Electron и WebRTC.
 *
 * Названия устройств появляются только после выдачи разрешения на микрофон:
 * до этого Chromium возвращает пустые label, и в интерфейсе используются
 * нейтральные подписи.
 */

/**
 * @param {MediaDeviceInfo[]} devices
 * @param {'audioinput'|'audiooutput'} kind
 * @param {string} fallbackPrefix
 * @returns {{deviceId: string, label: string}[]}
 */
function collect(devices, kind, fallbackPrefix) {
  return devices
    .filter((device) => device.kind === kind)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label:
        typeof device.label === 'string' && device.label.trim() !== ''
          ? device.label
          : `${fallbackPrefix} ${index + 1}`,
    }));
}

/**
 * Возвращает доступные устройства ввода и вывода.
 *
 * @returns {Promise<{inputs: {deviceId: string, label: string}[], outputs: {deviceId: string, label: string}[]}>}
 */
export async function listAudioDevices() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    return { inputs: [], outputs: [] };
  }

  const devices = await navigator.mediaDevices.enumerateDevices();

  return {
    inputs: collect(devices, 'audioinput', 'Микрофон'),
    outputs: collect(devices, 'audiooutput', 'Устройство вывода'),
  };
}

/**
 * Подписывается на изменение состава устройств.
 *
 * @param {() => void} handler
 * @returns {() => void}
 */
export function onDevicesChanged(handler) {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.addEventListener !== 'function') {
    return () => {};
  }

  const listener = () => {
    handler();
  };

  navigator.mediaDevices.addEventListener('devicechange', listener);

  return () => {
    navigator.mediaDevices.removeEventListener('devicechange', listener);
  };
}
