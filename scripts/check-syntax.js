'use strict';

/**
 * Проверка синтаксиса клиентского кода.
 *
 * Electron main/preload и скрипты сборки используют CommonJS, поэтому для них
 * достаточно `node --check`. Renderer написан на ES Modules и импортирует
 * mediasoup-client, поэтому его файлы проверяются парсером esbuild.
 *
 * Запуск: npm run check
 */

const { spawnSync } = require('node:child_process');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMONJS_DIRECTORIES = [
  path.join(ROOT, 'electron'),
  path.join(ROOT, 'scripts'),
];
const ES_MODULE_DIRECTORIES = [
  path.join(ROOT, 'renderer', 'src'),
  path.join(ROOT, 'shared'),
];
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'release', 'build']);

/**
 * Рекурсивно собирает JavaScript-файлы.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function collectJavaScriptFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...collectJavaScriptFiles(fullPath));
      }

      continue;
    }

    if (entry.isFile() && path.extname(entry.name) === '.js') {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Проверяет CommonJS-файл через Node.js.
 *
 * @param {string} file
 * @returns {string|null} Текст ошибки или null.
 */
function checkCommonJs(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });

  if (result.status === 0) {
    return null;
  }

  return result.stderr.trim();
}

async function main() {
  const commonJsFiles = COMMONJS_DIRECTORIES.flatMap((directory) => collectJavaScriptFiles(directory));
  const esModuleFiles = ES_MODULE_DIRECTORIES.flatMap((directory) => collectJavaScriptFiles(directory));

  let failed = 0;

  for (const file of commonJsFiles) {
    const error = checkCommonJs(file);

    if (error !== null) {
      failed += 1;
      console.error(`Синтаксическая ошибка: ${file}`);
      console.error(error);
    }
  }

  if (esModuleFiles.length > 0) {
    const esbuild = require('esbuild');

    for (const file of esModuleFiles) {
      try {
        await esbuild.transform(readFileSync(file, 'utf8'), {
          loader: 'js',
          format: 'esm',
          target: 'es2022',
        });
      } catch (err) {
        failed += 1;
        console.error(`Синтаксическая ошибка: ${file}`);
        console.error(err.message);
      }
    }
  }

  const total = commonJsFiles.length + esModuleFiles.length;

  if (failed > 0) {
    console.error(`Проверка синтаксиса не пройдена: ${failed} файл(ов).`);
    process.exitCode = 1;
    return;
  }

  console.log(`Синтаксис проверен: ${total} файл(ов).`);
}

main().catch((err) => {
  console.error('Не удалось выполнить проверку синтаксиса:', err.message);
  process.exitCode = 1;
});
