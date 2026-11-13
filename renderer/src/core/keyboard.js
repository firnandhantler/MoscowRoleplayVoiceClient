/**
 * Работа с клавишами PTT в renderer.
 *
 * Electron-акселераторы (например, `R`, `Control+Shift+R`) не совпадают
 * с `KeyboardEvent.code`, поэтому нужен явный перевод в обе стороны.
 * Глобальные клавиши регистрируются в главном процессе, поэтому формат
 * хранения настроек — именно акселератор.
 */

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/**
 * Переводит событие клавиатуры в акселератор Electron.
 *
 * @param {KeyboardEvent} event
 * @returns {string|null} null, если клавиша не поддерживается.
 */
export function eventToAccelerator(event) {
  const code = event.code ?? '';

  if (code === '' || MODIFIER_KEYS.has(event.key ?? '')) {
    return null;
  }

  let key = null;

  if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3);
  } else if (/^Digit[0-9]$/.test(code)) {
    key = code.slice(5);
  } else if (/^Numpad[0-9]$/.test(code)) {
    key = code.slice(6);
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    key = code;
  }

  if (key === null) {
    return null;
  }

  const parts = [];

  if (event.ctrlKey) {
    parts.push('Control');
  }

  if (event.altKey) {
    parts.push('Alt');
  }

  if (event.shiftKey) {
    parts.push('Shift');
  }

  if (event.metaKey) {
    parts.push('Super');
  }

  parts.push(key);

  return parts.join('+');
}

/**
 * Разбирает акселератор на модификаторы и клавишу.
 *
 * @param {string} accelerator
 * @returns {{control: boolean, alt: boolean, shift: boolean, super: boolean, key: string}|null}
 */
export function parseAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || accelerator === '') {
    return null;
  }

  const parts = accelerator.split('+');
  const key = parts.pop();

  if (typeof key !== 'string' || key === '') {
    return null;
  }

  return {
    control: parts.includes('Control'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    super: parts.includes('Super'),
    key,
  };
}

/**
 * Проверяет, соответствует ли событие клавиатуры акселератору.
 *
 * @param {KeyboardEvent} event
 * @param {string} accelerator
 * @returns {boolean}
 */
export function eventMatchesAccelerator(event, accelerator) {
  const parsed = parseAccelerator(accelerator);

  if (parsed === null) {
    return false;
  }

  if (event.ctrlKey !== parsed.control || event.altKey !== parsed.alt) {
    return false;
  }

  if (event.shiftKey !== parsed.shift || event.metaKey !== parsed.super) {
    return false;
  }

  const code = event.code ?? '';

  if (/^[A-Z]$/.test(parsed.key)) {
    return code === `Key${parsed.key}`;
  }

  if (/^[0-9]$/.test(parsed.key)) {
    return code === `Digit${parsed.key}` || code === `Numpad${parsed.key}`;
  }

  return code === parsed.key;
}

/**
 * Превращает акселератор в читаемую подпись.
 *
 * @param {string} accelerator
 * @returns {string}
 */
export function formatAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || accelerator === '') {
    return '—';
  }

  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'Control') {
        return 'Ctrl';
      }

      if (part === 'Super') {
        return 'Win';
      }

      return part;
    })
    .join(' + ');
}
