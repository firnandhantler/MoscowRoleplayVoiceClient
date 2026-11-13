'use strict';

/**
 * Проверка синхронизации общего протокола.
 *
 * Канонический источник — server/shared/protocol.js.
 * Копия клиента — app/shared/protocol.js.
 *
 * Если папка server отсутствует (клиент собран отдельно), проверка
 * пропускается. Запуск: npm run shared:check.
 */

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const APP_SHARED = path.join(APP_ROOT, 'shared', 'protocol.js');
const SERVER_SHARED = path.join(APP_ROOT, '..', 'server', 'shared', 'protocol.js');

/**
 * @param {string} file
 * @returns {string}
 */
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (!fs.existsSync(SERVER_SHARED)) {
  console.log('server/shared отсутствует: проверка синхронизации пропущена.');
  process.exit(0);
}

if (sha256(APP_SHARED) !== sha256(SERVER_SHARED)) {
  console.error(
    'Копии протокола различаются. Выполните в папке server: npm run shared:sync',
  );
  process.exit(1);
}

console.log('app/shared/protocol.js синхронизирован с server/shared/protocol.js.');
