// Cache dell'app per l'uso offline. Cambiare VERSIONE a ogni rilascio: l'app propone l'aggiornamento.
const VERSIONE = 'spesa-1.0.0';
const FILE = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/logic.js', 'js/io.js', 'js/parser.js', 'js/off.js', 'js/store.js', 'js/fmt.js', 'js/date.js', 'js/scanner.js',
  'vendor/sql-wasm.js', 'vendor/sql-wasm.wasm', 'vendor/fflate.min.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/zxing.min.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSIONE).then(c => c.addAll(FILE.map(f => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(chiavi => Promise.all(chiavi.filter(k => k !== VERSIONE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;   // Open Food Facts va in rete
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});
