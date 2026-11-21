/**
 * Клиентская часть mediasoup.
 *
 * Клиент создаёт только транспорты, Producer-ы и Consumer-ы по указаниям сервера.
 * Он не решает, кто кого слышит: сообщения `server.voice.consumerCreated`
 * приходят исключительно от серверной логики proximity и радио.
 */

import * as mediasoupClient from 'mediasoup-client';
import { AudioSource, ClientMessageType, ServerMessageType } from '../signaling/protocol.js';

/**
 * Ошибка голосового слоя.
 */
export class VoiceError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}

export class VoiceClient {
  /**
   * @param {{
   *   signaling: import('../signaling/channel.js').SignalingChannel,
   *   audio: import('../audio/audio-engine.js').AudioEngine,
   *   onEvent?: ((event: object) => void)|null,
   * }} options
   */
  constructor({ signaling, audio, onEvent = null }) {
    this.signaling = signaling;
    this.audio = audio;
    this.onEvent = onEvent;

    this.device = null;
    this.sendTransport = null;
    this.recvTransport = null;
    /** @type {Map<string, object>} */
    this.producers = new Map();
    /** @type {Map<string, object>} */
    this.consumers = new Map();
    this.proximityAllowed = false;
    this.started = false;
    this.closed = false;
  }

  /** @returns {boolean} */
  isStarted() {
    return this.started && this.device !== null;
  }

  /**
   * Загружает устройство и создаёт WebRTC-транспорты.
   *
   * @param {{rtpCapabilities: object}} options
   * @returns {Promise<void>}
   */
  async start({ rtpCapabilities }) {
    if (this.started) {
      await this.close();
    }

    if (typeof rtpCapabilities !== 'object' || rtpCapabilities === null) {
      throw new VoiceError('Сервер не передал параметры кодеков.', 'rtp_capabilities_missing');
    }

    this.closed = false;
    this.device = new mediasoupClient.Device();

    try {
      await this.device.load({ routerRtpCapabilities: rtpCapabilities });
    } catch (err) {
      this.device = null;
      throw new VoiceError(
        'Не удалось загрузить голосовое устройство. Проверьте поддержку WebRTC в системе.',
        err?.name ?? 'device_load_failed',
      );
    }

    try {
      this.sendTransport = await this.#createTransport('send');
      this.recvTransport = await this.#createTransport('recv');
    } catch (err) {
      // Частично созданные транспорты нельзя оставлять: они занимают ресурсы
      // mediasoup и не будут использоваться.
      await this.close();
      this.closed = false;
      throw err;
    }

    this.started = true;

    this.onEvent?.({ type: 'ready' });
  }

  /**
   * Создаёт транспорт и связывает его события с сигнализацией.
   *
   * @param {'send'|'recv'} direction
   * @returns {Promise<object>}
   */
  async #createTransport(direction) {
    const response = await this.signaling.request(
      ClientMessageType.VOICE_CREATE_TRANSPORT,
      { direction },
      [ServerMessageType.VOICE_TRANSPORT_CREATED],
      { timeoutMs: 10_000 },
    );

    const params = {
      id: response.transportId,
      iceParameters: response.iceParameters,
      iceCandidates: response.iceCandidates,
      dtlsParameters: response.dtlsParameters,
      sctpParameters: response.sctpParameters ?? null,
      iceServers: [],
      iceTransportPolicy: 'all',
    };

    const transport =
      direction === 'send'
        ? this.device.createSendTransport(params)
        : this.device.createRecvTransport(params);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.signaling
        .request(
          ClientMessageType.VOICE_CONNECT_TRANSPORT,
          { transportId: transport.id, dtlsParameters },
          [ServerMessageType.VOICE_TRANSPORT_CONNECTED],
          { timeoutMs: 10_000 },
        )
        .then(() => callback())
        .catch((err) => errback(err));
    });

    transport.on('connectionstatechange', (state) => {
      this.onEvent?.({ type: 'transport', direction, state });

      if (state === 'failed') {
        // Восстановление выполняет renderer: ему нужно заново создать
        // Producers и восстановить состояние близости и радио.
        this.onEvent?.({
          type: 'error',
          code: 'transport_failed',
          message: 'WebRTC-соединение потеряно. Переподключение выполнится автоматически.',
          recoverable: this.started && !this.closed,
        });
      }
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        const source = appData?.source ?? AudioSource.PROXIMITY;

        this.signaling
          .request(
            ClientMessageType.VOICE_PRODUCE,
            { transportId: transport.id, kind, rtpParameters, source },
            [ServerMessageType.VOICE_PRODUCED],
            { timeoutMs: 10_000 },
          )
          .then((payload) => callback({ id: payload.producerId }))
          .catch((err) => errback(err));
      });
    }

    return transport;
  }

  /**
   * Разрешает или запрещает proximity-поток (например, при входе/выходе из игры).
   *
   * @param {boolean} allowed
   * @returns {Promise<void>}
   */
  async setProximityAllowed(allowed) {
    this.proximityAllowed = allowed === true;

    if (this.proximityAllowed) {
      await this.enableProximity();
    } else {
      await this.disableProximity();
    }
  }

  /** Создаёт Producer голоса по близости. */
  async enableProximity() {
    if (!this.isStarted() || !this.proximityAllowed) {
      return;
    }

    await this.#produce(AudioSource.PROXIMITY);
  }

  /** Закрывает Producer голоса по близости. */
  async disableProximity() {
    await this.#closeProducer(AudioSource.PROXIMITY);
  }

  /** Создаёт Producer радиопотока. Сервер держит его на паузе до передачи. */
  async enableRadio() {
    if (!this.isStarted()) {
      return;
    }

    await this.#produce(AudioSource.RADIO);
  }

  /**
   * @param {'proximity'|'radio'} source
   * @returns {Promise<void>}
   */
  async #produce(source) {
    if (!this.isStarted() || this.sendTransport === null) {
      throw new VoiceError('Голосовое соединение не установлено.', 'voice_not_ready');
    }

    if (this.producers.has(source)) {
      return;
    }

    let track;

    try {
      const tracks = this.audio.getTracks();
      track = source === AudioSource.PROXIMITY ? tracks.proximity : tracks.radio;
    } catch {
      throw new VoiceError('Микрофон не запущен.', 'microphone_unavailable');
    }

    if (!track) {
      throw new VoiceError('Микрофон не вернул аудиодорожку.', 'track_missing');
    }

    const producer = await this.sendTransport.produce({
      track,
      appData: { source },
      codecOptions: {
        opusStereo: false,
        opusDtx: false,
        opusFec: true,
        opusMaxPlaybackRate: 48_000,
        // Кадр 10 мс вместо 20 мс: вдвое меньше времени на накопление
        // одного кадра. Приёмник использует то же значение (`minptime: 10`).
        opusPtime: 10,
      },
    });

    this.producers.set(source, producer);

    producer.on('transportclose', () => {
      if (this.producers.get(source) === producer) {
        this.producers.delete(source);
      }
    });

    producer.on('trackended', () => {
      this.onEvent?.({
        type: 'error',
        code: 'track_ended',
        message: 'Аудиодорожка микрофона завершилась. Переподключите микрофон в настройках.',
      });
    });

    this.onEvent?.({ type: 'producer', action: 'created', source });
  }

  /**
   * Закрывает Producer указанного источника.
   *
   * @param {'proximity'|'radio'} source
   * @returns {Promise<void>}
   */
  async #closeProducer(source) {
    const producer = this.producers.get(source);

    if (!producer) {
      return;
    }

    this.producers.delete(source);

    try {
      await this.signaling.request(
        ClientMessageType.VOICE_CLOSE_PRODUCER,
        { producerId: producer.id },
        [ServerMessageType.VOICE_PRODUCER_CLOSED],
        { timeoutMs: 5_000 },
      );
    } catch {
      // Даже если сервер не подтвердил закрытие, локальный ресурс освобождается.
    }

    try {
      producer.close();
    } catch {
      // Producer мог быть уже закрыт транспортом.
    }

    this.onEvent?.({ type: 'producer', action: 'closed', source });
  }

  /**
   * Сообщает серверу о выключении микрофона.
   *
   * @param {boolean} muted
   * @returns {Promise<void>}
   */
  async setMuted(muted) {
    await this.signaling.request(
      ClientMessageType.VOICE_SET_MUTED,
      { muted: muted === true },
      [ServerMessageType.VOICE_MUTED],
      { timeoutMs: 5_000 },
    );
  }

  /**
   * Создаёт Consumer входящего голоса.
   *
   * @param {{consumerId: string, producerId: string, kind: string, rtpParameters: object, source: string, peer?: object}} message
   * @returns {Promise<void>}
   */
  async consume(message) {
    if (!this.isStarted() || this.recvTransport === null) {
      return;
    }

    if (this.consumers.has(message.consumerId)) {
      return;
    }

    let consumer;

    try {
      consumer = await this.recvTransport.consume({
        id: message.consumerId,
        producerId: message.producerId,
        kind: message.kind,
        rtpParameters: message.rtpParameters,
        appData: { source: message.source },
        // Входящий звук должен звучать сразу. По умолчанию браузер держит
        // джиттер-буфер 200–500 мс, что и создаёт ощущение «эха» и задержки.
        onRtpReceiver: (receiver) => {
          if ('jitterBufferTarget' in receiver) {
            receiver.jitterBufferTarget = 0;
          }

          if ('playoutDelayHint' in receiver) {
            receiver.playoutDelayHint = 0;
          }
        },
      });
    } catch (err) {
      this.onEvent?.({
        type: 'error',
        code: 'consume_failed',
        message: 'Не удалось принять входящий голосовой поток.',
        detail: err instanceof Error ? err.message : null,
      });
      return;
    }

    this.consumers.set(message.consumerId, consumer);

    // Транспорт может закрыться или дорожка прерваться без отдельного
    // сообщения сервера: локальные ресурсы всё равно нужно освободить.
    consumer.on('transportclose', () => {
      this.#forgetConsumer(message.consumerId, 'transport_closed');
    });

    consumer.on('trackended', () => {
      this.#forgetConsumer(message.consumerId, 'track_ended');
    });

    this.audio.attachConsumer({
      consumerId: message.consumerId,
      track: consumer.track,
      source: message.source,
    });

    this.onEvent?.({
      type: 'consumer',
      action: 'created',
      source: message.source,
      peer: message.peer ?? null,
      channelId: message.channelId ?? null,
    });
  }

  /**
   * Закрывает Consumer входящего голоса.
   *
   * @param {string} consumerId
   */
  closeConsumer(consumerId) {
    if (!this.#forgetConsumer(consumerId, 'closed')) {
      return;
    }

    this.onEvent?.({ type: 'consumer', action: 'closed', consumerId });
  }

  /**
   * Удаляет Consumer и освобождает связанный элемент вывода.
   *
   * @param {string} consumerId
   * @param {string} reason
   * @returns {boolean} true, если Consumer существовал.
   */
  #forgetConsumer(consumerId, reason) {
    const consumer = this.consumers.get(consumerId);

    if (!consumer) {
      return false;
    }

    this.consumers.delete(consumerId);

    try {
      consumer.close();
    } catch {
      // Consumer мог быть уже закрыт транспортом.
    }

    this.audio.detachConsumer(consumerId);

    if (reason === 'track_ended') {
      this.onEvent?.({
        type: 'error',
        code: 'consumer_track_ended',
        message: 'Входящий голосовой поток прервался. Ожидание нового подключения.',
      });
    }

    return true;
  }

  /** @returns {number} */
  getConsumerCount() {
    return this.consumers.size;
  }

  /** Закрывает транспорты, Producer-ы и Consumer-ы. */
  async close() {
    for (const source of [...this.producers.keys()]) {
      const producer = this.producers.get(source);
      this.producers.delete(source);

      try {
        producer?.close();
      } catch {
        // ignore
      }
    }

    for (const consumerId of [...this.consumers.keys()]) {
      this.closeConsumer(consumerId);
    }

    for (const transport of [this.sendTransport, this.recvTransport]) {
      try {
        transport?.close();
      } catch {
        // ignore
      }
    }

    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;
    this.started = false;
    this.proximityAllowed = false;
    this.closed = true;
  }
}
