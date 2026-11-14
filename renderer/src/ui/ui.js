/**
 * Пользовательский интерфейс клиента.
 *
 * Модуль отвечает только за отображение состояния и ввод пользователя.
 * Все действия передаются в приложение через колбэки: сам UI ничего не
 * решает про голос, каналы и соединение.
 */

import { formatAccelerator, eventToAccelerator, eventMatchesAccelerator } from '../core/keyboard.js';
import { showToast } from './toasts.js';

const CONNECTION_LABELS = Object.freeze({
  idle: { text: 'Не подключено', tone: 'muted' },
  connecting: { text: 'Подключение…', tone: 'warn' },
  authenticating: { text: 'Проверка сессии…', tone: 'warn' },
  ready: { text: 'На связи', tone: 'ok' },
  reconnecting: { text: 'Переподключение…', tone: 'warn' },
  closed: { text: 'Отключено', tone: 'muted' },
  error: { text: 'Ошибка соединения', tone: 'error' },
  replaced: { text: 'Вход с другого устройства', tone: 'error' },
});

const STATE_LABELS = Object.freeze({
  idle: 'Ожидание',
  connecting: 'Установка соединения',
  authenticating: 'Авторизация',
  ready: 'Работает',
  reconnecting: 'Переподключение',
  closed: 'Отключено',
  error: 'Ошибка',
  replaced: 'Сессия заменена',
});

/**
 * @param {HTMLElement|null} element
 * @param {string} selector
 * @returns {HTMLElement}
 */
function requireElement(element, selector) {
  if (!element) {
    throw new Error(`Не найден элемент интерфейса: ${selector}`);
  }

  return element;
}

/**
 * @param {Element|null} target
 * @returns {boolean}
 */
function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName;

  return (
    tag === 'INPUT' ||
    tag === 'SELECT' ||
    tag === 'TEXTAREA' ||
    tag === 'BUTTON' ||
    target.isContentEditable === true
  );
}

export class AppUi {
  /**
   * @param {{
   *   onLogin: () => void,
   *   onLogout: () => void,
   *   onReconnect: () => void,
   *   onRelink: () => void,
   *   onMuteToggle: () => void,
   *   onSettingsChange: (patch: object) => void,
   *   onResetSettings: () => void,
   *   onJoinChannel: (channelId: string) => void,
   *   onLeaveChannel: () => void,
   *   onRadioPttStart: () => void,
   *   onRadioPttStop: () => void,
   *   onProximityPttStart: () => void,
   *   onProximityPttStop: () => void,
   *   onChannelHoldStart: () => void,
   *   onChannelHoldStop: () => void,
   * }} callbacks
   */
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.settings = null;
    this.capturing = null;
    this.busy = false;
    this.authEnabled = null;

    this.elements = {
      viewLogin: requireElement(document.getElementById('view-login'), '#view-login'),
      viewApp: requireElement(document.getElementById('view-app'), '#view-app'),
      loginButton: requireElement(document.getElementById('btn-login'), '#btn-login'),
      loginError: requireElement(document.getElementById('login-error'), '#login-error'),
      logoutButton: requireElement(document.getElementById('btn-logout'), '#btn-logout'),
      userChip: requireElement(document.getElementById('user-chip'), '#user-chip'),
      userName: requireElement(document.getElementById('user-name'), '#user-name'),
      userRoblox: requireElement(document.getElementById('user-roblox'), '#user-roblox'),
      connectionPill: requireElement(document.getElementById('connection-pill'), '#connection-pill'),

      proximityBadge: requireElement(document.getElementById('proximity-badge'), '#proximity-badge'),
      proximityText: requireElement(document.getElementById('proximity-text'), '#proximity-text'),
      nearbyCount: requireElement(document.getElementById('nearby-count'), '#nearby-count'),
      distanceValue: requireElement(document.getElementById('distance-value'), '#distance-value'),
      playerInfo: requireElement(document.getElementById('player-info'), '#player-info'),

      radioBadge: requireElement(document.getElementById('radio-badge'), '#radio-badge'),
      radioHint: requireElement(document.getElementById('radio-hint'), '#radio-hint'),
      channelList: requireElement(document.getElementById('channel-list'), '#channel-list'),
      radioTransmission: requireElement(
        document.getElementById('radio-transmission'),
        '#radio-transmission',
      ),
      transmissionText: requireElement(document.getElementById('tx-text'), '#tx-text'),

      micBadge: requireElement(document.getElementById('mic-badge'), '#mic-badge'),
      micMeter: requireElement(document.getElementById('mic-meter'), '#mic-meter'),
      muteButton: requireElement(document.getElementById('btn-mute'), '#btn-mute'),
      selectInput: requireElement(document.getElementById('select-input'), '#select-input'),
      selectOutput: requireElement(document.getElementById('select-output'), '#select-output'),
      selectMicMode: requireElement(document.getElementById('select-mic-mode'), '#select-mic-mode'),
      pttHint: requireElement(document.getElementById('ptt-hint'), '#ptt-hint'),

      rangeVolume: requireElement(document.getElementById('range-volume'), '#range-volume'),
      rangeGain: requireElement(document.getElementById('range-gain'), '#range-gain'),
      volumeValue: requireElement(document.getElementById('out-volume-value'), '#out-volume-value'),
      gainValue: requireElement(document.getElementById('out-gain-value'), '#out-gain-value'),
      checkEcho: requireElement(document.getElementById('chk-echo'), '#chk-echo'),
      checkNoise: requireElement(document.getElementById('chk-noise'), '#chk-noise'),
      checkAgc: requireElement(document.getElementById('chk-agc'), '#chk-agc'),
      checkDuck: requireElement(document.getElementById('chk-duck'), '#chk-duck'),
      keyRadio: requireElement(document.getElementById('btn-key-radio'), '#btn-key-radio'),
      keyProximity: requireElement(
        document.getElementById('btn-key-proximity'),
        '#btn-key-proximity',
      ),
      checkRadioGlobal: requireElement(document.getElementById('chk-radio-global'), '#chk-radio-global'),
      resetButton: requireElement(document.getElementById('btn-reset'), '#btn-reset'),

      reconnectButton: requireElement(document.getElementById('btn-reconnect'), '#btn-reconnect'),
      relinkButton: requireElement(document.getElementById('btn-relink'), '#btn-relink'),
      serverUrl: requireElement(document.getElementById('server-url'), '#server-url'),
      signalState: requireElement(document.getElementById('signal-state'), '#signal-state'),
      appVersion: requireElement(document.getElementById('app-version'), '#app-version'),
    };

    this.#bindEvents();
  }

  /** Показывает экран входа. */
  showLogin() {
    this.elements.viewLogin.classList.remove('hidden');
    this.elements.viewApp.classList.add('hidden');
    this.elements.userChip.classList.add('hidden');
    this.elements.logoutButton.classList.add('hidden');
  }

  /** Показывает основной экран. */
  showApp() {
    this.elements.viewLogin.classList.add('hidden');
    this.elements.viewApp.classList.remove('hidden');
    this.elements.userChip.classList.remove('hidden');
    this.elements.logoutButton.classList.remove('hidden');
  }

  /**
   * @param {string|null} message
   */
  setLoginError(message) {
    if (typeof message === 'string' && message !== '') {
      this.elements.loginError.textContent = message;
      this.elements.loginError.classList.remove('hidden');
    } else {
      this.elements.loginError.textContent = '';
      this.elements.loginError.classList.add('hidden');
    }
  }

  /**
   * @param {boolean} busy
   */
  setBusy(busy) {
    this.busy = busy;
    this.elements.loginButton.disabled = busy || this.authEnabled === false;
    this.elements.loginButton.textContent = busy ? 'Ожидание входа…' : 'Войти через Discord';
  }

  /**
   * @param {{authenticated: boolean, user?: object|null, error?: object|null, authEnabled?: boolean|null}} status
   */
  setAuthStatus(status) {
    if (status.authEnabled === true || status.authEnabled === false) {
      this.authEnabled = status.authEnabled;
    }

    if (!status.authenticated) {
      this.elements.userName.textContent = '—';
      this.elements.userRoblox.textContent = 'Roblox не привязан';

      if (status.authEnabled === false) {
        this.setLoginError('На сервере не настроена авторизация через Discord.');
        this.elements.loginButton.disabled = true;
      } else if (!this.busy) {
        this.elements.loginButton.disabled = false;
      }

      return;
    }

    const user = status.user ?? {};

    this.elements.userName.textContent = user.discordGlobalName || user.discordUsername || 'Пользователь';

    if (user.roblox) {
      this.elements.userRoblox.textContent = `Roblox: ${user.roblox.username ?? user.roblox.id}`;
    } else {
      this.elements.userRoblox.textContent = 'Roblox не привязан';
    }
  }

  /**
   * @param {{state: string, error?: object|null}} state
   */
  setConnection(state) {
    const info = CONNECTION_LABELS[state.state] ?? CONNECTION_LABELS.idle;

    this.elements.connectionPill.textContent = info.text;
    this.elements.connectionPill.className = `pill pill--${info.tone}`;
    this.elements.signalState.textContent =
      state.error?.message && (state.state === 'error' || state.state === 'reconnecting')
        ? `${STATE_LABELS[state.state] ?? state.state}: ${state.error.message}`
        : STATE_LABELS[state.state] ?? state.state;
  }

  /**
   * @param {object} state
   */
  setProximity(state) {
    let badgeText = 'Нет данных';
    let badgeTone = 'muted';
    let text = 'Ожидание данных игрового сервера.';

    if (state.linked === false) {
      badgeText = 'Roblox не привязан';
      badgeTone = 'danger';
      text = 'Привяжите Roblox через Bloxlink и войдите заново, чтобы включить голос по близости.';
    } else if (state.inGame === false) {
      badgeText = 'Не в игре';
      badgeTone = 'muted';
      text = 'Вы не найдены на игровом сервере ER:LC. Голос по близости включится автоматически после входа в игру.';
    } else if (state.stale === true) {
      badgeText = 'Данные устарели';
      badgeTone = 'warn';
      text = 'Игровой сервер временно не отвечает. Голос по близости приостановлен до восстановления данных.';
    } else {
      badgeText = 'В игре';
      badgeTone = 'ok';
      text = 'Голос по близости активен: сервер сам определяет, кто вас слышит.';
    }

    this.elements.proximityBadge.textContent = badgeText;
    this.elements.proximityBadge.className = `badge badge--${badgeTone}`;
    this.elements.proximityText.textContent = text;
    this.elements.nearbyCount.textContent = String(state.nearbyCount ?? 0);
    this.elements.distanceValue.textContent = Number.isFinite(state.maxDistance)
      ? `${state.maxDistance} м`
      : '—';

    this.#renderPlayerInfo(state.player);
  }

  /**
   * @param {object|null} player
   */
  #renderPlayerInfo(player) {
    const container = this.elements.playerInfo;

    container.textContent = '';

    if (!player) {
      return;
    }

    const rows = [
      ['Имя', player.name],
      ['Подразделение', player.team],
      ['Позывной', player.callsign],
      ['Индекс', player.postalCode],
      ['Улица', player.streetName],
    ];

    for (const [label, value] of rows) {
      if (value === null || value === undefined || value === '') {
        continue;
      }

      const term = document.createElement('dt');
      term.textContent = label;

      const description = document.createElement('dd');
      description.textContent = String(value);

      container.append(term, description);
    }
  }

  /**
   * @param {object} state
   */
  setRadio(state) {
    if (state.enabled !== true) {
      this.elements.radioBadge.textContent = 'Недоступно';
      this.elements.radioBadge.className = 'badge badge--muted';
      this.elements.radioHint.textContent =
        'Радио не настроено на сервере: нужен Discord-бот и файл радиоканалов.';
      this.elements.channelList.textContent = '';
      this.elements.radioTransmission.classList.add('hidden');
      return;
    }

    const joined = state.channels.find((channel) => channel.joined === true) ?? null;

    this.elements.radioBadge.textContent = joined ? joined.name : 'Не в канале';
    this.elements.radioBadge.className = joined ? 'badge badge--ok' : 'badge badge--muted';
    this.elements.radioHint.textContent = joined
      ? 'Удерживайте клавишу радио или кнопку передачи. Голос по близости продолжает работать.'
      : 'Выберите канал. Доступ к каналам проверяется по ролям Discord на сервере.';

    this.#renderChannels(state.channels, state.transmitting, joined);

    if (state.transmitting && joined) {
      this.elements.radioTransmission.classList.remove('hidden');
      this.elements.radioTransmission.classList.remove('tx--remote');
      this.elements.transmissionText.textContent = `Передача в канал «${joined.name}»`;
    } else if (state.speaker) {
      this.elements.radioTransmission.classList.remove('hidden');
      this.elements.radioTransmission.classList.add('tx--remote');
      this.elements.transmissionText.textContent = `Говорит ${state.speaker.name}`;
    } else {
      this.elements.radioTransmission.classList.add('hidden');
    }
  }

  /**
   * @param {object[]} channels
   * @param {boolean} transmitting
   * @param {object|null} joined
   */
  #renderChannels(channels, transmitting, joined) {
    const container = this.elements.channelList;

    container.textContent = '';

    if (channels.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'Доступных каналов нет.';
      container.appendChild(empty);
      return;
    }

    for (const channel of channels) {
      const item = document.createElement('li');
      item.className = channel.joined ? 'channel is-joined' : 'channel';

      const main = document.createElement('div');
      main.className = 'channel-main';

      const name = document.createElement('span');
      name.className = 'channel-name';
      name.textContent = channel.name;
      main.appendChild(name);

      if (typeof channel.description === 'string' && channel.description !== '') {
        const description = document.createElement('span');
        description.className = 'channel-desc';
        description.textContent = channel.description;
        main.appendChild(description);
      }

      if (channel.speaker) {
        const speaker = document.createElement('span');
        speaker.className = 'channel-meta';
        speaker.textContent = `Говорит: ${channel.speaker.name}`;
        main.appendChild(speaker);
      }

      const actions = document.createElement('div');
      actions.className = 'channel-actions';

      if (channel.joined) {
        const ptt = document.createElement('button');
        ptt.type = 'button';
        ptt.className = 'btn btn--small btn--danger';
        ptt.textContent = transmitting ? 'Передача…' : 'Передача';
        ptt.dataset.action = 'ptt';
        actions.appendChild(ptt);

        const leave = document.createElement('button');
        leave.type = 'button';
        leave.className = 'btn btn--small btn--ghost';
        leave.textContent = 'Покинуть';
        leave.dataset.action = 'leave';
        actions.appendChild(leave);
      } else {
        const joinButton = document.createElement('button');
        joinButton.type = 'button';
        joinButton.className = 'btn btn--small';
        joinButton.textContent = joined === null ? 'Войти' : 'Сменить';
        joinButton.dataset.action = 'join';
        joinButton.dataset.channelId = channel.id;
        joinButton.disabled = joined !== null;
        actions.appendChild(joinButton);
      }

      item.append(main, actions);
      container.appendChild(item);
    }
  }

  /**
   * @param {{muted: boolean, level: number}} state
   */
  setMic(state) {
    this.elements.micBadge.textContent = state.muted ? 'Выключен' : 'Активен';
    this.elements.micBadge.className = state.muted ? 'badge badge--danger' : 'badge badge--ok';
    this.elements.muteButton.textContent = state.muted ? 'Включить микрофон' : 'Выключить микрофон';
    this.elements.muteButton.classList.toggle('btn--danger', !state.muted);
    this.elements.muteButton.classList.toggle('btn--primary', state.muted);

    const level = state.muted ? 0 : Math.round((state.level ?? 0) * 100);
    this.elements.micMeter.style.width = `${Math.min(100, level)}%`;
  }

  /**
   * @param {object} settings
   */
  setSettings(settings) {
    this.settings = settings;

    this.elements.selectMicMode.value = settings.microphone.mode;
    this.elements.rangeVolume.value = String(Math.round(settings.audio.outputVolume * 100));
    this.elements.rangeGain.value = String(Math.round(settings.audio.inputGain * 100));
    this.elements.volumeValue.textContent = `${Math.round(settings.audio.outputVolume * 100)}%`;
    this.elements.gainValue.textContent = `${Math.round(settings.audio.inputGain * 100)}%`;
    this.elements.checkEcho.checked = settings.audio.echoCancellation;
    this.elements.checkNoise.checked = settings.audio.noiseSuppression;
    this.elements.checkAgc.checked = settings.audio.autoGainControl;
    this.elements.checkDuck.checked = settings.microphone.duckProximityWhileRadio;
    this.elements.checkRadioGlobal.checked = settings.ptt.radioGlobal;
    this.elements.keyRadio.textContent = formatAccelerator(settings.ptt.radioKey);
    this.elements.keyProximity.textContent = formatAccelerator(settings.ptt.proximityKey);

    const pushToTalk = settings.microphone.mode === 'pushToTalk';

    this.elements.pttHint.classList.toggle('hidden', !pushToTalk);
    this.elements.pttHint.textContent = pushToTalk
      ? `Удерживайте ${formatAccelerator(settings.ptt.proximityKey)} для разговора рядом.`
      : '';
  }

  /**
   * @param {{inputs: {deviceId: string, label: string}[], outputs: {deviceId: string, label: string}[]}} devices
   * @param {object} settings
   */
  setDevices(devices, settings) {
    this.#renderDeviceSelect(
      this.elements.selectInput,
      devices.inputs,
      settings.audio.inputDeviceId,
      'Системный микрофон',
    );

    this.#renderDeviceSelect(
      this.elements.selectOutput,
      devices.outputs,
      settings.audio.outputDeviceId,
      'Системное устройство вывода',
    );
  }

  /**
   * @param {HTMLSelectElement} select
   * @param {{deviceId: string, label: string}[]} options
   * @param {string} selected
   * @param {string} defaultLabel
   */
  #renderDeviceSelect(select, options, selected, defaultLabel) {
    select.textContent = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = defaultLabel;
    select.appendChild(defaultOption);

    for (const device of options) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label;
      select.appendChild(option);
    }

    const known = options.some((device) => device.deviceId === selected);
    select.value = known ? selected : '';
  }

  /**
   * @param {{serverUrl: string, version: string}} info
   */
  setServerInfo(info) {
    this.elements.serverUrl.textContent = info.serverUrl;
    this.elements.appVersion.textContent = info.version;
  }

  /**
   * @param {string} message
   * @param {'info'|'success'|'error'} type
   */
  toast(message, type = 'info') {
    showToast(message, type);
  }

  /** Начинает перехват клавиши для PTT. */
  #startKeyCapture(which) {
    if (this.capturing !== null) {
      return;
    }

    const button = which === 'radio' ? this.elements.keyRadio : this.elements.keyProximity;

    this.capturing = { which, button, previous: button.textContent };
    button.classList.add('is-capturing');
    button.textContent = 'Нажмите клавишу';
  }

  #stopKeyCapture() {
    if (this.capturing === null) {
      return;
    }

    this.capturing.button.classList.remove('is-capturing');
    this.capturing = null;
  }

  #bindEvents() {
    this.elements.loginButton.addEventListener('click', () => {
      if (!this.busy) {
        this.callbacks.onLogin();
      }
    });

    this.elements.logoutButton.addEventListener('click', () => {
      this.callbacks.onLogout();
    });

    this.elements.reconnectButton.addEventListener('click', () => {
      this.callbacks.onReconnect();
    });

    this.elements.relinkButton.addEventListener('click', () => {
      this.callbacks.onRelink();
    });

    this.elements.muteButton.addEventListener('click', () => {
      this.callbacks.onMuteToggle();
    });

    this.elements.selectMicMode.addEventListener('change', () => {
      this.callbacks.onSettingsChange({ microphone: { mode: this.elements.selectMicMode.value } });
    });

    this.elements.selectInput.addEventListener('change', () => {
      this.callbacks.onSettingsChange({
        audio: { inputDeviceId: this.elements.selectInput.value },
      });
    });

    this.elements.selectOutput.addEventListener('change', () => {
      this.callbacks.onSettingsChange({
        audio: { outputDeviceId: this.elements.selectOutput.value },
      });
    });

    this.elements.rangeVolume.addEventListener('input', () => {
      const value = Number(this.elements.rangeVolume.value);
      this.elements.volumeValue.textContent = `${value}%`;
    });

    this.elements.rangeVolume.addEventListener('change', () => {
      this.callbacks.onSettingsChange({
        audio: { outputVolume: Number(this.elements.rangeVolume.value) / 100 },
      });
    });

    this.elements.rangeGain.addEventListener('input', () => {
      const value = Number(this.elements.rangeGain.value);
      this.elements.gainValue.textContent = `${value}%`;
    });

    this.elements.rangeGain.addEventListener('change', () => {
      this.callbacks.onSettingsChange({
        audio: { inputGain: Number(this.elements.rangeGain.value) / 100 },
      });
    });

    for (const [element, key] of [
      [this.elements.checkEcho, 'echoCancellation'],
      [this.elements.checkNoise, 'noiseSuppression'],
      [this.elements.checkAgc, 'autoGainControl'],
    ]) {
      element.addEventListener('change', () => {
        this.callbacks.onSettingsChange({ audio: { [key]: element.checked } });
      });
    }

    this.elements.checkDuck.addEventListener('change', () => {
      this.callbacks.onSettingsChange({
        microphone: { duckProximityWhileRadio: this.elements.checkDuck.checked },
      });
    });

    this.elements.checkRadioGlobal.addEventListener('change', () => {
      this.callbacks.onSettingsChange({ ptt: { radioGlobal: this.elements.checkRadioGlobal.checked } });
    });

    this.elements.keyRadio.addEventListener('click', () => {
      this.#startKeyCapture('radio');
    });

    this.elements.keyProximity.addEventListener('click', () => {
      this.#startKeyCapture('proximity');
    });

    this.elements.resetButton.addEventListener('click', () => {
      this.callbacks.onResetSettings();
    });

    this.elements.channelList.addEventListener('click', (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest('button') : null;

      if (!button) {
        return;
      }

      if (button.dataset.action === 'join' && typeof button.dataset.channelId === 'string') {
        this.callbacks.onJoinChannel(button.dataset.channelId);
      } else if (button.dataset.action === 'leave') {
        this.callbacks.onLeaveChannel();
      }
    });

    this.elements.channelList.addEventListener('pointerdown', (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest('button') : null;

      if (button?.dataset.action === 'ptt') {
        event.preventDefault();
        button.setPointerCapture?.(event.pointerId);
        this.callbacks.onChannelHoldStart();
      }
    });

    const stopHold = () => {
      this.callbacks.onChannelHoldStop();
    };

    this.elements.channelList.addEventListener('pointerup', stopHold);
    this.elements.channelList.addEventListener('pointercancel', stopHold);
    this.elements.channelList.addEventListener('pointerleave', stopHold);

    window.addEventListener('keydown', (event) => {
      this.#handleKeyDown(event);
    });

    window.addEventListener('keyup', (event) => {
      this.#handleKeyUp(event);
    });

    window.addEventListener('blur', () => {
      this.callbacks.onRadioPttStop();
      this.callbacks.onProximityPttStop();
    });
  }

  /**
   * @param {KeyboardEvent} event
   */
  #handleKeyDown(event) {
    if (this.capturing !== null) {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        const { previous, button } = this.capturing;
        this.#stopKeyCapture();
        button.textContent = previous;
        return;
      }

      const accelerator = eventToAccelerator(event);

      if (accelerator === null) {
        this.toast('Эта клавиша не поддерживается. Выберите букву, цифру или F1–F24.', 'error');
        return;
      }

      const which = this.capturing.which;
      this.#stopKeyCapture();

      if (which === 'radio') {
        this.callbacks.onSettingsChange({ ptt: { radioKey: accelerator } });
      } else {
        this.callbacks.onSettingsChange({ ptt: { proximityKey: accelerator } });
      }

      return;
    }

    if (this.settings === null || isEditableTarget(event.target)) {
      return;
    }

    const ptt = this.settings.ptt;

    if (!event.repeat && eventMatchesAccelerator(event, ptt.radioKey)) {
      event.preventDefault();
      this.callbacks.onRadioPttStart();
      return;
    }

    if (
      !event.repeat &&
      this.settings.microphone.mode === 'pushToTalk' &&
      eventMatchesAccelerator(event, ptt.proximityKey)
    ) {
      event.preventDefault();
      this.callbacks.onProximityPttStart();
    }
  }

  /**
   * @param {KeyboardEvent} event
   */
  #handleKeyUp(event) {
    if (this.settings === null) {
      return;
    }

    const ptt = this.settings.ptt;

    if (eventMatchesAccelerator(event, ptt.radioKey)) {
      this.callbacks.onRadioPttStop();
    }

    if (eventMatchesAccelerator(event, ptt.proximityKey)) {
      this.callbacks.onProximityPttStop();
    }
  }
}
