/**
 * Renderer не имеет доступа к Node.js.
 * Единственный доступный API — window.moscowRoleplay из preload.js.
 */
async function loadAppInfo() {
  const element = document.querySelector('#app-info');

  if (!element) {
    return;
  }

  if (!window.moscowRoleplay?.getAppInfo) {
    element.textContent = 'Безопасный preload-интерфейс недоступен.';
    return;
  }

  try {
    const info = await window.moscowRoleplay.getAppInfo();
    element.textContent = `Версия ${info.version} · Electron ${info.electron} · Chromium ${info.chrome}`;
  } catch {
    element.textContent = 'Не удалось получить сведения о приложении.';
  }
}

void loadAppInfo();
