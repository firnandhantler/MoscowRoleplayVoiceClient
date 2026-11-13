'use strict';

/**
 * Глобальная клавиша радиосвязи.
 *
 * Electron умеет сообщать только о нажатии глобальной клавиши, но не об её
 * отпускании. Поэтому глобальная клавиша работает как переключатель:
 * нажатие начало передачи, повторное нажатие — завершило.
 * Режим удержания доступен, когда окно клиента активно (см. renderer).
 */

const { globalShortcut } = require('electron');

class ShortcutManager {
  /**
   * @param {{onTrigger: (accelerator: string) => void}} options
   */
  constructor({ onTrigger }) {
    this.onTrigger = onTrigger;
    this.current = null;
  }

  /**
   * Регистрирует клавишу.
   *
   * @param {{accelerator: string|null, enabled: boolean}} options
   * @returns {{registered: boolean, error: {code: string, message: string}|null}}
   */
  apply({ accelerator, enabled }) {
    this.release();

    if (!enabled || typeof accelerator !== 'string' || accelerator === '') {
      return { registered: false, error: null };
    }

    try {
      const registered = globalShortcut.register(accelerator, () => {
        this.onTrigger(accelerator);
      });

      if (!registered) {
        return {
          registered: false,
          error: {
            code: 'shortcut_conflict',
            message: `Клавиша ${accelerator} уже используется другим приложением. Выберите другую.`,
          },
        };
      }

      this.current = accelerator;

      return { registered: true, error: null };
    } catch {
      return {
        registered: false,
        error: {
          code: 'shortcut_invalid',
          message: `Клавиша ${accelerator} не поддерживается как глобальная.`,
        },
      };
    }
  }

  /** Снимает регистрацию текущей клавиши. */
  release() {
    if (this.current === null) {
      return;
    }

    try {
      globalShortcut.unregister(this.current);
    } catch {
      // Клавиша могла быть уже снята системой.
    }

    this.current = null;
  }

  /** Снимает все глобальные клавиши приложения. */
  dispose() {
    this.release();
    globalShortcut.unregisterAll();
  }
}

module.exports = { ShortcutManager };
