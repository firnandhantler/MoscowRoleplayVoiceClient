/**
 * Минимальное хранилище состояния интерфейса.
 *
 * Без внешних зависимостей: приложение небольшое, а полный фреймворк здесь
 * только увеличил бы размер сборки и поверхность атаки.
 */

/**
 * @template T
 * @param {T} initialState
 * @returns {{
 *   get: () => T,
 *   set: (patch: Partial<T>|((state: T) => Partial<T>)) => void,
 *   subscribe: (listener: (state: T) => void) => () => void,
 * }}
 */
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  return {
    get() {
      return state;
    },

    set(patch) {
      const changes = typeof patch === 'function' ? patch(state) : patch;

      state = { ...state, ...changes };

      for (const listener of [...listeners]) {
        listener(state);
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(state);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
