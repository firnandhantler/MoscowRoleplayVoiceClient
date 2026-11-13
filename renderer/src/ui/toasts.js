/**
 * Всплывающие уведомления.
 *
 * Уведомления не блокируют работу и исчезают сами. Одинаковые сообщения
 * подряд не дублируются — иначе при потере связи экран заполняется копиями.
 */

const VISIBLE_MS = 6_000;
const MAX_TOASTS = 4;

/** @type {Set<string>} */
const visibleMessages = new Set();

/**
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 */
export function showToast(message, type = 'info') {
  const container = document.getElementById('toasts');

  if (!container || typeof message !== 'string' || message.trim() === '') {
    return;
  }

  const key = `${type}:${message}`;

  if (visibleMessages.has(key)) {
    return;
  }

  visibleMessages.add(key);

  const element = document.createElement('div');

  element.className = `toast toast--${type}`;
  element.textContent = message;
  container.appendChild(element);

  while (container.children.length > MAX_TOASTS) {
    container.removeChild(container.firstElementChild);
  }

  window.setTimeout(() => {
    visibleMessages.delete(key);
    element.remove();
  }, VISIBLE_MS);
}
