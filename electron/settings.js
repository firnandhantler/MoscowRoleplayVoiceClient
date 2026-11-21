'use strict';

/**
 * Пользовательские настройки клиента.
 *
 * Хранятся в settings.json в папке данных приложения (не в папке установки,
 * чтобы обновление клиента не сбрасывало выбор устройств и клавиш).
 * Секретов здесь нет: только идентификаторы устройств, громкости и клавиши.
 */

const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_FILE_NAME = 'settings.json';
const MAX_ID_LENGTH = 256;

/** Клавиша-акселератор Electron: модификаторы и одна клавиша. */
const ACCELERATOR_PATTERN =
  /^((Control|Shift|Alt|Super)\+){0,3}([A-Z]|[0-9]|F([1-9]|1[0-9]|2[0-4]))$/;

const DEFAULTS = Object.freeze({
  audio: Object.freeze({
    inputDeviceId: '',
    outputDeviceId: '',
    inputGain: 1,
    outputVolume: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }),
  microphone: Object.freeze({
    mode: 'open',
    duckProximityWhileRadio: true,
  }),
  ptt: Object.freeze({
    radioKey: 'R',
    proximityKey: 'V',
  }),
  connection: Object.freeze({
    autoConnect: true,
  }),
});

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function readBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function readDeviceId(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.length <= MAX_ID_LENGTH ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function readAccelerator(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }

  return ACCELERATOR_PATTERN.test(value) ? value : fallback;
}

/**
 * Приводит произвольный объект к валидным настройкам.
 * Неизвестные поля отбрасываются, значения вне диапазона ограничиваются.
 *
 * @param {unknown} raw
 * @returns {object}
 */
function sanitizeSettings(raw) {
  const source = typeof raw === 'object' && raw !== null ? raw : {};
  const audio = typeof source.audio === 'object' && source.audio !== null ? source.audio : {};
  const microphone =
    typeof source.microphone === 'object' && source.microphone !== null ? source.microphone : {};
  const ptt = typeof source.ptt === 'object' && source.ptt !== null ? source.ptt : {};
  const connection =
    typeof source.connection === 'object' && source.connection !== null ? source.connection : {};

  return {
    audio: {
      inputDeviceId: readDeviceId(audio.inputDeviceId, DEFAULTS.audio.inputDeviceId),
      outputDeviceId: readDeviceId(audio.outputDeviceId, DEFAULTS.audio.outputDeviceId),
      inputGain: clampNumber(audio.inputGain, DEFAULTS.audio.inputGain, 0, 2),
      outputVolume: clampNumber(audio.outputVolume, DEFAULTS.audio.outputVolume, 0, 1),
      echoCancellation: readBoolean(audio.echoCancellation, DEFAULTS.audio.echoCancellation),
      noiseSuppression: readBoolean(audio.noiseSuppression, DEFAULTS.audio.noiseSuppression),
      autoGainControl: readBoolean(audio.autoGainControl, DEFAULTS.audio.autoGainControl),
    },
    microphone: {
      mode: microphone.mode === 'pushToTalk' ? 'pushToTalk' : 'open',
      duckProximityWhileRadio: readBoolean(
        microphone.duckProximityWhileRadio,
        DEFAULTS.microphone.duckProximityWhileRadio,
      ),
    },
    ptt: {
      radioKey: readAccelerator(ptt.radioKey, DEFAULTS.ptt.radioKey),
      proximityKey: readAccelerator(ptt.proximityKey, DEFAULTS.ptt.proximityKey),
    },
    connection: {
      autoConnect: readBoolean(connection.autoConnect, DEFAULTS.connection.autoConnect),
    },
  };
}

/**
 * Хранилище настроек с атомарной записью на диск.
 */
class SettingsStore {
  /**
   * @param {{userDataPath: string}} options
   */
  constructor({ userDataPath }) {
    this.filePath = path.join(userDataPath, SETTINGS_FILE_NAME);
    this.value = DEFAULTS;

    try {
      if (fs.existsSync(this.filePath)) {
        this.value = sanitizeSettings(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
      }
    } catch {
      // Повреждённый файл настроек не должен мешать запуску приложения.
      this.value = DEFAULTS;
    }
  }

  /** @returns {object} Копия текущих настроек. */
  get() {
    return JSON.parse(JSON.stringify(this.value));
  }

  /**
   * Применяет частичное обновление настроек и сохраняет результат.
   *
   * @param {unknown} patch
   * @returns {object} Новые настройки.
   */
  update(patch) {
    const current = this.get();
    const incoming = typeof patch === 'object' && patch !== null ? patch : {};
    const merged = {};

    for (const section of Object.keys(DEFAULTS)) {
      merged[section] = {
        ...(current[section] ?? {}),
        ...(typeof incoming[section] === 'object' && incoming[section] !== null
          ? incoming[section]
          : {}),
      };
    }

    this.value = sanitizeSettings(merged);
    this.#persist();

    return this.get();
  }

  /** Сбрасывает настройки к значениям по умолчанию. */
  reset() {
    this.value = DEFAULTS;
    this.#persist();

    return this.get();
  }

  #persist() {
    const temporaryPath = `${this.filePath}.tmp`;

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify(this.value, null, 2), 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
    } catch {
      // Ошибка записи не должна ломать работу: настройки останутся в памяти.
    }
  }
}

module.exports = { DEFAULTS, SETTINGS_FILE_NAME, SettingsStore, sanitizeSettings };
