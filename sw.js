// Дәптер — service worker: хранит файлы приложения на телефоне, чтобы всё работало без интернета.
// Данные покупателей сюда не попадают — они в IndexedDB.
//
// ВАЖНО: при любом изменении файлов приложения увеличьте номер VERSION (dapter-v1 → dapter-v2).
// Тогда телефон скачает новую версию и покажет плашку «Доступна новая версия — Обновить».

const VERSION = 'dapter-v1';

const FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/app.js',
  'js/ledger.js',
  'js/messages.js',
  'js/db.js',
  'js/backup.js',
  'i18n/ru.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' — берём свежие файлы с сервера, а не из кэша браузера
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('dapter-') && key !== VERSION) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

// Новая версия включается только по кнопке «Обновить», чтобы не перезагрузить страницу посреди записи
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      if (req.mode === 'navigate') {
        // Любой адрес приложения открывает index.html (навигация — через #/…)
        return (await cache.match('index.html')) ?? fetch(req);
      }
      return (await cache.match(req, { ignoreSearch: true })) ?? fetch(req);
    })()
  );
});
