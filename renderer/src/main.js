/**
 * Точка входа renderer-процесса.
 *
 * Приложение собирает вместе:
 * - авторизацию (главный процесс);
 * - канал сигнализации (WebSocket в главном процессе);
 * - mediasoup-client и аудиодвижок;
 * - серверные состояния proximity и радио;
 * - интерфейс.
 *
 * Здесь нет бизнес-правил доступа: всё, что касается того, кто кого слышит и
 * кому можно говорить в радио, решает сервер.
 */

import { ServerMessageType } from './signaling/protocol.js';
import { SignalingChannel } from './signaling/channel.js';
import { AudioEngine } from './audio/audio-engine.js';
import { listAudioDevices, onDevicesChanged } from './audio/devices.js';
import { VoiceClient } from './mediasoup/voice-client.js';
import { ProximityController } from './proximity/proximity-controller.js';
import { RadioController } from './radio/radio-controller.js';
import { SettingsController } from './settings/settings-controller.js';
import { AppUi } from './ui/ui.js';

const LEVEL_UPDATE_MS = 120;
const VOICE_RECOVERY_DELAY_MS = 1_500;
const VOICE_RECOVERY_WINDOW_MS = 60_000;
const VOICE_RECOVERY_MAX_ATTEMPTS = 3;

const bridge = window.moscowRoleplay;

/** @type {AppUi} */
let ui;
/** @type {AudioEngine} */
let audio;
/** @type {VoiceClient} */
let voice;
/** @type {SignalingChannel} */
let signaling;
/** @type {ProximityController} */
let proximity;
/** @type {RadioController} */
let radio;
/** @type {SettingsController} */
let settings;

let currentUser = null;
let authenticatedPayload = null;
let muted = false;
let lastLevelUpdate = 0;
let levelTimer = null;
/** @type {object[]} */
let pendingConsumers = [];

/** Удерживается ли клавиша PTT близости прямо сейчас. */
let proximityPttHeld = false;
/** @type {number|null} */
let voiceRecoveryTimer = null;
let voiceRecoveryAttempts = 0;
let voiceRecoveryWindowStartedAt = 0;

/**
 * Показывает фатальную ошибку загрузки вместо интерфейса.
 *
 * @param {string} message
 */
function showFatal(message) {
  const container = document.createElement('div');
  container.className = 'login-card';

  const title = document.createElement('h1');
  title.textContent = 'Клиент не может запуститься';

  const text = document.createElement('p');
  text.className = 'muted';
  text.textContent = message;

  container.append(title, text);
  document.body.textContent = '';
  document.body.appendChild(container);
}

/**
 * @param {unknown} err
 * @param {string} fallback
 * @returns {string}
 */
function errorMessage(err, fallback) {
  if (err instanceof Error && typeof err.message === 'string' && err.message !== '') {
    return err.message;
  }

  return fallback;
}

/**
 * Показывает уведомление об ошибке и пишет её в консоль для диагностики.
 *
 * @param {string} message
 * @param {unknown} [detail]
 */
function reportError(message, detail = null) {
  ui?.toast(message, 'error');

  if (detail) {
    console.error(message, detail);
  }
}

/**
 * Применяет настройки к аудиодвижку.
 */
function applyAudioSettings() {
  const value = settings.get();

  if (!value) {
    return;
  }

  audio.setInputVolume(value.audio.inputGain);
  audio.setOutputVolume(value.audio.outputVolume);
  audio.setMicMode(value.microphone.mode);
  audio.setIncomingDucking(value.microphone.duckProximityWhileRadio);
  audio.setOutgoingDucking(value.microphone.duckProximityWhileRadio);

  // В режиме PTT микрофон открывается только пока клавиша действительно
  // удерживается. Это важно при смене настроек и перезапуске микрофона:
  // иначе после изменения громкости микрофон остался бы открытым.
  audio.setProximityPushToTalk(value.microphone.mode !== 'pushToTalk' || proximityPttHeld);
}

/**
 * Планирует восстановление голосового соединения после отказа WebRTC.
 *
 * Серия перезапусков ограничена, чтобы при постоянной сетевой ошибке клиент
 * не создавал бесконечный цикл транспортов.
 */
function scheduleVoiceRecovery() {
  if (authenticatedPayload === null || voiceRecoveryTimer !== null) {
    return;
  }

  const now = Date.now();

  if (now - voiceRecoveryWindowStartedAt > VOICE_RECOVERY_WINDOW_MS) {
    voiceRecoveryWindowStartedAt = now;
    voiceRecoveryAttempts = 0;
  }

  if (voiceRecoveryAttempts >= VOICE_RECOVERY_MAX_ATTEMPTS) {
    reportError(
      'Не удалось восстановить голосовое соединение. Переподключитесь к серверу вручную.',
    );
    return;
  }

  voiceRecoveryAttempts += 1;
  voiceRecoveryTimer = window.setTimeout(() => {
    voiceRecoveryTimer = null;

    if (authenticatedPayload === null) {
      return;
    }

    void restartVoice();
  }, VOICE_RECOVERY_DELAY_MS);
}

/** Отменяет запланированное восстановление. */
function cancelVoiceRecovery() {
  if (voiceRecoveryTimer !== null) {
    window.clearTimeout(voiceRecoveryTimer);
    voiceRecoveryTimer = null;
  }
}

/**
 * Запускает микрофон с текущими настройками.
 *
 * @returns {Promise<boolean>} true, если микрофон доступен.
 */
async function startMicrophone() {
  const value = settings.get();

  try {
    await audio.start({
      deviceId: value.audio.inputDeviceId,
      echoCancellation: value.audio.echoCancellation,
      noiseSuppression: value.audio.noiseSuppression,
      autoGainControl: value.audio.autoGainControl,
    });

    applyAudioSettings();
    audio.setMuted(muted);

    return true;
  } catch (err) {
    reportError(errorMessage(err, 'Не удалось получить доступ к микрофону.'), err);
    return false;
  }
}

/**
 * Поднимает голосовое соединение по данным авторизации.
 *
 * @param {object} payload Данные сообщения server.authenticated.
 */
async function startVoice(payload) {
  const voiceConfig = payload.voice;

  if (!voiceConfig || voiceConfig.enabled !== true || voiceConfig.rtpCapabilities === null) {
    reportError('Голосовой сервер недоступен. Голосовые функции отключены.');
    return;
  }

  const microphoneReady = await startMicrophone();

  try {
    await voice.start({ rtpCapabilities: voiceConfig.rtpCapabilities });
  } catch (err) {
    reportError(errorMessage(err, 'Не удалось создать голосовое соединение.'), err);
    return;
  }

  proximity.invalidateProducer();
  await proximity.syncProducer();

  if (microphoneReady) {
    try {
      await voice.enableRadio();
    } catch (err) {
      reportError(errorMessage(err, 'Не удалось создать радиопоток.'), err);
    }
  }

  for (const message of pendingConsumers.splice(0)) {
    await voice.consume(message);
  }
}

/**
 * Полностью останавливает голосовые ресурсы.
 */
async function stopVoice() {
  pendingConsumers = [];
  cancelVoiceRecovery();

  try {
    await voice.close();
  } catch (err) {
    console.error('Ошибка закрытия голосового соединения:', err);
  }

  proximity.reset();
  radio.reset();
}

/**
 * Пересоздаёт голосовые ресурсы после смены параметров микрофона.
 */
async function restartVoice() {
  const wasStarted = authenticatedPayload !== null;

  await stopVoice();

  if (wasStarted) {
    await startVoice(authenticatedPayload);
  }
}

/**
 * Обрабатывает серверные сообщения.
 *
 * @param {object} message
 */
async function handleServerMessage(message) {
  switch (message.type) {
    case ServerMessageType.AUTHENTICATED: {
      authenticatedPayload = message.data;
      currentUser = message.data?.user ?? null;

      ui.showApp();
      ui.setAuthStatus({ authenticated: true, user: currentUser });
      proximity.applyConfig(message.data?.voice?.proximity ?? {});
      radio.setSelfUserId(currentUser?.id ?? null);
      radio.setState(message.data?.radio ?? { enabled: false, channels: [] });
      await proximity.applyGameState(message.data?.game ?? {});
      await startVoice(message.data);

      break;
    }

    case ServerMessageType.GAME_STATE: {
      await proximity.applyGameState(message.data ?? {});
      break;
    }

    case ServerMessageType.PROXIMITY_STATE: {
      proximity.setNearbyCount(message.data?.nearbyCount ?? 0);
      break;
    }

    case ServerMessageType.RADIO_STATE: {
      radio.setState(message.data ?? { enabled: false, channels: [] });
      break;
    }

    case ServerMessageType.RADIO_TRANSMISSION: {
      const event = message.data ?? {};

      if (currentUser !== null && event.active === false && event.speakerUserId === currentUser.id) {
        radio.stopLocalTransmission();
      }

      radio.setTransmission(event);
      break;
    }

    case ServerMessageType.VOICE_CONSUMER_CREATED: {
      const payload = message.data ?? {};

      if (!voice.isStarted()) {
        pendingConsumers.push(payload);
        break;
      }

      await voice.consume(payload);
      break;
    }

    case ServerMessageType.VOICE_CONSUMER_CLOSED: {
      if (typeof message.data?.consumerId === 'string') {
        voice.closeConsumer(message.data.consumerId);
      }

      break;
    }

    case ServerMessageType.ERROR: {
      const code = message.data?.code ?? 'server_error';
      const text = message.data?.message ?? 'Сервер сообщил об ошибке.';

      // Ошибка с id относится к конкретному запросу. Его ожидающий код
      // (VoiceClient, RadioController) покажет сообщение сам — иначе
      // пользователь увидел бы два одинаковых уведомления.
      if (typeof message.id === 'string') {
        break;
      }

      if (code !== 'not_authenticated') {
        ui.toast(text, 'error');
      }

      break;
    }

    default:
      break;
  }
}

/**
 * Обрабатывает изменение состояния соединения.
 *
 * @param {{state: string, error?: object|null}} state
 */
async function handleSignalState(state) {
  ui.setConnection(state);

  if (state.state === 'ready') {
    return;
  }

  if (
    state.state === 'reconnecting' ||
    state.state === 'closed' ||
    state.state === 'error' ||
    state.state === 'replaced'
  ) {
    authenticatedPayload = null;
    await stopVoice();

    if (state.state === 'replaced') {
      ui.toast('Выполнен вход с другого устройства. Это окно больше не передаёт голос.', 'error');
    } else if (state.state === 'error' && state.error?.message) {
      ui.toast(state.error.message, 'error');
    }
  }
}

/**
 * Загружает и показывает список устройств.
 */
async function refreshDevices() {
  try {
    const devices = await listAudioDevices();
    ui.setDevices(devices, settings.get());
  } catch {
    // Список устройств недоступен до выдачи разрешения — не критично.
  }
}

/**
 * Обрабатывает изменение настроек.
 *
 * @param {object} patch
 */
async function handleSettingsChange(patch) {
  const previous = settings.get();

  try {
    const next = await settings.update(patch);

    applyAudioSettings();

    if (previous.audio.outputDeviceId !== next.audio.outputDeviceId) {
      await audio.setOutputDevice(next.audio.outputDeviceId);
    }

    if (previous.audio.inputDeviceId !== next.audio.inputDeviceId) {
      if (audio.started) {
        try {
          await audio.switchInput(next.audio.inputDeviceId);
        } catch (err) {
          reportError(errorMessage(err, 'Не удалось переключить микрофон.'), err);
        }
      }
    }

    const constraintsChanged =
      previous.audio.echoCancellation !== next.audio.echoCancellation ||
      previous.audio.noiseSuppression !== next.audio.noiseSuppression ||
      previous.audio.autoGainControl !== next.audio.autoGainControl;

    if (constraintsChanged && audio.started) {
      await restartVoice();
    }

    if (previous.ptt.radioKey !== next.ptt.radioKey || previous.ptt.radioGlobal !== next.ptt.radioGlobal) {
      const shortcut = await bridge.shortcuts.apply({
        radioKey: next.ptt.radioKey,
        radioGlobal: next.ptt.radioGlobal,
      });

      if (shortcut?.error) {
        ui.toast(shortcut.error.message, 'error');
      }
    }

    await refreshDevices();
  } catch (err) {
    reportError(errorMessage(err, 'Не удалось сохранить настройки.'), err);
  }
}

/**
 * Включает и выключает микрофон.
 */
async function toggleMute() {
  muted = !muted;

  audio.setMuted(muted);
  radio.stopLocalTransmission();
  ui.setMic({ muted, level: 0 });

  if (!voice.isStarted()) {
    return;
  }

  try {
    await voice.setMuted(muted);
  } catch (err) {
    reportError(errorMessage(err, 'Не удалось изменить состояние микрофона.'), err);
  }
}

/**
 * Подключается к серверу.
 */
async function connect() {
  try {
    await signaling.connect();
  } catch (err) {
    reportError(errorMessage(err, 'Не удалось подключиться к серверу.'), err);
  }
}

/**
 * Обновляет индикатор уровня микрофона.
 *
 * @param {number} timestamp
 */
function updateLevelMeter(timestamp) {
  if (timestamp - lastLevelUpdate >= LEVEL_UPDATE_MS) {
    lastLevelUpdate = timestamp;

    if (audio.started) {
      ui.setMic({ muted, level: audio.getLevel() });
    }
  }

  levelTimer = window.requestAnimationFrame(updateLevelMeter);
}

/**
 * Настраивает обработчики интерфейса.
 */
function createUi() {
  ui = new AppUi({
    onLogin: () => {
      void (async () => {
        ui.setBusy(true);
        ui.setLoginError(null);

        try {
          const status = await bridge.auth.login();

          ui.setAuthStatus(status);
          ui.showApp();
          await refreshDevices();
          await connect();
        } catch (err) {
          const message = errorMessage(err, 'Не удалось выполнить вход.');
          ui.setLoginError(message);
        } finally {
          ui.setBusy(false);
        }
      })();
    },

    onLogout: () => {
      void (async () => {
        try {
          await signaling.disconnect();
        } catch {
          // Соединение могло быть уже закрыто.
        }

        proximityPttHeld = false;
        voiceRecoveryAttempts = 0;
        authenticatedPayload = null;

        await stopVoice();
        await audio.dispose();

        try {
          const status = await bridge.auth.logout();
          ui.setAuthStatus(status);
        } catch (err) {
          reportError(errorMessage(err, 'Не удалось завершить сессию.'), err);
        }

        ui.showLogin();
      })();
    },

    onReconnect: () => {
      void connect();
    },

    onRelink: () => {
      void (async () => {
        try {
          const result = await bridge.auth.relink();

          ui.setAuthStatus(result.status);

          if (result.linkStatus === 'linked') {
            ui.toast('Привязка Roblox подтверждена.', 'success');
          } else if (result.linkStatus === 'not_linked') {
            ui.toast('Привязка Roblox не найдена. Привяжите аккаунт через Bloxlink.', 'error');
          } else {
            ui.toast('Привязка проверена, но статус требует внимания.', 'info');
          }
        } catch (err) {
          reportError(errorMessage(err, 'Не удалось проверить привязку Roblox.'), err);
        }
      })();
    },

    onMuteToggle: () => {
      void toggleMute();
    },

    onSettingsChange: (patch) => {
      void handleSettingsChange(patch);
    },

    onResetSettings: () => {
      void (async () => {
        try {
          await settings.reset();

          applyAudioSettings();
          await audio.setOutputDevice(settings.get().audio.outputDeviceId);
          await refreshDevices();
          ui.toast('Настройки сброшены.', 'success');
        } catch (err) {
          reportError(errorMessage(err, 'Не удалось сбросить настройки.'), err);
        }
      })();
    },

    onJoinChannel: (channelId) => {
      void radio.join(channelId).catch((err) => {
        reportError(errorMessage(err, 'Не удалось войти в радиоканал.'), err);
      });
    },

    onLeaveChannel: () => {
      void radio.leave().catch((err) => {
        reportError(errorMessage(err, 'Не удалось покинуть радиоканал.'), err);
      });
    },

    onRadioPttStart: () => {
      if (muted) {
        ui.toast('Микрофон выключен.', 'error');
        return;
      }

      void radio.startTransmission();
    },

    onRadioPttStop: () => {
      void radio.stopTransmission();
    },

    onProximityPttStart: () => {
      proximityPttHeld = true;
      audio.setProximityPushToTalk(true);
    },

    onProximityPttStop: () => {
      proximityPttHeld = false;

      if (settings.get()?.microphone.mode === 'pushToTalk') {
        audio.setProximityPushToTalk(false);
      }
    },

    onChannelHoldStart: () => {
      if (muted) {
        ui.toast('Микрофон выключен.', 'error');
        return;
      }

      void radio.startTransmission();
    },

    onChannelHoldStop: () => {
      void radio.stopTransmission();
    },
  });
}

/**
 * Запускает приложение.
 */
async function boot() {
  if (!bridge || typeof bridge.getAppInfo !== 'function') {
    showFatal('Не удалось загрузить безопасный preload-интерфейс приложения.');
    return;
  }

  audio = new AudioEngine();

  signaling = new SignalingChannel({
    bridge,
    onMessage: (message) => {
      void handleServerMessage(message);
    },
    onState: (state) => {
      void handleSignalState(state);
    },
  });

  voice = new VoiceClient({
    signaling,
    audio,
    onEvent: (event) => {
      if (event.type !== 'error') {
        return;
      }

      ui?.toast(event.message, 'error');

      if (event.recoverable === true) {
        scheduleVoiceRecovery();
      }
    },
  });

  proximity = new ProximityController({
    voice,
    onUpdate: (state) => {
      ui?.setProximity(state);
    },
    onError: (error) => {
      ui?.toast(error.message, 'error');
    },
  });

  radio = new RadioController({
    signaling,
    audio,
    onUpdate: (state) => {
      ui?.setRadio(state);
    },
    onError: (error) => {
      ui?.toast(error.message, 'error');
    },
  });

  settings = new SettingsController({
    bridge,
    onUpdate: (value) => {
      ui?.setSettings(value);
    },
    onError: (error) => {
      ui?.toast(error.message, 'error');
    },
  });

  createUi();

  const [appInfo, config] = await Promise.all([bridge.getAppInfo(), bridge.getConfig()]);

  ui.setServerInfo({ serverUrl: config.serverUrl, version: appInfo.version });

  if (Array.isArray(config.warnings)) {
    for (const warning of config.warnings) {
      ui.toast(warning, 'error');
    }
  }

  await settings.load();
  applyAudioSettings();

  await refreshDevices();
  onDevicesChanged(() => {
    void refreshDevices();
  });

  bridge.events.onAuthChanged((status) => {
    ui.setAuthStatus(status);

    if (!status.authenticated) {
      ui.showLogin();
    }
  });

  bridge.events.onSettingsChanged((value) => {
    ui.setSettings(value);
  });

  bridge.events.onShortcutTrigger(() => {
    if (muted) {
      ui.toast('Микрофон выключен.', 'error');
      return;
    }

    void radio.toggleTransmission();
  });

  bridge.events.onNotice((notice) => {
    if (notice?.message) {
      ui.toast(notice.message, 'error');
    }
  });

  ui.setConnection({ state: 'idle', error: null });

  const status = await bridge.auth.status();

  ui.setAuthStatus(status);

  if (status.authenticated) {
    ui.showApp();
    ui.setMic({ muted, level: 0 });
    await connect();
  } else {
    ui.showLogin();

    if (status.error?.message) {
      ui.setLoginError(status.error.message);
    }
  }

  levelTimer = window.requestAnimationFrame(updateLevelMeter);

  window.addEventListener('beforeunload', () => {
    if (levelTimer !== null) {
      window.cancelAnimationFrame(levelTimer);
    }

    cancelVoiceRecovery();
    void voice.close();
    void audio.dispose();
  });
}

void boot().catch((err) => {
  showFatal(errorMessage(err, 'Не удалось запустить клиент.'));
  console.error(err);
});
