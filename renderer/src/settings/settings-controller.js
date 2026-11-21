/**
 * Настройки клиента в renderer.
 *
 * Хранение выполняет главный процесс (settings.json в папке данных приложения).
 * Renderer только запрашивает, меняет и применяет значения к аудиодвижку.
 */

export class SettingsController {
  /**
   * @param {{
   *   bridge: object,
   *   onUpdate: (settings: object) => void,
   *   onError?: ((error: {code: string, message: string}) => void)|null,
   * }} options
   */
  constructor({ bridge, onUpdate, onError = null }) {
    this.bridge = bridge;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.value = null;
  }

  /** Загружает настройки из главного процесса. */
  async load() {
    this.value = await this.bridge.settings.get();
    this.onUpdate(this.value);

    return this.value;
  }

  /** @returns {object} */
  get() {
    return this.value;
  }

  /**
   * Применяет частичное обновление.
   *
   * @param {object} patch
   * @returns {Promise<object>}
   */
  async update(patch) {
    const result = await this.bridge.settings.update(patch);

    this.value = result.settings;

    this.onUpdate(this.value);

    return this.value;
  }

  /** Сбрасывает настройки к значениям по умолчанию. */
  async reset() {
    const result = await this.bridge.settings.reset();

    this.value = result.settings;

    this.onUpdate(this.value);

    return this.value;
  }
}
