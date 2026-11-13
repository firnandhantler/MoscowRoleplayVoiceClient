/**
 * Радиосвязь на клиенте.
 *
 * Режим both-dual: proximity и радио работают одновременно. Клиент лишь
 * отправляет запросы; право на канал, занятость канала и маршрутизацию
 * голоса проверяет сервер по ролям Discord.
 */

import { ClientMessageType, ServerMessageType } from '../signaling/protocol.js';

export class RadioController {
  /**
   * @param {{
   *   signaling: import('../signaling/channel.js').SignalingChannel,
   *   audio: import('../audio/audio-engine.js').AudioEngine,
   *   onUpdate: (state: object) => void,
   *   onError?: ((error: {code: string, message: string}) => void)|null,
   * }} options
   */
  constructor({ signaling, audio, onUpdate, onError = null }) {
    this.signaling = signaling;
    this.audio = audio;
    this.onUpdate = onUpdate;
    this.onError = onError;

    this.enabled = false;
    this.channels = [];
    this.joinedChannelId = null;
    this.transmitting = false;
    this.speaker = null;
    this.pending = false;
    this.selfUserId = null;
  }

  /**
   * Запоминает идентификатор текущего пользователя, чтобы не показывать
   * его самого как «говорящего» в списке участников.
   *
   * @param {string|null} userId
   */
  setSelfUserId(userId) {
    this.selfUserId = typeof userId === 'string' ? userId : null;
  }

  /** @returns {object|null} */
  get joinedChannel() {
    return this.channels.find((channel) => channel.id === this.joinedChannelId) ?? null;
  }

  /**
   * Применяет состояние, полученное от сервера.
   *
   * @param {{enabled: boolean, channels: object[]}} state
   */
  setState(state) {
    if (typeof state !== 'object' || state === null) {
      return;
    }

    this.enabled = state.enabled === true;
    this.channels = Array.isArray(state.channels) ? state.channels : [];

    const joined = this.channels.find((channel) => channel.joined === true) ?? null;
    const nextJoinedId = joined === null ? null : joined.id;

    if (nextJoinedId !== this.joinedChannelId) {
      // Сервер — источник истины: если канал сменился, передача прекращена.
      this.stopLocalTransmission();
    }

    this.joinedChannelId = nextJoinedId;
    this.#emit();
  }

  /**
   * Обрабатывает событие начала/завершения передачи в канале.
   *
   * @param {{channelId: string, speakerUserId: string, speakerName: string, active: boolean}} event
   */
  setTransmission(event) {
    if (typeof event !== 'object' || event === null) {
      return;
    }

    if (event.active === true) {
      // Собственная передача отображается отдельным индикатором, а не строкой
      // «говорит такой-то участник».
      this.speaker =
        event.speakerUserId === this.selfUserId
          ? null
          : { channelId: event.channelId, name: event.speakerName };
    } else if (this.speaker !== null && this.speaker.channelId === event.channelId) {
      this.speaker = null;
    }

    this.#emit();
  }

  /**
   * Входит в радиоканал.
   *
   * @param {string} channelId
   * @returns {Promise<void>}
   */
  async join(channelId) {
    if (this.pending || this.joinedChannelId !== null) {
      return;
    }

    this.pending = true;

    try {
      // Сервер подтверждает вход сообщением server.radio.state с тем же id.
      await this.signaling.request(
        ClientMessageType.RADIO_JOIN,
        { channelId },
        [ServerMessageType.RADIO_STATE],
      );
    } finally {
      this.pending = false;
    }
  }

  /**
   * Покидает текущий радиоканал.
   *
   * @returns {Promise<void>}
   */
  async leave() {
    if (this.joinedChannelId === null) {
      return;
    }

    const channelId = this.joinedChannelId;

    this.stopLocalTransmission();
    await this.signaling.request(
      ClientMessageType.RADIO_LEAVE,
      { channelId },
      [ServerMessageType.RADIO_STATE],
    );
  }

  /**
   * Начинает радиопередачу.
   *
   * @returns {Promise<void>}
   */
  async startTransmission() {
    if (this.transmitting || this.joinedChannelId === null) {
      return;
    }

    const channelId = this.joinedChannelId;

    this.transmitting = true;
    this.audio.setRadioTransmitting(true);
    this.#emit();

    try {
      await this.signaling.request(
        ClientMessageType.RADIO_START_TRANSMISSION,
        { channelId },
        [ServerMessageType.RADIO_STATE],
      );
    } catch (err) {
      this.stopLocalTransmission();
      this.onError?.({
        code: err?.code ?? 'radio_failed',
        message: err instanceof Error ? err.message : 'Не удалось начать радиопередачу.',
      });
    }
  }

  /**
   * Завершает радиопередачу.
   *
   * @returns {Promise<void>}
   */
  async stopTransmission() {
    if (!this.transmitting) {
      return;
    }

    const channelId = this.joinedChannelId;

    this.stopLocalTransmission();

    if (channelId === null) {
      return;
    }

    try {
      await this.signaling.request(
        ClientMessageType.RADIO_STOP_TRANSMISSION,
        { channelId },
        [ServerMessageType.RADIO_STATE],
      );
    } catch {
      // Сервер завершит передачу по тайм-ауту или при отключении.
    }
  }

  /** Переключает передачу (для глобальной клавиши и кнопки). */
  async toggleTransmission() {
    if (this.transmitting) {
      await this.stopTransmission();
    } else {
      await this.startTransmission();
    }
  }

  /** Локально сбрасывает передачу без обращения к серверу. */
  stopLocalTransmission() {
    if (!this.transmitting) {
      return;
    }

    this.transmitting = false;
    this.audio.setRadioTransmitting(false);
    this.#emit();
  }

  /** Полный сброс при потере соединения. */
  reset() {
    this.stopLocalTransmission();
    this.enabled = false;
    this.channels = [];
    this.joinedChannelId = null;
    this.speaker = null;
    this.#emit();
  }

  #emit() {
    this.onUpdate({
      enabled: this.enabled,
      channels: this.channels,
      joinedChannelId: this.joinedChannelId,
      transmitting: this.transmitting,
      speaker: this.speaker,
    });
  }
}
