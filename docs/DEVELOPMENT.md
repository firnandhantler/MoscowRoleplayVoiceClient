# Разработка Windows-клиента

Документ описывает устройство и сборку Electron-приложения MoscowRoleplay Voice. Клиент находится в папке `app/` и устанавливается независимо от сервера.

Серверная документация: [../../server/docs/DEVELOPMENT.md](../../server/docs/DEVELOPMENT.md).

## 1. Требования

| Инструмент | Версия |
|---|---|
| Node.js | 22.12 или новее |
| npm | 11.x |
| Git | 2.47 или новее |
| Windows | 10 или новее |

Для реальной проверки голоса нужны микрофон и наушники. Docker и PostgreSQL для сборки клиента не требуются.

Если PowerShell блокирует `npm.ps1`, используйте `npm.cmd`.

## 2. Структура

```text
app/
├── assets/                  # icon.png, icon.ico
├── docs/                    # этот документ
├── electron/
│   ├── main.js              # окно, IPC, жизненный цикл
│   ├── preload.js           # whitelist API для renderer
│   ├── auth.js              # Discord-вход и cookie
│   ├── config.js            # client-config.json
│   ├── http.js              # HTTP главного процесса
│   ├── signaling.js         # WebSocket и переподключение
│   ├── settings.js          # settings.json
│   └── shortcuts.js         # глобальная клавиша радио
├── renderer/
│   ├── index.html
│   ├── styles.css
│   ├── src/
│   │   ├── main.js
│   │   ├── audio/           # захват, устройства, Web Audio
│   │   ├── core/            # store и клавиатура
│   │   ├── mediasoup/       # mediasoup-client
│   │   ├── proximity/       # состояние близости
│   │   ├── radio/           # состояние радиоканалов
│   │   ├── settings/        # контроллер настроек
│   │   ├── signaling/       # протокол и канал
│   │   └── ui/              # DOM и уведомления
│   └── dist/                # сборка esbuild, не коммитится
├── scripts/
│   ├── check-syntax.js
│   ├── check-shared.js
│   └── generate-icon.js
├── shared/                  # копия server/shared/protocol.js
├── release/                 # установщик, не коммитится
├── client-config.example.json
├── package.json
└── package-lock.json
```

`app/shared/protocol.js` — копия общего протокола. Канонический источник находится в `server/shared/protocol.js`; вручную копию не редактируйте.

## 3. Установка и запуск

```powershell
cd app
npm install
npm run check
npm start
```

`npm start` собирает renderer через esbuild и запускает Electron.

Для разработки:

```powershell
npm run dev
```

Команда делает то же самое: сборка renderer и запуск Electron без упаковки.

## 4. Подключение к серверу

В репозитории используется `app/client-config.json` с адресом развёрнутого сервера. Этот файл включается в установщик через `extraResources` и попадает в папку ресурсов приложения.

Порядок поиска адреса:

1. переменные окружения `MVR_SERVER_URL` и `MVR_WS_PATH`;
2. `client-config.json` в `%APPDATA%\MoscowRoleplay Voice\`;
3. `client-config.json` в папке ресурсов установленного приложения;
4. `client-config.json` рядом с приложением в режиме разработки;
5. `http://localhost:3000`.

Текущий `app/client-config.json`:

```json
{
  "serverUrl": "http://201.8.80.121",
  "wsPath": "/ws"
}
```

`client-config.example.json` оставлен как шаблон для другого окружения.

В файле нет секретов: только адрес сервера. Токен сессии хранится в изолированной сессии Electron и недоступен renderer.

Для production используйте HTTPS с доверенным сертификатом. Самоподписанный сертификат вызовет ошибку сети.

## 5. Настройки приложения

Файл: `%APPDATA%\MoscowRoleplay Voice\settings.json`.

Хранятся:

- устройства ввода и вывода;
- усиление микрофона и громкость входящего голоса;
- эхоподавление, шумоподавление, автогромкость;
- режим микрофона: открытый или Push-to-Talk;
- клавиша радио и глобальный режим;
- клавиша proximity;
- приглушение окружения при радиопередаче;
- автоподключение при запуске.

Настройки не удаляются при обновлении или удалении приложения.

## 6. Проверка синтаксиса

```powershell
cd app
npm run check
```

Команда:

1. сравнивает `app/shared/protocol.js` с `server/shared/protocol.js` (если папка сервера есть);
2. проверяет CommonJS-файлы через `node --check`;
3. проверяет ES Modules renderer и shared через `esbuild.transform`.

Если копии протокола различаются:

```powershell
cd server
npm run shared:sync
```

## 7. Сборка установщика

```powershell
cd app
npm run dist
```

Результат:

```text
app\release\MoscowRoleplay-Voice-Setup-0.5.1.exe
```

Другие команды:

```powershell
npm run build      # иконка и renderer
npm run pack       # распакованная сборка без установщика
npm run icon       # только иконки
```

Установщик NSIS:

- не требует прав администратора;
- позволяет выбрать папку установки;
- создаёт ярлыки на рабочем столе и в меню «Пуск»;
- не удаляет `%APPDATA%\MoscowRoleplay Voice` при удалении.

Перед выдачей пользователям:

1. Установите клиент на тестовый ПК.
2. Создайте `%APPDATA%\MoscowRoleplay Voice\client-config.json` с адресом сервера.
3. Проверьте вход через Discord, устройства, микрофон и радиоканалы.
4. Убедитесь, что HTTPS-сертификат доверен Windows.

## 8. Безопасность Electron

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`;
- `webviewTag: false`;
- renderer не получает `require`, `ipcRenderer`, файловую систему и токен;
- preload экспортирует только whitelist IPC-действий;
- главный процесс проверяет источник каждого IPC-вызова;
- внешние переходы и новые окна запрещены;
- разрешён только микрофон для собственного renderer-файла;
- CSP не разрешает внешние источники и прямые сетевые подключения из renderer.

Не добавляйте в renderer доступ к Node.js и не передавайте туда токен сессии.

## 9. Диагностика

| Симптом | Причина | Решение |
|---|---|---|
| `npm.ps1 cannot be loaded` | Политика PowerShell | Используйте `npm.cmd` |
| `ENOTFOUND` или `ECONNREFUSED` | Сервер недоступен | Проверьте `serverUrl`, запуск сервера и порт |
| Клиент не входит | Неверный redirect URI или HTTPS | Проверьте настройки Discord и сертификат |
| Нет микрофона | Нет разрешения Windows | Параметры → Конфиденциальность → Микрофон |
| Нет звука | Выбрано неверное устройство | Проверьте устройства ввода и вывода |
| Ошибка сборки Electron | Повреждены зависимости | Удалите `app/node_modules` и выполните `npm ci` |
| Русский текст искажён | Кодировка консоли | `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` |

Логи клиента не должны содержать токены, cookie и персональные данные.
