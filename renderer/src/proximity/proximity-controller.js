/**
 * Состояние голоса по близости на клиенте.
 *
 * Клиент не вычисляет расстояния и не решает, кого слышно. Он только:
 * - знает, находится ли игрок в игре (по данным сервера);
 * - создаёт или закрывает свой proximity Producer;
 * - показывает число слышимых игроков, которое посчитал сервер.
 */

export class ProximityController {
  /**
   * @param {{
   *   voice: import('../mediasoup/voice-client.js').VoiceClient,
   *   onUpdate: (state: object) => void,
   *   onError?: ((error: {code: string, message: string}) => void)|null,
   * }} options
   */
  constructor({ voice, onUpdate, onError = null }) {
    this.voice = voice;
    this.onUpdate = onUpdate;
    this.onError = onError;

    this.inGame = false;
    this.linked = false;
    this.stale = false;
    this.player = null;
    this.nearbyCount = 0;
    this.maxDistance = null;
    this.hysteresis = null;
    this.producerActive = false;
  }

  /**
   * Применяет игровое состояние, полученное от сервера.
   *
   * @param {{linked?: boolean, inGame?: boolean, stale?: boolean, player?: object|null}} game
   * @returns {Promise<void>}
   */
  async applyGameState(game) {
    if (typeof game !== 'object' || game === null) {
      return;
    }

    this.linked = game.linked === true;
    this.inGame = game.inGame === true;
    this.stale = game.stale === true;
    this.player = game.player ?? null;

    if (!this.inGame) {
      this.nearbyCount = 0;
    }

    this.#emit();
    await this.syncProducer();
  }

  /**
   * @param {{maxDistance: number, hysteresis: number}} config
   */
  applyConfig(config) {
    if (typeof config !== 'object' || config === null) {
      return;
    }

    this.maxDistance = Number.isFinite(config.maxDistance) ? config.maxDistance : null;
    this.hysteresis = Number.isFinite(config.hysteresis) ? config.hysteresis : null;
    this.#emit();
  }

  /**
   * @param {number} count
   */
  setNearbyCount(count) {
    this.nearbyCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    this.#emit();
  }

  /**
   * Сбрасывает признак созданного Producer.
   * Нужно после пересоздания голосового соединения.
   */
  invalidateProducer() {
    this.producerActive = false;
  }

  /** Приводит Producer в соответствие с игровым состоянием. */
  async syncProducer() {
    const shouldProduce = this.inGame && this.voice.isStarted();

    if (shouldProduce === this.producerActive) {
      return;
    }

    try {
      if (shouldProduce) {
        await this.voice.setProximityAllowed(true);
        this.producerActive = true;
      } else {
        await this.voice.setProximityAllowed(false);
        this.producerActive = false;
      }
    } catch (err) {
      this.onError?.({
        code: err?.code ?? 'proximity_failed',
        message: err instanceof Error ? err.message : 'Не удалось включить голос по близости.',
      });
    }
  }

  /** Сбрасывает состояние при отключении от сервера. */
  reset() {
    this.inGame = false;
    this.player = null;
    this.nearbyCount = 0;
    this.producerActive = false;
    this.#emit();
  }

  #emit() {
    this.onUpdate({
      linked: this.linked,
      inGame: this.inGame,
      stale: this.stale,
      player: this.player,
      nearbyCount: this.nearbyCount,
      maxDistance: this.maxDistance,
      hysteresis: this.hysteresis,
      producerActive: this.producerActive,
    });
  }
}
