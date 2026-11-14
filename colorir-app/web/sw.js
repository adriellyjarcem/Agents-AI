// Guarda os arquivos do app no aparelho para ele abrir sem internet.
// Ao publicar uma versão nova, mude o número abaixo.
var CACHE = 'colorir-pdf-v1';
var FILES = ['./', 'index.html', 'style.css', 'app.js', 'palette.js', 'manifest.webmanifest',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// responde do aparelho na hora e atualiza a cópia em segundo plano
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) { if (res && res.ok) c.put(req, res.clone()); return res; });
      if (hit) { net.catch(function () {}); return hit; }
      return net;
    });
  }));
});
