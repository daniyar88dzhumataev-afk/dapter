// Локальный сервер только для проверки во время разработки (без зависимостей).
// Запуск:  node tools/serve.js        (порт 8080)
//          node tools/serve.js 3000   (другой порт)
// Открыть на компьютере: http://localhost:8080
// Открыть с телефона в той же Wi-Fi сети: адрес «Wi-Fi», который покажет сервер.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8080;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Не отдаём служебное и возможные файлы резервных копий с реальными данными
const blocked = (rel) => /^(\.git|tests|tools)([\\/]|$)/.test(rel) || /backup.*\.json$/i.test(rel);

const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(root, pathname);
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || blocked(rel)) {
      res.writeHead(403).end();
      return;
    }
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Дәптер запущен.`);
  console.log(`  На этом компьютере: http://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  С телефона по Wi-Fi: http://${a.address}:${port}`);
    }
  }
  console.log('Остановить: Ctrl+C');
});
