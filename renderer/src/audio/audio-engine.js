/**
 * Аудиодвижок клиента.
 *
 * Физический микрофон захватывается ровно один раз. Дальше Web Audio API
 * разделяет его на два независимых маршрута:
 * - proximity — голос по близости;
 * - radio — передача в радиоканале.
 *
 * Такое разделение позволяет:
 * - приглушать (но не отключать) proximity во время радиопередачи;
 * - держать отдельный PTT для радио;
 * - менять микрофон без пересоздания Producer-ов: треки на выходе
 *   MediaStreamDestination остаются теми же объектами.
 */

/** Во сколько раз приглушается proximity при активном радио. */
const DUCK_LEVEL = 0.35;

/** Плавность изменения усиления, чтобы не было щелчков. */
const GAIN_SMOOTHING_SECONDS = 0.02;

/**
 * Переводит ошибку getUserMedia в понятный текст.
 *
 * @param {unknown} err
 * @returns {Error}
 */
function toMicrophoneError(err) {
  const name = err && typeof err === 'object' ? err.name : '';

  const messages = {
    NotAllowedError: 'Доступ к микрофону запрещён. Разрешите его в настройках Windows.',
    PermissionDeniedError: 'Доступ к микрофону запрещён. Разрешите его в настройках Windows.',
    NotFoundError: 'Микрофон не найден. Подключите устройство ввода.',
    DevicesNotFoundError: 'Микрофон не найден. Подключите устройство ввода.',
    NotReadableError: 'Микрофон занят другим приложением или отключён.',
    TrackStartError: 'Микрофон занят другим приложением или отключён.',
    OverconstrainedError: 'Выбранное устройство ввода недоступно. Выберите другое.',
    AbortError: 'Не удалось запустить микрофон. Попробуйте ещё раз.',
  };

  const error = new Error(messages[name] ?? 'Не удалось получить доступ к микрофону.');
  error.code = typeof name === 'string' && name !== '' ? name : 'microphone_error';

  return error;
}

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.context = null;
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {MediaStreamAudioSourceNode|null} */
    this.source = null;
    this.inputGain = null;
    this.proximityGain = null;
    this.radioGain = null;
    this.proximityDestination = null;
    this.radioDestination = null;
    this.analyser = null;
    this.analyserBuffer = null;

    /** @type {Map<string, {element: HTMLAudioElement, source: string}>} */
    this.consumers = new Map();

    this.muted = false;
    this.inputVolume = 1;
    this.outputVolume = 1;
    this.outputDeviceId = '';
    this.micMode = 'open';
    this.proximityPttActive = true;
    this.radioTransmitting = false;
    this.radioReceiving = false;
    this.duckOutgoing = true;
    this.duckIncoming = true;
    this.started = false;
  }

  /**
   * Запускает захват микрофона и строит граф обработки.
   *
   * @param {{
   *   deviceId?: string,
   *   echoCancellation?: boolean,
   *   noiseSuppression?: boolean,
   *   autoGainControl?: boolean,
   * }} options
   * @returns {Promise<{proximity: MediaStreamTrack, radio: MediaStreamTrack}>}
   */
  async start({
    deviceId = '',
    echoCancellation = true,
    noiseSuppression = true,
    autoGainControl = true,
  } = {}) {
    await this.dispose();

    const constraints = {
      echoCancellation,
      noiseSuppression,
      autoGainControl,
      channelCount: 1,
      ...(deviceId !== '' ? { deviceId: { exact: deviceId } } : {}),
    };

    this.constraints = constraints;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
    } catch (err) {
      throw toMicrophoneError(err);
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (typeof AudioContextClass !== 'function') {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      throw new Error('Web Audio API недоступен в этой сборке клиента.');
    }

    this.context = new AudioContextClass({ sampleRate: 48_000 });

    if (this.context.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        // Контекст возобновится по первому действию пользователя.
      }
    }

    this.source = this.context.createMediaStreamSource(this.stream);

    this.inputGain = this.context.createGain();
    this.proximityGain = this.context.createGain();
    this.radioGain = this.context.createGain();
    this.proximityDestination = this.context.createMediaStreamDestination();
    this.radioDestination = this.context.createMediaStreamDestination();

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.4;
    this.analyserBuffer = new Uint8Array(this.analyser.fftSize);

    this.source.connect(this.inputGain);
    this.source.connect(this.analyser);

    this.inputGain.connect(this.proximityGain);
    this.proximityGain.connect(this.proximityDestination);

    this.inputGain.connect(this.radioGain);
    this.radioGain.connect(this.radioDestination);

    this.inputGain.gain.value = 1;
    this.proximityGain.gain.value = 0;
    this.radioGain.gain.value = 0;

    this.started = true;
    this.#applyOutgoingGains();

    return this.getTracks();
  }

  /**
   * Переключает микрофон без пересоздания Producer-ов.
   * Возвращает те же выходные треки — они не меняются.
   *
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async switchInput(deviceId) {
    if (!this.started || this.context === null) {
      throw new Error('Микрофон ещё не запущен.');
    }

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(this.constraints ?? {}),
      channelCount: 1,
    };

    if (deviceId !== '') {
      audioConstraints.deviceId = { exact: deviceId };
    } else {
      delete audioConstraints.deviceId;
    }

    let stream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    } catch (err) {
      throw toMicrophoneError(err);
    }

    const previousSource = this.source;
    const previousStream = this.stream;

    this.stream = stream;
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.inputGain);
    this.source.connect(this.analyser);

    try {
      previousSource?.disconnect();
    } catch {
      // Узел мог быть уже отключён.
    }

    previousStream?.getTracks().forEach((track) => track.stop());
  }

  /**
   * Возвращает треки для Producer-ов.
   *
   * @returns {{proximity: MediaStreamTrack, radio: MediaStreamTrack}}
   */
  getTracks() {
    if (!this.started || this.proximityDestination === null || this.radioDestination === null) {
      throw new Error('Микрофон не запущен.');
    }

    return {
      proximity: this.proximityDestination.stream.getAudioTracks()[0],
      radio: this.radioDestination.stream.getAudioTracks()[0],
    };
  }

  /**
   * @param {boolean} muted
   */
  setMuted(muted) {
    this.muted = muted === true;
    this.#applyOutgoingGains();
  }

  /**
   * @param {'open'|'pushToTalk'} mode
   */
  setMicMode(mode) {
    this.micMode = mode === 'pushToTalk' ? 'pushToTalk' : 'open';
    this.#applyOutgoingGains();
  }

  /**
   * @param {boolean} active
   */
  setProximityPushToTalk(active) {
    this.proximityPttActive = active === true;
    this.#applyOutgoingGains();
  }

  /**
   * @param {boolean} transmitting
   */
  setRadioTransmitting(transmitting) {
    this.radioTransmitting = transmitting === true;
    this.#applyOutgoingGains();
    this.#applyIncomingVolumes();
  }

  /**
   * @param {number} volume 0..2
   */
  setInputVolume(volume) {
    this.inputVolume = Number.isFinite(volume) ? Math.min(2, Math.max(0, volume)) : 1;
    this.#applyOutgoingGains();
  }

  /**
   * @param {number} volume 0..1
   */
  setOutputVolume(volume) {
    this.outputVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    this.#applyIncomingVolumes();
  }

  /**
   * @param {boolean} enabled Приглушать входящий proximity при радио.
   */
  setIncomingDucking(enabled) {
    this.duckIncoming = enabled === true;
    this.#applyIncomingVolumes();
  }

  /**
   * @param {boolean} enabled Приглушать исходящий proximity при радиопередаче.
   */
  setOutgoingDucking(enabled) {
    this.duckOutgoing = enabled === true;
    this.#applyOutgoingGains();
  }

  /**
   * Выбирает устройство вывода для всех входящих голосовых потоков.
   *
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  async setOutputDevice(deviceId) {
    this.outputDeviceId = typeof deviceId === 'string' ? deviceId : '';

    await Promise.all(
      [...this.consumers.values()].map(async ({ element }) => {
        if (typeof element.setSinkId !== 'function') {
          return;
        }

        try {
          await element.setSinkId(this.outputDeviceId);
        } catch {
          // Устройство могло исчезнуть: остаётся системный вывод по умолчанию.
        }
      }),
    );
  }

  /**
   * Подключает входящий голосовой поток к выводу.
   *
   * @param {{consumerId: string, track: MediaStreamTrack, source: string}} options
   */
  attachConsumer({ consumerId, track, source }) {
    this.detachConsumer(consumerId);

    const element = document.createElement('audio');

    element.autoplay = true;
    element.dataset.consumerId = consumerId;
    element.srcObject = new MediaStream([track]);
    element.volume = this.#elementVolume(source);

    if (this.outputDeviceId !== '' && typeof element.setSinkId === 'function') {
      element.setSinkId(this.outputDeviceId).catch(() => {});
    }

    document.body.appendChild(element);

    const playResult = element.play();

    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => {
        // Автовоспроизведение может требовать действия пользователя.
      });
    }

    this.consumers.set(consumerId, { element, source });

    if (source === 'radio') {
      this.radioReceiving = true;
      this.#applyIncomingVolumes();
    }
  }

  /**
   * @param {string} consumerId
   */
  detachConsumer(consumerId) {
    const entry = this.consumers.get(consumerId);

    if (!entry) {
      return;
    }

    entry.element.pause();
    entry.element.srcObject = null;
    entry.element.remove();
    this.consumers.delete(consumerId);

    if (entry.source === 'radio') {
      const stillReceiving = [...this.consumers.values()].some((item) => item.source === 'radio');

      if (!stillReceiving) {
        this.radioReceiving = false;
        this.#applyIncomingVolumes();
      }
    }
  }

  /** Отключает все входящие потоки. */
  detachAllConsumers() {
    for (const consumerId of [...this.consumers.keys()]) {
      this.detachConsumer(consumerId);
    }
  }

  /**
   * Текущий уровень микрофона (0..1) для индикатора.
   *
   * @returns {number}
   */
  getLevel() {
    if (!this.analyser || !this.analyserBuffer) {
      return 0;
    }

    this.analyser.getByteTimeDomainData(this.analyserBuffer);

    let sum = 0;

    for (let index = 0; index < this.analyserBuffer.length; index += 1) {
      const value = (this.analyserBuffer[index] - 128) / 128;
      sum += value * value;
    }

    const rms = Math.sqrt(sum / this.analyserBuffer.length);

    return Math.min(1, rms * 5);
  }

  /** Освобождает микрофон, аудиоконтекст и элементы вывода. */
  async dispose() {
    this.detachAllConsumers();

    this.source?.disconnect();
    this.inputGain?.disconnect();
    this.proximityGain?.disconnect();
    this.radioGain?.disconnect();
    this.analyser?.disconnect();

    for (const node of [this.proximityDestination, this.radioDestination]) {
      node?.stream.getTracks().forEach((track) => track.stop());
    }

    this.stream?.getTracks().forEach((track) => track.stop());

    if (this.context !== null) {
      try {
        await this.context.close();
      } catch {
        // Контекст мог быть уже закрыт.
      }
    }

    this.context = null;
    this.stream = null;
    this.source = null;
    this.inputGain = null;
    this.proximityGain = null;
    this.radioGain = null;
    this.proximityDestination = null;
    this.radioDestination = null;
    this.analyser = null;
    this.analyserBuffer = null;
    this.started = false;
    this.radioReceiving = false;
    // После освобождения микрофона передача невозможна: следующая сессия
    // начнётся с закрытых шлюзов и применит актуальные настройки заново.
    this.radioTransmitting = false;
    this.proximityPttActive = false;
  }

  #applyOutgoingGains() {
    if (this.context === null || this.proximityGain === null || this.radioGain === null) {
      return;
    }

    const base = this.muted ? 0 : this.inputVolume;
    const proximityGate =
      this.micMode === 'pushToTalk' ? (this.proximityPttActive ? 1 : 0) : 1;
    const duck = this.duckOutgoing && this.radioTransmitting ? DUCK_LEVEL : 1;

    this.#setGain(this.proximityGain, base * proximityGate * duck);
    this.#setGain(this.radioGain, this.muted ? 0 : this.radioTransmitting ? base : 0);
  }

  /**
   * @param {GainNode} node
   * @param {number} value
   */
  #setGain(node, value) {
    const now = this.context.currentTime;

    node.gain.cancelScheduledValues(now);
    node.gain.setTargetAtTime(Math.max(0, value), now, GAIN_SMOOTHING_SECONDS);
  }

  /**
   * @param {string} source
   * @returns {number}
   */
  #elementVolume(source) {
    const duck =
      source === 'proximity' && this.duckIncoming && (this.radioTransmitting || this.radioReceiving)
        ? DUCK_LEVEL
        : 1;

    return Math.min(1, Math.max(0, this.outputVolume * duck));
  }

  #applyIncomingVolumes() {
    for (const { element, source } of this.consumers.values()) {
      element.volume = this.#elementVolume(source);
    }
  }
}
