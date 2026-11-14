'use strict';
(function () {
  // ---------------------------------------------------------------- utilidades
  var $ = function (s, r) { return (r || document).querySelector(s); };
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function icon(name) { return '<svg class="ic"><use href="#i-' + name + '"/></svg>'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  var hasAndroid = typeof window.Android !== 'undefined';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  var toastTimer;
  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }
  function busy(msg) { $('#busy-text').textContent = msg || ''; $('#busy').hidden = false; }
  function idle() { $('#busy').hidden = true; }

  // modal simples: retorna o valor do botão escolhido (ou null)
  var modalClose = null;
  function modal(opts) {
    return new Promise(function (resolve) {
      $('#modal-title').textContent = opts.title || '';
      $('#modal-text').textContent = opts.text || '';
      $('#modal-text').hidden = !opts.text;
      var inp = $('#modal-input');
      inp.hidden = opts.input == null;
      if (opts.input != null) inp.value = opts.input;
      var box = $('#modal-btns'); box.innerHTML = '';
      function done(v) { $('#modal').hidden = true; modalClose = null; resolve(v); }
      opts.buttons.forEach(function (b) {
        var btn = el('button', b.cls || '', esc(b.label));
        btn.onclick = function () { done(b.value === '$input' ? inp.value.trim() : b.value); };
        box.appendChild(btn);
      });
      modalClose = function () { done(null); };
      $('#modal').hidden = false;
      if (opts.input != null) setTimeout(function () { inp.focus(); inp.select(); }, 50);
    });
  }
  $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal' && modalClose) modalClose(); });

  function canvasToBuf(canvas, type, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error('toBlob falhou'));
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error); };
        fr.readAsArrayBuffer(blob);
      }, type, q);
    });
  }
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }
  var liveUrls = { library: [], book: [] };
  function bufUrl(group, buf, type) {
    var u = URL.createObjectURL(new Blob([buf], { type: type }));
    liveUrls[group].push(u); return u;
  }
  function freeUrls(group) { liveUrls[group].forEach(function (u) { URL.revokeObjectURL(u); }); liveUrls[group] = []; }
  function loadImage(buf, type) {
    return new Promise(function (resolve, reject) {
      var u = URL.createObjectURL(new Blob([buf], { type: type }));
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(u); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(u); reject(new Error('imagem inválida')); };
      img.src = u;
    });
  }

  // ---------------------------------------------------------------- banco (IndexedDB)
  var DB = {
    _p: null,
    open: function () {
      if (!this._p) this._p = new Promise(function (res, rej) {
        var r = indexedDB.open('colorir-pdf', 1);
        r.onupgradeneeded = function () {
          var d = r.result;
          d.createObjectStore('books', { keyPath: 'id' });
          d.createObjectStore('pdfs');    // id -> ArrayBuffer do PDF
          d.createObjectStore('paints');  // [id, pág] -> PNG da camada de tinta
          d.createObjectStore('thumbs');  // [id, pág] -> { buf (JPEG), painted }
          d.createObjectStore('kv');
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return this._p;
    },
    run: function (stores, mode, fn) {
      return this.open().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(stores, mode), out;
          t.oncomplete = function () { res(out); };
          t.onerror = function () { rej(t.error); };
          t.onabort = function () { rej(t.error || new Error('transação abortada')); };
          fn(t, function (v) { out = v; });
        });
      });
    },
    get: function (store, key) {
      return this.run(store, 'readonly', function (t, set) {
        var r = t.objectStore(store).get(key); r.onsuccess = function () { set(r.result); };
      });
    },
    put: function (store, val, key) {
      return this.run(store, 'readwrite', function (t) {
        if (key === undefined) t.objectStore(store).put(val); else t.objectStore(store).put(val, key);
      });
    },
    all: function (store) {
      return this.run(store, 'readonly', function (t, set) {
        var r = t.objectStore(store).getAll(); r.onsuccess = function () { set(r.result); };
      });
    },
    // todos os registros de um livro numa store com chave [id, pág] -> { pág: valor }
    ofBook: function (store, id) {
      return this.run(store, 'readonly', function (t, set) {
        var out = {}; set(out);
        var r = t.objectStore(store).openCursor(IDBKeyRange.bound([id, 0], [id, 1e9]));
        r.onsuccess = function () { var c = r.result; if (c) { out[c.key[1]] = c.value; c.continue(); } };
      });
    }
  };
  function kvGet(k, def) { return DB.get('kv', k).then(function (v) { return v === undefined ? def : v; }, function () { return def; }); }
  function kvSet(k, v) { return DB.put('kv', v, k).catch(function () {}); }

  // ---------------------------------------------------------------- PDF
  function openPdf(buf) { return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise; }
  function renderPage(pdf, n, maxSide) {
    return pdf.getPage(n).then(function (page) {
      var vp0 = page.getViewport({ scale: 1 });
      var vp = page.getViewport({ scale: maxSide / Math.max(vp0.width, vp0.height) });
      var c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () { page.cleanup(); return c; });
    });
  }

  // ---------------------------------------------------------------- navegação
  var state = { view: 'library', book: null, pdf: null, sort: 'added' };
  function show(view) {
    state.view = view;
    ['library', 'book', 'paint'].forEach(function (v) { $('#view-' + v).classList.toggle('active', v === view); });
  }
  function goBack() {
    if (modalClose) { modalClose(); return true; }
    if (!$('#busy').hidden) return true;
    if (state.view === 'paint') {
      if (!$('#sheet').hidden) { $('#sheet').hidden = true; return true; }
      leavePaint(); return true;
    }
    if (state.view === 'book') { closeBook(); return true; }
    return false;
  }
  window.onAndroidBack = goBack;
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act="back"]');
    if (b) goBack();
  });

  // ---------------------------------------------------------------- estante
  function paintedCount(b) { return b.painted ? Object.keys(b.painted).length : 0; }
  function renderLibrary() {
    return DB.all('books').then(function (books) {
      var s = state.sort;
      books.sort(function (a, b) {
        if (s === 'name') return a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' });
        if (s === 'opened') return (b.openedAt || 0) - (a.openedAt || 0) || b.addedAt - a.addedAt;
        return b.addedAt - a.addedAt;
      });
      var shelf = $('#shelf'); shelf.innerHTML = ''; freeUrls('library');
      $('#empty').hidden = books.length > 0;
      books.forEach(function (b) {
        var done = paintedCount(b);
        var card = el('div', 'card');
        card.innerHTML =
          '<img class="cover" alt="">' +
          '<div class="meta"><div class="title">' + esc(b.name) + '</div>' +
          '<div class="sub">' + (done ? done + ' de ' + b.pageCount + ' pintadas' : b.pageCount + ' páginas') + '</div>' +
          '<div class="progress"><i style="width:' + Math.round(100 * done / b.pageCount) + '%"></i></div></div>' +
          '<button class="more" aria-label="Opções">' + icon('more') + '</button>';
        if (b.cover) $('.cover', card).src = bufUrl('library', b.cover, 'image/jpeg');
        card.addEventListener('click', function (e) {
          if (e.target.closest('.more')) bookMenu(b); else openBook(b.id);
        });
        shelf.appendChild(card);
      });
    });
  }
  function bookMenu(b) {
    modal({
      title: b.name, buttons: [
        { label: 'Renomear', value: 'ren' },
        { label: 'Excluir da estante', value: 'del', cls: 'danger' },
        { label: 'Cancelar', value: null }]
    }).then(function (v) {
      if (v === 'ren') {
        return modal({
          title: 'Renomear', input: b.name, buttons: [
            { label: 'Salvar', value: '$input', cls: 'primary' }, { label: 'Cancelar', value: null }]
        }).then(function (name) {
          if (!name) return;
          b.name = name; return DB.put('books', b).then(renderLibrary);
        });
      }
      if (v === 'del') {
        return modal({
          title: 'Excluir "' + b.name + '"?', text: 'O PDF e todas as pinturas deste livro serão apagados do app.',
          buttons: [{ label: 'Excluir', value: true, cls: 'danger' }, { label: 'Cancelar', value: null }]
        }).then(function (ok) {
          if (!ok) return;
          var range = IDBKeyRange.bound([b.id, 0], [b.id, 1e9]);
          return DB.run(['books', 'pdfs', 'paints', 'thumbs'], 'readwrite', function (t) {
            t.objectStore('books').delete(b.id); t.objectStore('pdfs').delete(b.id);
            t.objectStore('paints').delete(range); t.objectStore('thumbs').delete(range);
          }).then(renderLibrary);
        });
      }
    });
  }

  function niceName(fileName) {
    var n = String(fileName || '').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return n || 'Livro sem nome';
  }
  function importFiles(files) {
    var list = Array.prototype.slice.call(files), ok = 0, fail = 0;
    var chain = Promise.resolve();
    list.forEach(function (f, i) {
      chain = chain.then(function () {
        busy('Importando ' + (list.length > 1 ? (i + 1) + ' de ' + list.length + ': ' : '') + niceName(f.name) + '…');
        var buf, pdf;
        return readFile(f).then(function (b) {
          buf = b;
          return openPdf(buf.slice(0));
        }).then(function (p) {
          pdf = p; return renderPage(pdf, 1, 640);
        }).then(function (c) {
          return canvasToBuf(c, 'image/jpeg', 0.85);
        }).then(function (cover) {
          var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          var book = { id: id, name: niceName(f.name), addedAt: Date.now(), openedAt: 0, pageCount: pdf.numPages, cover: cover, painted: {} };
          return DB.run(['books', 'pdfs', 'thumbs'], 'readwrite', function (t) {
            t.objectStore('pdfs').put(buf, id);
            t.objectStore('books').put(book);
            t.objectStore('thumbs').put({ buf: cover, painted: false }, [id, 1]);
          });
        }).then(function () { ok++; }, function (err) {
          console.error(err); fail++;
        }).then(function () { if (pdf) pdf.destroy(); });
      });
    });
    return chain.then(function () {
      idle();
      if (fail) toast(fail === 1 && !ok ? 'Não consegui abrir esse PDF.' : fail + ' arquivo(s) não puderam ser abertos.', 3500);
      else toast(ok > 1 ? ok + ' livros adicionados!' : 'Livro adicionado!');
      return renderLibrary();
    });
  }
  $('#add').onclick = function () { $('#file').click(); };
  $('#file').onchange = function () {
    var files = this.files;
    if (files && files.length) importFiles(files);
    this.value = '';
  };
  $('#sort').onchange = function () { state.sort = this.value; kvSet('sort', state.sort); renderLibrary(); };

  // ---------------------------------------------------------------- páginas do livro
  var thumbJob = 0;
  function openBook(id) {
    busy('Abrindo…');
    return DB.get('books', id).then(function (b) {
      state.book = b;
      return DB.get('pdfs', id);
    }).then(function (buf) { return openPdf(buf); }).then(function (pdf) {
      state.pdf = pdf;
      state.book.openedAt = Date.now();
      DB.put('books', state.book);
      $('#pages').innerHTML = '';
      show('book');
      $('#view-book .scroll').scrollTop = 0;
      return renderBook();
    }).then(idle, function (err) {
      console.error(err); idle(); toast('Não consegui abrir este livro.');
    });
  }
  function closeBook() {
    thumbJob++;
    if (state.pdf) { state.pdf.destroy(); state.pdf = null; }
    state.book = null; freeUrls('book');
    show('library'); renderLibrary();
  }
  function renderBook() {
    var b = state.book, job = ++thumbJob;
    $('#book-title').textContent = b.name;
    var done = paintedCount(b);
    $('#book-progress').textContent = done + '/' + b.pageCount;
    return DB.ofBook('thumbs', b.id).then(function (thumbs) {
      if (job !== thumbJob) return;
      var grid = $('#pages'); grid.innerHTML = ''; freeUrls('book');
      var missing = [];
      for (var n = 1; n <= b.pageCount; n++) (function (n) {
        var cell = el('button', 'page');
        cell.innerHTML = '<img alt=""><span class="num">' + n + '</span>';
        var t = thumbs[n];
        if (t) {
          $('img', cell).src = bufUrl('book', t.buf, 'image/jpeg');
          if (t.painted) cell.appendChild(el('span', 'done'));
        } else { cell.classList.add('loading'); missing.push({ n: n, cell: cell }); }
        cell.onclick = function () { openPage(n); };
        grid.appendChild(cell);
      })(n);
      makeThumbs(missing, job);
    });
  }
  // gera miniaturas que faltam, uma por vez, enquanto a tela do livro estiver aberta
  function makeThumbs(list, job) {
    var b = state.book, pdf = state.pdf, i = 0;
    function next() {
      if (job !== thumbJob || state.view !== 'book' || i >= list.length) return;
      var it = list[i++];
      renderPage(pdf, it.n, 360).then(function (c) { return canvasToBuf(c, 'image/jpeg', 0.8); }).then(function (buf) {
        if (job !== thumbJob) return;
        DB.put('thumbs', { buf: buf, painted: false }, [b.id, it.n]);
        $('img', it.cell).src = bufUrl('book', buf, 'image/jpeg');
        it.cell.classList.remove('loading');
      }).catch(function (e) { console.error(e); }).then(next);
    }
    next();
  }

  // ---------------------------------------------------------------- pintura
  var TOOLS = [
    { id: 'pen', name: 'Caneta', icon: 'pen', size: 8, op: 100, kind: 'path' },
    { id: 'marker', name: 'Marcador', icon: 'marker', size: 34, op: 55, kind: 'path' },
    { id: 'pencil', name: 'Lápis', icon: 'pencil', size: 6, op: 90, kind: 'path', grain: 'fine' },
    { id: 'crayon', name: 'Giz', icon: 'crayon', size: 24, op: 100, kind: 'path', grain: 'coarse' },
    { id: 'water', name: 'Aquarela', icon: 'water', size: 60, op: 60, kind: 'stamp' },
    { id: 'spray', name: 'Spray', icon: 'spray', size: 70, op: 100, kind: 'stamp' },
    { id: 'glitter', name: 'Glitter', icon: 'glitter', size: 46, op: 100, kind: 'stamp' },
    { id: 'fill', name: 'Balde', icon: 'fill', op: 100, kind: 'tap' },
    { id: 'eraser', name: 'Borracha', icon: 'eraser', size: 40, kind: 'path' },
    { id: 'pick', name: 'Pegar cor', icon: 'pick', kind: 'tap' }
  ];
  var TOOL = {}; TOOLS.forEach(function (t) { TOOL[t.id] = t; });

  var cfg = { tool: 'pen', color: '#ff7ac0', sizes: {}, ops: {}, recents: [] };
  TOOLS.forEach(function (t) { if (t.size) cfg.sizes[t.id] = t.size; if (t.op) cfg.ops[t.id] = t.op; });
  var saveCfgTimer;
  function saveCfg() { clearTimeout(saveCfgTimer); saveCfgTimer = setTimeout(function () { kvSet('cfg', cfg); }, 400); }

  var stage = $('#stage'), board = $('#board');
  var cPaint = $('#c-paint'), cStroke = $('#c-stroke'), cLines = $('#c-lines');
  var pctx = cPaint.getContext('2d'), sctx = cStroke.getContext('2d'), lctx = cLines.getContext('2d');
  var P = { n: 0, W: 0, H: 0, lineA: null, undo: [], redo: [], undoBytes: 0, dirty: false, saving: Promise.resolve(), timer: 0 };
  var view = { s: 1, x: 0, y: 0, fit: 1 };
  var MAX_SIDE = (navigator.deviceMemory && navigator.deviceMemory <= 2) ? 1400 : 1800;
  var LINE_TH = 80;        // opacidade de traço a partir da qual o balde para
  var UNDO_MAX = 30, UNDO_BYTES = 90e6;

  // --- UI de ferramentas
  (function buildTools() {
    var box = $('#tools');
    TOOLS.forEach(function (t) {
      var b = el('button', 'tool', icon(t.icon) + '<span>' + t.name + '</span>');
      b.dataset.tool = t.id;
      b.onclick = function () { setTool(t.id); };
      box.appendChild(b);
    });
  })();
  function setTool(id) {
    if (!TOOL[id]) id = 'pen';
    cfg.tool = id;
    Array.prototype.forEach.call($('#tools').children, function (b) {
      b.classList.toggle('active', b.dataset.tool === id);
      if (b.dataset.tool === id && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    var hasSize = cfg.sizes[id] != null, hasOp = cfg.ops[id] != null;
    $('#size').parentNode.classList.toggle('off', !hasSize); $('#size').disabled = !hasSize;
    $('#opacity').parentNode.classList.toggle('off', !hasOp); $('#opacity').disabled = !hasOp;
    if (hasSize) { $('#size').value = cfg.sizes[id]; $('#size-out').textContent = cfg.sizes[id]; } else $('#size-out').textContent = '';
    if (hasOp) { $('#opacity').value = cfg.ops[id]; $('#op-out').textContent = cfg.ops[id] + '%'; } else $('#op-out').textContent = '';
    saveCfg();
  }
  $('#size').oninput = function () { cfg.sizes[cfg.tool] = +this.value; $('#size-out').textContent = this.value; saveCfg(); };
  $('#opacity').oninput = function () { cfg.ops[cfg.tool] = +this.value; $('#op-out').textContent = this.value + '%'; saveCfg(); };

  // --- cores
  function hexToRgb(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
  function rgbToHex(r, g, b) { return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1); }
  function hsvToRgb(h, s, v) {
    var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return [h, mx ? d / mx : 0, mx];
  }
  function setColor(hex, keepTool) {
    cfg.color = hex.toLowerCase();
    $('#cur-color').style.background = cfg.color;
    if (!keepTool && (cfg.tool === 'eraser' || cfg.tool === 'pick')) setTool(lastBrush);
    saveCfg();
  }
  var lastBrush = 'pen';
  function useColor() { // registra a cor atual nas recentes
    var c = cfg.color, r = cfg.recents, i = r.indexOf(c);
    if (i === 0) return;
    if (i > 0) r.splice(i, 1);
    r.unshift(c); if (r.length > 16) r.length = 16;
    renderRecents(); saveCfg();
  }
  function renderRecents() {
    var box = $('#recents'); box.innerHTML = '';
    cfg.recents.forEach(function (c) {
      var b = el('button'); b.style.background = c; b.dataset.c = c; box.appendChild(b);
    });
  }
  $('#recents').onclick = function (e) { if (e.target.dataset.c) setColor(e.target.dataset.c); };

  // folha da paleta
  var swBuilt = false, mix = { h: 320, s: 0.5, v: 1 };
  function openSheet() {
    if (!swBuilt) {
      var box = $('#swatches'), frag = document.createDocumentFragment();
      (window.PALETA || []).forEach(function (c) { var b = el('button'); b.style.background = c; b.dataset.c = c; frag.appendChild(b); });
      box.appendChild(frag); swBuilt = true;
    }
    var rgb = hexToRgb(cfg.color), hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    mix = { h: hsv[1] ? hsv[0] : mix.h, s: hsv[1], v: hsv[2] };
    $('#hue').value = Math.round(mix.h);
    $('#sheet').hidden = false;
    drawMix();
  }
  $('#cur-color').onclick = openSheet;
  $('#open-palette').onclick = openSheet;
  $('#close-sheet').onclick = function () { $('#sheet').hidden = true; };
  $('#swatches').onclick = function (e) { if (e.target.dataset.c) { setColor(e.target.dataset.c); $('#sheet').hidden = true; } };
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (o) { o.classList.toggle('active', o === t); });
      $('#tab-pal').hidden = t.dataset.tab !== 'pal'; $('#tab-mix').hidden = t.dataset.tab !== 'mix';
      if (t.dataset.tab === 'mix') drawMix();
    };
  });
  function mixHex() { var c = hsvToRgb(mix.h, mix.s, mix.v); return rgbToHex(c[0], c[1], c[2]); }
  function drawMix(skipHex) {
    var c = $('#sv'), g = c.getContext('2d'), w = c.width, h = c.height;
    var pure = hsvToRgb(mix.h, 1, 1);
    g.fillStyle = 'rgb(' + pure.join(',') + ')'; g.fillRect(0, 0, w, h);
    var gw = g.createLinearGradient(0, 0, w, 0); gw.addColorStop(0, '#fff'); gw.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gw; g.fillRect(0, 0, w, h);
    var gb = g.createLinearGradient(0, 0, 0, h); gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, '#000');
    g.fillStyle = gb; g.fillRect(0, 0, w, h);
    var x = mix.s * w, y = (1 - mix.v) * h;
    g.lineWidth = 2; g.strokeStyle = '#fff'; g.beginPath(); g.arc(x, y, 8, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.beginPath(); g.arc(x, y, 9.5, 0, 7); g.stroke();
    var hex = mixHex();
    $('#mix-preview').style.background = hex;
    if (!skipHex) $('#hex').value = hex;
  }
  (function () {
    var sv = $('#sv');
    function pick(e) {
      var r = sv.getBoundingClientRect();
      mix.s = clamp((e.clientX - r.left) / r.width, 0, 1);
      mix.v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
      drawMix();
    }
    sv.addEventListener('pointerdown', function (e) { sv.setPointerCapture(e.pointerId); pick(e); });
    sv.addEventListener('pointermove', function (e) { if (e.buttons || e.pointerType === 'touch') pick(e); });
    $('#hue').oninput = function () { mix.h = +this.value; drawMix(); };
    $('#hex').oninput = function () {
      var v = this.value.trim(); if (v[0] !== '#') v = '#' + v;
      if (/^#[0-9a-f]{6}$/i.test(v)) {
        var c = hexToRgb(v), hsv = rgbToHsv(c[0], c[1], c[2]);
        mix = { h: hsv[1] ? hsv[0] : mix.h, s: hsv[1], v: hsv[2] }; $('#hue').value = Math.round(mix.h); drawMix(true);
      }
    };
    $('#use-mix').onclick = function () { setColor(mixHex()); $('#sheet').hidden = true; };
  })();

  // --- abrir / fechar página
  function openPage(n) {
    var b = state.book;
    busy('Preparando a página…');
    return flushSave().then(function () {
      return renderPage(state.pdf, n, MAX_SIDE);
    }).then(function (src) {
      var W = src.width, H = src.height;
      P.n = n; P.W = W; P.H = H; P.undo = []; P.redo = []; P.undoBytes = 0; P.dirty = false;
      [cPaint, cStroke, cLines].forEach(function (c) { c.width = W; c.height = H; });
      board.style.width = W + 'px'; board.style.height = H + 'px';
      prepareLines(src);
      src.width = src.height = 0;
      return DB.get('paints', [b.id, n]);
    }).then(function (buf) {
      if (!buf) return;
      return loadImage(buf, 'image/png').then(function (img) { pctx.drawImage(img, 0, 0, P.W, P.H); });
    }).then(function () {
      $('#page-label').textContent = n + ' / ' + b.pageCount;
      $('#prev').disabled = n <= 1; $('#next').disabled = n >= b.pageCount;
      $('#sheet').hidden = true;
      show('paint'); fitView(); updateUndoUi(); idle();
    }).catch(function (err) {
      console.error(err); idle(); toast('Não consegui abrir esta página.');
    });
  }
  // Converte a página em "traço sobre transparente": o branco do papel vira transparente e o
  // escuro vira opaco, de modo que a tinta fica por baixo das linhas. Guarda o mapa de linhas
  // usado pelo balde.
  function prepareLines(src) {
    var W = P.W, H = P.H;
    var img = src.getContext('2d').getImageData(0, 0, W, H), d = img.data;
    var la = new Uint8Array(W * H);
    var lut = new Uint8Array(256);
    for (var v = 0; v < 256; v++) lut[v] = clamp(Math.round((v - 16) * 255 / (226 - 16)), 0, 255); // limpa o cinza do escaneado
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      var r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
      var m = r < g ? (r < b ? r : b) : (g < b ? g : b), a = 255 - m;
      if (a === 0) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
      else { var k = 255 / a; d[i] = (r - m) * k; d[i + 1] = (g - m) * k; d[i + 2] = (b - m) * k; d[i + 3] = a; }
      la[p] = a;
    }
    lctx.putImageData(img, 0, 0);
    P.lineA = la;
  }
  function leavePaint() {
    cancelStroke();
    busy('Salvando…');
    flushSave().then(function () {
      show('book'); idle();
      P.lineA = null; P.undo = []; P.redo = [];
      [cPaint, cStroke, cLines].forEach(function (c) { c.width = c.height = 1; });
      renderBook();
    });
  }
  $('#prev').onclick = function () { if (P.n > 1) openPage(P.n - 1); };
  $('#next').onclick = function () { if (P.n < state.book.pageCount) openPage(P.n + 1); };

  // --- salvar automático
  function compose(maxSide) {
    var k = maxSide ? Math.min(1, maxSide / Math.max(P.W, P.H)) : 1;
    var c = document.createElement('canvas'); c.width = Math.round(P.W * k); c.height = Math.round(P.H * k);
    var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(cPaint, 0, 0, c.width, c.height); g.drawImage(cLines, 0, 0, c.width, c.height);
    return c;
  }
  function touched() { P.dirty = true; clearTimeout(P.timer); P.timer = setTimeout(saveNow, 1200); }
  function saveNow() {
    clearTimeout(P.timer);
    if (!P.dirty || !state.book) return P.saving;
    P.dirty = false;
    var b = state.book, n = P.n;
    // as cópias são tiradas agora (síncrono), antes de qualquer troca de página
    var pPaint = canvasToBuf(cPaint, 'image/png'), pThumb = canvasToBuf(compose(360), 'image/jpeg', 0.82);
    P.saving = P.saving.then(function () { return Promise.all([pPaint, pThumb]); }).then(function (r) {
      if (!b.painted) b.painted = {};
      b.painted[n] = 1;
      return DB.run(['paints', 'thumbs', 'books'], 'readwrite', function (t) {
        t.objectStore('paints').put(r[0], [b.id, n]);
        t.objectStore('thumbs').put({ buf: r[1], painted: true }, [b.id, n]);
        t.objectStore('books').put(b);
      });
    }).catch(function (e) { console.error(e); toast('Não consegui salvar. Verifique o espaço livre do aparelho.', 4000); });
    return P.saving;
  }
  function flushSave() { return saveNow() || Promise.resolve(); }
  window.__flush = function () { if (state.view === 'paint') saveNow(); };
  document.addEventListener('visibilitychange', function () { if (document.hidden) window.__flush(); });

  // --- desfazer / refazer (guarda só o retângulo alterado)
  function box(x0, y0, x1, y1) {
    x0 = clamp(Math.floor(x0), 0, P.W); y0 = clamp(Math.floor(y0), 0, P.H);
    x1 = clamp(Math.ceil(x1), 0, P.W); y1 = clamp(Math.ceil(y1), 0, P.H);
    return (x1 > x0 && y1 > y0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
  function pushUndo(b, before) {
    P.undo.push({ b: b, data: before }); P.undoBytes += before.data.length;
    P.redo = [];
    while (P.undo.length > UNDO_MAX || (P.undoBytes > UNDO_BYTES && P.undo.length > 1)) P.undoBytes -= P.undo.shift().data.data.length;
    updateUndoUi(); touched();
  }
  function swap(from, to) {
    var e = from.pop(); if (!e) return;
    var cur = pctx.getImageData(e.b.x, e.b.y, e.b.w, e.b.h);
    pctx.putImageData(e.data, e.b.x, e.b.y);
    to.push({ b: e.b, data: cur });
    updateUndoUi(); touched();
  }
  function updateUndoUi() { $('#undo').disabled = !P.undo.length; $('#redo').disabled = !P.redo.length; }
  $('#undo').onclick = function () { if (P.undo.length) { P.undoBytes -= P.undo[P.undo.length - 1].data.data.length; swap(P.undo, P.redo); } };
  $('#redo').onclick = function () { if (P.redo.length) { P.undoBytes += P.redo[P.redo.length - 1].data.data.length; swap(P.redo, P.undo); } };
  $('#clear').onclick = function () {
    modal({
      title: 'Limpar esta página?', text: 'Toda a tinta desta página será removida. Dá para desfazer logo em seguida.',
      buttons: [{ label: 'Limpar', value: true, cls: 'danger' }, { label: 'Cancelar', value: null }]
    }).then(function (ok) {
      if (!ok) return;
      var b = box(0, 0, P.W, P.H), before = pctx.getImageData(0, 0, P.W, P.H);
      pctx.clearRect(0, 0, P.W, P.H); pushUndo(b, before);
    });
  };

  // --- exportar
  function saveFail(e) { console.error(e); toast('Não consegui salvar a imagem.', 3500); }
  $('#export').onclick = function () {
    busy('Salvando imagem…');
    setTimeout(function () {
      var name = (state.book.name.replace(/[^\wÀ-ɏ -]+/g, '').trim() || 'pintura') + ' - pag ' + P.n + ' - ' + Date.now().toString(36) + '.png';
      var full = compose(0), job;
      if (hasAndroid) {
        job = new Promise(function (res) {
          var url = full.toDataURL('image/png');
          var r = window.Android.saveImage(url.slice(url.indexOf(',') + 1), name);
          if (r === 'ok') toast('Salvo na galeria, em Imagens/ColorirPDF');
          else if (r === 'perm') toast('Permita o acesso ao armazenamento e toque em salvar de novo.', 4000);
          else toast('Não consegui salvar a imagem.', 3500);
          res();
        });
      } else if (window.claude && window.claude.use) { // versão publicada como página
        job = Promise.all([window.claude.use('downloads'), new Promise(function (res) { full.toBlob(res, 'image/png'); })]).then(function (r) {
          if (!r[0] || !r[1]) { toast('Este visualizador não permite salvar arquivos.', 4000); return; }
          idle();
          return r[0].save({ filename: name, data: r[1] }).then(function () { toast('Imagem salva'); }, function (e) {
            if (e && e.code === 'declined') return;
            saveFail(e);
          });
        });
      } else {
        job = new Promise(function (res) {
          var a = el('a'); a.href = full.toDataURL('image/png'); a.download = name; document.body.appendChild(a); a.click(); a.remove();
          toast('Imagem baixada'); res();
        });
      }
      job.catch(saveFail).then(idle);
    }, 60);
  };

  // --- zoom e posição
  function applyView() { board.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.s + ')'; }
  function fitView() {
    var r = stage.getBoundingClientRect();
    if (!r.width || !P.W) return;
    view.fit = Math.min((r.width - 12) / P.W, (r.height - 12) / P.H);
    view.s = view.fit; view.x = (r.width - P.W * view.s) / 2; view.y = (r.height - P.H * view.s) / 2;
    applyView();
  }
  function zoomAt(cx, cy, s, v0, ax, ay) { // mantém o ponto (ax, ay) da tela, visto em v0, sob (cx, cy)
    s = clamp(s, view.fit * 0.6, Math.max(view.fit * 16, 4));
    view.x = cx - (ax - v0.x) * (s / v0.s); view.y = cy - (ay - v0.y) * (s / v0.s); view.s = s;
    var r = stage.getBoundingClientRect(), m = 60; // não deixa a folha sumir da tela
    view.x = clamp(view.x, m - P.W * s, r.width - m); view.y = clamp(view.y, m - P.H * s, r.height - m);
    applyView();
  }
  $('#fit').onclick = fitView;
  window.addEventListener('resize', function () { if (state.view === 'paint') fitView(); });
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = stage.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    zoomAt(x, y, view.s * Math.exp(-e.deltaY * 0.0015), { s: view.s, x: view.x, y: view.y }, x, y);
  }, { passive: false });

  // --- pincéis
  var grainCache = {};
  function grain(kind, color) {
    var key = kind + color;
    if (grainCache.key === key) return grainCache.pat;
    var n = 128, c = document.createElement('canvas'); c.width = c.height = n;
    var g = c.getContext('2d'), img = g.createImageData(n, n), d = img.data, rgb = hexToRgb(color);
    var step = kind === 'coarse' ? 2 : 1, hole = kind === 'coarse' ? 0.30 : 0.14, base = kind === 'coarse' ? 150 : 110;
    for (var y = 0; y < n; y += step) for (var x = 0; x < n; x += step) {
      var a0 = Math.random() < hole ? 0 : base + Math.random() * (255 - base);
      for (var dy = 0; dy < step; dy++) for (var dx = 0; dx < step; dx++) {
        var i = ((y + dy) * n + x + dx) * 4, a = a0 ? clamp(a0 + (Math.random() - 0.5) * 70, 0, 255) : (Math.random() < 0.15 ? 90 : 0);
        d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = a;
      }
    }
    g.putImageData(img, 0, 0);
    grainCache = { key: key, pat: sctx.createPattern(c, 'repeat') };
    return grainCache.pat;
  }
  var tipCache = {};
  function softTip(size, color) {
    var key = size + color;
    if (tipCache.key === key) return tipCache.c;
    var d = Math.max(2, Math.ceil(size)), c = document.createElement('canvas'); c.width = c.height = d;
    var g = c.getContext('2d'), rgb = hexToRgb(color).join(','), gr = g.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, d / 2);
    gr.addColorStop(0, 'rgba(' + rgb + ',1)'); gr.addColorStop(0.45, 'rgba(' + rgb + ',.75)'); gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr; g.fillRect(0, 0, d, d);
    tipCache = { key: key, c: c };
    return c;
  }
  function shade(rgb, k) { // k<0 escurece, k>0 clareia
    return 'rgb(' + rgb.map(function (v) { return Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k); }).join(',') + ')';
  }
  function star(g, x, y, r) {
    g.beginPath(); g.moveTo(x, y - r); g.quadraticCurveTo(x, y, x + r, y); g.quadraticCurveTo(x, y, x, y + r);
    g.quadraticCurveTo(x, y, x - r, y); g.quadraticCurveTo(x, y, x, y - r); g.fill();
  }
  function stamp(st, x, y) {
    var size = st.size, R = size / 2, i, a, d;
    if (st.tool === 'water') {
      sctx.globalAlpha = 0.14; sctx.drawImage(softTip(size, st.color), x - R, y - R); sctx.globalAlpha = 1;
    } else if (st.tool === 'spray') {
      sctx.fillStyle = st.color;
      var n = Math.max(6, Math.round(size * 0.5));
      for (i = 0; i < n; i++) {
        a = Math.random() * 6.283; d = R * Math.pow(Math.random(), 0.7);
        sctx.globalAlpha = 0.25 + Math.random() * 0.5;
        var s = 0.6 + Math.random() * Math.max(1, size / 45);
        sctx.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, s, s);
      }
      sctx.globalAlpha = 1;
    } else if (st.tool === 'glitter') {
      var k = Math.max(3, Math.round(size / 9));
      for (i = 0; i < k; i++) {
        a = Math.random() * 6.283; d = R * Math.sqrt(Math.random());
        var px = x + Math.cos(a) * d, py = y + Math.sin(a) * d, roll = Math.random();
        sctx.fillStyle = roll < 0.22 ? '#ffffff' : shade(st.rgb, (Math.random() - 0.45) * 0.9);
        var r = Math.max(1.2, size * (0.03 + Math.random() * 0.09));
        if (roll > 0.6) star(sctx, px, py, r * 1.8); else { sctx.beginPath(); sctx.arc(px, py, r * 0.7, 0, 7); sctx.fill(); }
      }
    }
  }

  var stroke = null, raf = 0;
  function beginStroke(pt) {
    var t = TOOL[cfg.tool];
    stroke = {
      tool: t.id, kind: t.kind, size: cfg.sizes[t.id], op: t.id === 'eraser' ? 1 : cfg.ops[t.id] / 100,
      color: cfg.color, rgb: hexToRgb(cfg.color), pts: [pt], last: pt, carry: 0,
      x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y
    };
    stroke.pad = t.kind === 'stamp' ? stroke.size * 0.75 + 6 : stroke.size / 2 + 3;
    cStroke.style.opacity = stroke.op;
    if (t.kind === 'stamp') stamp(stroke, pt.x, pt.y); else redraw();
  }
  function extendStroke(pt) {
    var st = stroke, dx = pt.x - st.last.x, dy = pt.y - st.last.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.6) return;
    if (pt.x < st.x0) st.x0 = pt.x; if (pt.x > st.x1) st.x1 = pt.x;
    if (pt.y < st.y0) st.y0 = pt.y; if (pt.y > st.y1) st.y1 = pt.y;
    if (st.kind === 'stamp') {
      var gap = Math.max(1, st.size * (st.tool === 'water' ? 0.1 : st.tool === 'spray' ? 0.18 : 0.3));
      var pos = gap - st.carry;
      while (pos <= dist) { stamp(st, st.last.x + dx * pos / dist, st.last.y + dy * pos / dist); pos += gap; }
      st.carry = dist - (pos - gap);
    } else {
      st.pts.push(pt);
      if (!raf) raf = requestAnimationFrame(redraw);
    }
    st.last = pt;
  }
  // pincéis de traço: o caminho inteiro é redesenhado de uma vez, assim a transparência e a
  // textura não acumulam nas emendas
  function redraw() {
    raf = 0;
    var st = stroke; if (!st || st.kind !== 'path') return;
    var p = st.pts, n = p.length, pad = st.pad + 2;
    sctx.clearRect(st.x0 - pad, st.y0 - pad, st.x1 - st.x0 + pad * 2, st.y1 - st.y0 + pad * 2);
    var t = TOOL[st.tool];
    sctx.lineCap = sctx.lineJoin = 'round'; sctx.lineWidth = st.size;
    sctx.strokeStyle = st.tool === 'eraser' ? '#ffffff' : t.grain ? grain(t.grain, st.color) : st.color;
    sctx.beginPath(); sctx.moveTo(p[0].x, p[0].y);
    if (n === 1) sctx.lineTo(p[0].x + 0.01, p[0].y);
    else {
      for (var i = 1; i < n - 1; i++) sctx.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + p[i + 1].x) / 2, (p[i].y + p[i + 1].y) / 2);
      sctx.lineTo(p[n - 1].x, p[n - 1].y);
    }
    sctx.stroke();
  }
  function strokeBox(st) { return box(st.x0 - st.pad, st.y0 - st.pad, st.x1 + st.pad, st.y1 + st.pad); }
  function endStroke() {
    var st = stroke; if (!st) return;
    if (raf) { cancelAnimationFrame(raf); redraw(); }
    stroke = null;
    var b = strokeBox(st);
    if (b) {
      var before = pctx.getImageData(b.x, b.y, b.w, b.h);
      pctx.save();
      if (st.tool === 'eraser') pctx.globalCompositeOperation = 'destination-out'; else pctx.globalAlpha = st.op;
      pctx.drawImage(cStroke, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
      pctx.restore();
      pushUndo(b, before);
      if (st.tool !== 'eraser') useColor();
    }
    sctx.clearRect(0, 0, P.W, P.H);
  }
  function cancelStroke() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (stroke) { stroke = null; sctx.clearRect(0, 0, P.W, P.H); }
  }

  // --- balde: preenche a área cercada pelas linhas do desenho
  function fillAt(px, py) {
    var W = P.W, H = P.H, la = P.lineA;
    px = Math.floor(px); py = Math.floor(py);
    if (px < 0 || py < 0 || px >= W || py >= H) return;
    if (la[py * W + px] >= LINE_TH) { toast('Toque dentro de uma área em branco do desenho.'); return; }
    var mask = new Uint8Array(W * H), stack = [px, py];
    var x0 = px, x1 = px, y0 = py, y1 = py;
    while (stack.length) {
      var y = stack.pop(), x = stack.pop(), row = y * W;
      if (mask[row + x] || la[row + x] >= LINE_TH) continue;
      var l = x, r = x;
      while (l > 0 && !mask[row + l - 1] && la[row + l - 1] < LINE_TH) l--;
      while (r < W - 1 && !mask[row + r + 1] && la[row + r + 1] < LINE_TH) r++;
      for (var i = l; i <= r; i++) mask[row + i] = 1;
      if (l < x0) x0 = l; if (r > x1) x1 = r; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (var dy = -1; dy <= 1; dy += 2) {
        var ny = y + dy; if (ny < 0 || ny >= H) continue;
        var nrow = ny * W, open = false;
        for (i = l; i <= r; i++) {
          var free = !mask[nrow + i] && la[nrow + i] < LINE_TH;
          if (free && !open) { stack.push(i, ny); open = true; } else if (!free) open = false;
        }
      }
    }
    // avança 2 px por baixo das linhas para não sobrar contorno branco
    var GROW = 2, pass, xx, yy, p;
    x0 = Math.max(0, x0 - GROW); y0 = Math.max(0, y0 - GROW); x1 = Math.min(W - 1, x1 + GROW); y1 = Math.min(H - 1, y1 + GROW);
    for (pass = 1; pass <= GROW; pass++) {
      for (yy = y0; yy <= y1; yy++) for (xx = x0; xx <= x1; xx++) {
        p = yy * W + xx;
        if (mask[p]) continue;
        if ((xx > 0 && mask[p - 1] === pass) || (xx < W - 1 && mask[p + 1] === pass) || (yy > 0 && mask[p - W] === pass) || (yy < H - 1 && mask[p + W] === pass)) mask[p] = pass + 1;
      }
    }
    var b = box(x0, y0, x1 + 1, y1 + 1);
    var before = pctx.getImageData(b.x, b.y, b.w, b.h);
    var img = pctx.getImageData(b.x, b.y, b.w, b.h), d = img.data;
    var rgb = hexToRgb(cfg.color), op = cfg.ops.fill / 100;
    for (yy = 0; yy < b.h; yy++) for (xx = 0; xx < b.w; xx++) {
      if (!mask[(b.y + yy) * W + b.x + xx]) continue;
      var k = (yy * b.w + xx) * 4, da = d[k + 3] / 255;
      if (op >= 1 || da === 0) { d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; d[k + 3] = Math.round(255 * (op >= 1 ? 1 : op)); }
      else {
        var oa = op + da * (1 - op);
        d[k] = (rgb[0] * op + d[k] * da * (1 - op)) / oa; d[k + 1] = (rgb[1] * op + d[k + 1] * da * (1 - op)) / oa;
        d[k + 2] = (rgb[2] * op + d[k + 2] * da * (1 - op)) / oa; d[k + 3] = Math.round(oa * 255);
      }
    }
    pctx.putImageData(img, b.x, b.y);
    pushUndo(b, before); useColor();
  }
  function pickAt(px, py) {
    px = Math.floor(px); py = Math.floor(py);
    if (px < 0 || py < 0 || px >= P.W || py >= P.H) return;
    var d = pctx.getImageData(px, py, 1, 1).data;
    if (d[3] < 8) { toast('Aqui ainda não tem tinta.'); return; }
    var a = d[3] / 255; // cor como aparece sobre o papel branco
    setColor(rgbToHex(Math.round(d[0] * a + 255 * (1 - a)), Math.round(d[1] * a + 255 * (1 - a)), Math.round(d[2] * a + 255 * (1 - a))));
  }

  // --- toque: um dedo pinta, dois dedos movem e dão zoom
  var pts = {}, nPts = 0, gesture = null, lock = false, tap = null;
  function toBoard(e) {
    var r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.s, y: (e.clientY - r.top - view.y) / view.s };
  }
  function twoInfo() {
    var k = Object.keys(pts), a = pts[k[0]], b = pts[k[1]], r = stage.getBoundingClientRect();
    return { d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
  }
  stage.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!$('#sheet').hidden) { $('#sheet').hidden = true; return; }
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    pts[e.pointerId] = { x: e.clientX, y: e.clientY }; nPts++;
    if (nPts === 1 && !lock) {
      var t = TOOL[cfg.tool];
      if (t.kind === 'tap') tap = { id: e.pointerId, x: e.clientX, y: e.clientY };
      else { if (t.id !== 'eraser') lastBrush = t.id; beginStroke(toBoard(e)); stroke.id = e.pointerId; }
    } else if (nPts === 2) {
      cancelStroke(); tap = null; lock = true;
      var g = twoInfo(); gesture = { d: g.d, x: g.x, y: g.y, v: { s: view.s, x: view.x, y: view.y } };
    }
  });
  stage.addEventListener('pointermove', function (e) {
    var p = pts[e.pointerId]; if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (gesture && nPts >= 2) {
      var g = twoInfo(); zoomAt(g.x, g.y, gesture.v.s * g.d / gesture.d, gesture.v, gesture.x, gesture.y);
    } else if (stroke && stroke.id === e.pointerId) {
      var list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (list && list.length) for (var i = 0; i < list.length; i++) extendStroke(toBoard(list[i])); else extendStroke(toBoard(e));
    }
  });
  function up(e) {
    if (!pts[e.pointerId]) return;
    delete pts[e.pointerId]; nPts--;
    if (stroke && stroke.id === e.pointerId) { if (e.type === 'pointercancel') cancelStroke(); else endStroke(); }
    if (tap && tap.id === e.pointerId) {
      if (e.type === 'pointerup' && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 12) {
        var pt = toBoard(e);
        if (cfg.tool === 'fill') fillAt(pt.x, pt.y); else pickAt(pt.x, pt.y);
      }
      tap = null;
    }
    if (nPts < 2) gesture = null;
    if (nPts <= 0) { nPts = 0; pts = {}; lock = false; }
  }
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // ---------------------------------------------------------------- início
  Promise.all([kvGet('cfg', null), kvGet('sort', 'added')]).then(function (r) {
    var saved = r[0];
    if (saved) {
      if (TOOL[saved.tool]) cfg.tool = saved.tool;
      if (/^#[0-9a-f]{6}$/.test(saved.color || '')) cfg.color = saved.color;
      ['sizes', 'ops'].forEach(function (k) { for (var id in saved[k] || {}) if (cfg[k][id] != null) cfg[k][id] = saved[k][id]; });
      if (Array.isArray(saved.recents)) cfg.recents = saved.recents;
    }
    if (!cfg.recents.length) cfg.recents = ['#ff7ac0', '#b88cff', '#7fd4ff', '#8ff0c0', '#fff27a', '#ffb37a', '#ff6b6b', '#2b2140'];
    state.sort = r[1]; $('#sort').value = state.sort;
    if (TOOL[cfg.tool].kind !== 'tap' && cfg.tool !== 'eraser') lastBrush = cfg.tool;
    setColor(cfg.color, true); setTool(cfg.tool); renderRecents();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    return renderLibrary();
  }).catch(function (e) {
    console.error(e);
    $('#empty').hidden = false;
    $('#empty').innerHTML = '<div class="empty-art">🔒</div><h2>Armazenamento bloqueado</h2><p>Este navegador não deixou o app guardar seus livros (janela anônima ou dados do site bloqueados). Abra em uma janela normal e tente de novo.</p>';
    $('#add').hidden = true;
  });
})();
