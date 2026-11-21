/*
 * Baixador de vídeos para o Safari do iPhone (bookmarklet).
 *
 * Toque no favorito numa página com vídeo: abre um painel com os vídeos
 * encontrados (MP4/MOV/WebM diretos e streams HLS .m3u8). "Baixar" monta o
 * arquivo no próprio navegador e o Safari pergunta se quer baixar; ele vai
 * para o app Arquivos > Downloads.
 *
 * - Arquivos diretos: baixados inteiros com barra de progresso.
 * - HLS (VOD): baixa todos os segmentos e junta. Segmentos .ts são
 *   convertidos para .mp4 com mux.js (se o site permitir carregar o script);
 *   senão o arquivo sai .ts (abre no VLC). Segmentos fMP4 saem .mp4 direto.
 * - HLS ao vivo: grava a partir de agora até tocar em "Parar e salvar".
 * - Não funciona com vídeo protegido por DRM nem com streams criptografados.
 *
 * Tocar no favorito de novo fecha o painel.
 */
(function () {
  'use strict';
  var MUXJS_URL = window.__VDL_MUXJS_URL || 'https://cdn.jsdelivr.net/npm/mux.js@6.3.0/dist/mux.min.js';
  var FILE_RE = /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|ogg)(\?|#|$)/i;
  var HLS_RE = /\.m3u8(\?|#|$)|[?&]format=m3u8|\/manifest\(format=m3u8/i;

  if (window.__vdl) { window.__vdl.close(); return; }

  /* Se a página recarregar no meio do download, a etapa fica guardada na
     aba (sessionStorage) e o painel avisa na próxima vez. */
  var LAST_KEY = '__vdl_last';
  var lastCrash = null;
  try {
    var lc = JSON.parse(sessionStorage.getItem(LAST_KEY) || 'null');
    if (lc && Date.now() - lc.t < 15 * 60000) lastCrash = lc;
    sessionStorage.removeItem(LAST_KEY);
  } catch (e) {}
  var skipMux = !!(lastCrash && /conversor/i.test(lastCrash.step));
  function mark(step) {
    try { sessionStorage.setItem(LAST_KEY, JSON.stringify({ step: step, t: Date.now() })); } catch (e) {}
  }
  function unmark() { try { sessionStorage.removeItem(LAST_KEY); } catch (e) {} }

  /* ---------- Coleta de vídeos na página ---------- */

  function abs(u, base) {
    try { return new URL(u, base || location.href).href; } catch (e) { return null; }
  }

  function collect() {
    var found = new Map();
    var blobs = 0;
    var pagePoster = null;
    function add(u, kind, label, poster) {
      if (!u) return;
      if (u.indexOf('blob:') === 0) { blobs++; return; }
      if (u.indexOf('data:') === 0) return;
      u = abs(u);
      if (!u) return;
      if (found.has(u)) { if (poster && !found.get(u).poster) found.get(u).poster = poster; return; }
      if (!kind) kind = HLS_RE.test(u) ? 'hls' : 'file';
      found.set(u, { url: u, kind: kind, label: label || '', poster: poster || null });
    }
    function scan(doc) {
      doc.querySelectorAll('video, audio').forEach(function (v) {
        var po = v.poster || null;
        if (po && !pagePoster) pagePoster = po;
        add(v.currentSrc, null, v.tagName === 'AUDIO' ? 'áudio' : 'player', po);
        add(v.getAttribute('src') && v.src, null, 'player', po);
        v.querySelectorAll('source[src]').forEach(function (s) { add(s.src, null, 'player', po); });
      });
      var og = doc.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
      if (og && og.content && !pagePoster) pagePoster = abs(og.content);
      doc.querySelectorAll('a[href]').forEach(function (a) {
        if (FILE_RE.test(a.href) || HLS_RE.test(a.href)) add(a.href, null, 'link');
      });
      doc.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]')
        .forEach(function (m) { add(m.content, null, 'og:video'); });
      doc.querySelectorAll('iframe').forEach(function (f) {
        try { if (f.contentDocument) scan(f.contentDocument); } catch (e) { /* iframe de outro domínio */ }
      });
    }
    scan(document);
    // Pedidos de rede: pega o .m3u8 de players que usam blob: (hls.js etc.)
    try {
      performance.getEntriesByType('resource').forEach(function (e) {
        var n = e.name;
        if (HLS_RE.test(n)) add(n, 'hls', 'rede');
        else if (/\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(n) && !/[_\-/](init|seg|segment|chunk|frag)/i.test(n)) add(n, 'file', 'rede');
      });
    } catch (e) {}
    return { items: Array.from(found.values()), blobs: blobs, poster: pagePoster };
  }

  /* ---------- Utilidades ---------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
    return (n / 1073741824).toFixed(2).replace('.', ',') + ' GB';
  }

  function baseName() {
    var t = (document.title || location.hostname || 'video')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return t || 'video';
  }

  function extOf(url, type) {
    var m = /\.([a-z0-9]{2,4})(\?|#|$)/i.exec(new URL(url).pathname);
    if (m && FILE_RE.test('.' + m[1])) return m[1].toLowerCase();
    if (type) {
      if (/webm/.test(type)) return 'webm';
      if (/quicktime/.test(type)) return 'mov';
      if (/audio\/mpeg/.test(type)) return 'mp3';
      if (/audio/.test(type)) return 'm4a';
    }
    return 'mp4';
  }

  /* O link fica dentro do painel (shadow DOM) e o clique não sobe para a
     página: sites que interceptam cliques em links (SPA) recarregavam a
     página em vez de baixar. */
  function saveBlob(blob, name) {
    var a = document.createElement('a');
    var href = URL.createObjectURL(blob);
    a.href = href;
    a.download = name;
    a.style.display = 'none';
    a.addEventListener('click', function (e) { e.stopPropagation(); });
    root.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(href); }, 120000);
  }

  /* Junta os pedaços em Blobs de ~8 MB conforme chegam. No Safari os dados
     de um Blob saem da memória da aba, então o pico no fim fica bem menor
     (aba sem memória = iOS recarrega a página e o download se perde). */
  function Collector() {
    var blobs = [], pend = [], pendBytes = 0;
    this.size = 0;
    this.count = 0;
    this.push = function (u8) {
      if (!u8 || !u8.length) return;
      pend.push(u8); pendBytes += u8.length; this.size += u8.length; this.count++;
      if (pendBytes >= 8388608) this.flush();
    };
    this.flush = function () {
      if (pend.length) { blobs.push(new Blob(pend)); pend = []; pendBytes = 0; }
    };
    this.blob = function (head, type) {
      this.flush();
      var b = new Blob((head ? [head] : []).concat(blobs), { type: type });
      blobs = [];
      return b;
    };
  }

  /* ---------- Armazenamento das partes (para retomar) ----------
     Cada parte baixada vai para o IndexedDB do Safari assim que chega, como
     num torrent: se a conexão cair, a página recarregar ou você pausar, o
     download continua de onde parou. As partes ficam no disco, não na
     memória da aba. Sem IndexedDB (ex.: bloqueado), guarda na memória e só
     retoma enquanto a página não recarregar. */
  var S = (function () {
    var memJobs = {}, memChunks = {}, dbp = null, useDb = true;
    function ck(id, i) { return id + '\u0001' + (i < 0 ? 'init' : ('00000' + i).slice(-6)); }
    function open() {
      if (!dbp) dbp = new Promise(function (res) {
        try {
          var rq = indexedDB.open('__vdl', 1);
          rq.onupgradeneeded = function () {
            var d = rq.result;
            if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' });
            if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks');
          };
          rq.onsuccess = function () { res(rq.result); };
          rq.onerror = rq.onblocked = function () { res(null); };
        } catch (e) { res(null); }
        setTimeout(function () { res(null); }, 4000);
      });
      return dbp;
    }
    function rq(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
    function done(t) { return new Promise(function (res, rej) { t.oncomplete = res; t.onerror = t.onabort = function () { rej(t.error); }; }); }
    async function db() { if (!useDb) return null; var d = await open(); if (!d) useDb = false; return d; }
    return {
      persistent: function () { return useDb; },
      putJob: async function (m) {
        var d = await db();
        if (d) { try { var t = d.transaction('jobs', 'readwrite'); t.objectStore('jobs').put(m); await done(t); return; } catch (e) { useDb = false; } }
        memJobs[m.id] = JSON.parse(JSON.stringify(m));
      },
      jobs: async function () {
        var out = Object.keys(memJobs).map(function (k) { return memJobs[k]; });
        var d = await db();
        if (d) { try { out = out.concat(await rq(d.transaction('jobs').objectStore('jobs').getAll())); } catch (e) {} }
        return out;
      },
      put: async function (id, i, blob) {
        var d = await db();
        if (d) { try { var t = d.transaction('chunks', 'readwrite'); t.objectStore('chunks').put(blob, ck(id, i)); await done(t); return; } catch (e) { useDb = false; } }
        memChunks[ck(id, i)] = blob;
      },
      get: async function (id, i) {
        var k = ck(id, i);
        if (memChunks[k]) return memChunks[k];
        var d = await open();
        return d ? rq(d.transaction('chunks').objectStore('chunks').get(k)) : null;
      },
      keys: async function (id) {
        var pre = id + '\u0001', out = Object.keys(memChunks).filter(function (k) { return k.indexOf(pre) === 0; });
        var d = await open();
        if (d) { try { out = out.concat(await rq(d.transaction('chunks').objectStore('chunks').getAllKeys(IDBKeyRange.bound(pre, id + '\u0002')))); } catch (e) {} }
        return out.map(function (k) { k = k.slice(pre.length); return k === 'init' ? -1 : parseInt(k, 10); });
      },
      delChunk: async function (id, i) {
        delete memChunks[ck(id, i)];
        var d = await open();
        if (d) { try { var t = d.transaction('chunks', 'readwrite'); t.objectStore('chunks').delete(ck(id, i)); await done(t); } catch (e) {} }
      },
      del: async function (id) {
        var pre = id + '\u0001';
        delete memJobs[id];
        Object.keys(memChunks).forEach(function (k) { if (k.indexOf(pre) === 0) delete memChunks[k]; });
        var d = await open();
        if (d) {
          try {
            var t = d.transaction(['jobs', 'chunks'], 'readwrite');
            t.objectStore('jobs').delete(id);
            t.objectStore('chunks').delete(IDBKeyRange.bound(pre, id + '\u0002'));
            await done(t);
          } catch (e) {}
        }
      }
    };
  })();

  // Arquivo montado e entregue: as partes podem ser apagadas na próxima vez
  async function markDone(id) {
    var m = (await S.jobs()).filter(function (x) { return x.id === id; })[0];
    if (m) { m.done = true; await S.putJob(m); }
  }

  function jobId(url, choice) { return url + '|' + (choice || ''); }
  function fatal(msg) { var e = new Error(msg); e.fatal = true; return e; }
  async function blobBytes(b) { return new Uint8Array(await new Response(b).arrayBuffer()); }

  /* A galeria (Fotos) só recebe vídeo pela folha de compartilhar do iOS,
     opção "Salvar Vídeo". Ela só aceita MP4/MOV. */
  function galleryFile(out) {
    var ext = out.name.split('.').pop();
    var type = ext === 'mov' ? 'video/quicktime' : (ext === 'mp4' || ext === 'm4v') ? 'video/mp4' : '';
    if (!type || typeof File !== 'function' || !navigator.share || !navigator.canShare) return null;
    try {
      var f = new File([out.blob], out.name, { type: type });
      return navigator.canShare({ files: [f] }) ? f : null;
    } catch (e) { return null; }
  }

  async function fetchRetry(url, opts, tries) {
    tries = tries || 4;
    for (var i = 0; ; i++) {
      try {
        var r = await fetch(url, Object.assign({ credentials: 'include' }, opts || {}))
          .catch(function () { return fetch(url, opts); }); // sem cookies se o CORS recusar "include"
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r;
      } catch (e) {
        if (i + 1 >= tries || (opts && opts.signal && opts.signal.aborted)) throw e;
        await sleep(500 * (i + 1));
      }
    }
  }

  async function fetchText(url, signal) {
    return (await fetchRetry(url, { signal: signal })).text();
  }

  async function fetchBytes(url, signal, tries) {
    return new Uint8Array(await (await fetchRetry(url, { signal: signal }, tries)).arrayBuffer());
  }

  var muxPromise = null;
  function loadMux() {
    if (window.muxjs) return Promise.resolve(window.muxjs);
    if (!muxPromise) {
      muxPromise = new Promise(function (res) {
        // Sites com require.js (AMD) "engoliam" o conversor: esconde o
        // define() enquanto ele carrega, para ele se registrar em window.muxjs.
        var amd = window.define && window.define.amd ? window.define : null;
        if (amd) window.define = undefined;
        var finished = false;
        function done() {
          if (finished) return;
          finished = true;
          if (amd && window.define === undefined) window.define = amd;
          res(window.muxjs || null);
        }
        var s = document.createElement('script');
        s.src = MUXJS_URL;
        s.onload = done;
        s.onerror = done;
        setTimeout(done, 12000);
        // O script vai dentro do painel (shadow DOM): roda normalmente, mas
        // o site não o enxerga. Alguns sites recarregam a página quando
        // aparece um script novo.
        root.appendChild(s);
      });
    }
    return muxPromise;
  }

  /* ---------- Download de arquivo direto ---------- */

  async function downloadFile(item, job) {
    var id = jobId(item.url);
    var meta = (await S.jobs()).filter(function (m) { return m.id === id; })[0] ||
      { id: id, v: 2, kind: 'file', url: item.url, name: baseName(), t: Date.now(), n: 0, saved: 0, total: 0 };
    if (meta.done) { await S.del(id); meta = { id: id, v: 2, kind: 'file', url: item.url, name: baseName(), t: Date.now(), n: 0, saved: 0, total: 0 }; }
    meta.v = 2;
    if (meta.complete) {
      // já baixou tudo antes (a montagem falhou): só monta de novo
      var have0 = await S.keys(id);
      if (have0.length >= meta.n) return assembleFile(meta, item);
      await S.del(id); meta.n = 0; meta.saved = 0; meta.complete = false;
    }
    job.status(meta.saved ? 'Retomando de ' + fmtBytes(meta.saved) + '…' : 'Conectando…');
    var opts = { signal: job.signal };
    if (meta.saved) opts.headers = { Range: 'bytes=' + meta.saved + '-' };
    var r = await fetchRetry(item.url, opts, 2);
    var type = r.headers.get('content-type') || meta.type || '';
    var total = 0;
    if (meta.saved) {
      var cr = /bytes\s+(\d+)-\d+\/(\d+|\*)/.exec(r.headers.get('content-range') || '');
      var ok = r.status === 206 && (!cr || +cr[1] === meta.saved);
      total = cr && cr[2] !== '*' ? +cr[2] : meta.total;
      if (ok && meta.total && total && total !== meta.total) ok = false; // o arquivo mudou
      if (!ok) {
        // O servidor não aceita retomar: recomeça do zero com esta resposta
        // (se ela for o arquivo inteiro) ou com um pedido novo.
        await S.del(id);
        meta.n = 0; meta.saved = 0;
        if (r.status !== 200) { try { r.body && r.body.cancel(); } catch (e) {} r = await fetchRetry(item.url, { signal: job.signal }, 2); }
        total = +r.headers.get('content-length') || 0;
        job.status('Este servidor não permite retomar; recomeçando.');
      }
    } else {
      total = +r.headers.get('content-length') || 0;
    }
    meta.total = total || meta.total; meta.type = type;
    await S.putJob(meta);

    var pend = [], pendBytes = 0;
    async function flush() {
      if (!pend.length) return;
      await S.put(id, meta.n, new Blob(pend));
      meta.n++; meta.saved += pendBytes; pend = []; pendBytes = 0;
      job.saved = true;
      await S.putJob(meta);
    }
    function prog() {
      var got = meta.saved + pendBytes;
      job.progress(meta.total ? got / meta.total : -1, fmtBytes(got) + (meta.total ? ' de ' + fmtBytes(meta.total) : ''));
    }
    if (r.body && r.body.getReader) {
      var reader = r.body.getReader();
      for (;;) {
        var x = await reader.read();
        if (x.done) break;
        pend.push(x.value); pendBytes += x.value.length;
        if (pendBytes >= 4194304) await flush();
        prog();
      }
    } else {
      var all = new Uint8Array(await r.arrayBuffer());
      pend.push(all); pendBytes = all.length;
    }
    await flush();
    if (meta.total && meta.saved < meta.total) throw new Error('A conexão caiu antes do fim');
    meta.complete = true;
    await S.putJob(meta);
    job.status('Montando arquivo…');
    return assembleFile(meta, item);
  }

  async function assembleFile(meta, item) {
    var parts = [];
    for (var i = 0; i < meta.n; i++) {
      var p = await S.get(meta.id, i);
      if (!p) {
        // parte sumiu: no arquivo direto não dá para baixar só ela; recomeça
        await S.del(meta.id);
        throw new Error('Uma parte guardada se perdeu; baixando de novo.');
      }
      parts.push(p);
    }
    var type = meta.type || 'video/mp4';
    return { blob: new Blob(parts, { type: type }), name: meta.name + '.' + extOf(item.url, type), id: meta.id };
  }

  /* ---------- HLS ---------- */

  function attr(line, name) {
    var m = new RegExp('(?:^|[:,])' + name + '=("([^"]*)"|[^,]*)').exec(line);
    return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
  }

  function parseMedia(text, url) {
    var lines = text.split(/\r?\n/);
    var p = { segments: [], seq: 0, target: 6, ended: /#EXT-X-ENDLIST/.test(text), map: null, key: null, byterange: false };
    var seq = null, dur = 0, disc = false;
    lines.forEach(function (l) {
      l = l.trim();
      if (!l) return;
      if (l.indexOf('#EXTINF:') === 0) dur = parseFloat(l.slice(8)) || 0;
      else if (l.indexOf('#EXT-X-DISCONTINUITY') === 0 && l.indexOf('SEQUENCE') < 0) disc = true;
      else if (l.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) p.seq = parseInt(l.slice(22), 10) || 0;
      else if (l.indexOf('#EXT-X-TARGETDURATION:') === 0) p.target = parseFloat(l.slice(22)) || 6;
      else if (l.indexOf('#EXT-X-MAP:') === 0) p.map = abs(attr(l, 'URI'), url);
      else if (l.indexOf('#EXT-X-KEY:') === 0) { var m = attr(l, 'METHOD'); if (m && m !== 'NONE') p.key = m; }
      else if (l.indexOf('#EXT-X-BYTERANGE') === 0) p.byterange = true;
      else if (l[0] !== '#') {
        if (seq === null) seq = p.seq;
        p.segments.push({ url: abs(l, url), seq: seq++, dur: dur, disc: disc });
        dur = 0; disc = false;
      }
    });
    return p;
  }

  /* Lista as qualidades de uma playlist "master", da melhor para a pior. */
  function parseMaster(text, url) {
    var lines = text.split(/\r?\n/), vars = [], seen = {}, audio = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (l.indexOf('#EXT-X-MEDIA:') === 0 && attr(l, 'URI')) audio.push(abs(attr(l, 'URI'), url));
      if (l.indexOf('#EXT-X-STREAM-INF:') === 0) {
        var u = (lines[i + 1] || '').trim();
        if (!u || u[0] === '#') continue;
        u = abs(u, url);
        if (seen[u]) continue;
        seen[u] = 1;
        var res = attr(l, 'RESOLUTION'), h = res ? parseInt(res.split('x')[1], 10) || 0 : 0;
        var bw = parseInt(attr(l, 'AVERAGE-BANDWIDTH') || attr(l, 'BANDWIDTH'), 10) || 0;
        var codecs = attr(l, 'CODECS') || '';
        if (!h && codecs && !/avc|hvc|hev|vp0?9|av01|dvh/i.test(codecs)) continue; // só áudio
        vars.push({ url: u, h: h, bw: bw, res: res });
      }
    }
    vars.sort(function (a, b) { return (b.h - a.h) || (b.bw - a.bw); });
    return { variants: vars, audioSep: audio.length > 0, audio: audio };
  }

  function qualityName(h) {
    if (!h) return '';
    if (h >= 2000) return '4K';
    if (h >= 1400) return '1440p';
    var std = [1080, 720, 576, 480, 360, 288, 240, 144];
    for (var i = 0; i < std.length; i++) if (h >= std[i] * 0.92) return std[i] + 'p';
    return h + 'p';
  }

  function fmtRate(bw) {
    if (!bw) return '';
    return bw >= 1e6 ? (bw / 1e6).toFixed(1).replace('.', ',') + ' Mbps' : Math.round(bw / 1000) + ' kbps';
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, x = ('0' + sec % 60).slice(-2);
    return h ? h + ':' + ('0' + m).slice(-2) + ':' + x : m + ':' + x;
  }

  // Identifica a qualidade mesmo se o link dela mudar (tokens que expiram)
  function variantKey(v) { return (v.res || '') + '|' + (v.bw || 0); }

  function variantLabel(v) {
    var q = qualityName(v.h) || 'Qualidade';
    return q + (v.res ? ' (' + v.res + ')' : '') + (v.bw ? ' · ' + fmtRate(v.bw) : '');
  }

  /* ---------- Linha do tempo contínua ----------
     Streams com anúncios ou trechos emendados têm "descontinuidades": o
     relógio do vídeo pula para frente (vira tempo preto no arquivo) ou volta
     a zero (vira uma duração enorme, tipo 12h). Antes de juntar cada parte,
     o tempo dela é reposicionado logo depois da anterior. */
  var PTS_WRAP = 8589934592; // 2^33 (relógio de 90 kHz do MPEG-TS)

  // Primeiro PTS de vídeo (ou de áudio, se não houver vídeo) de um segmento .ts
  function firstPts(u8) {
    var audio = null;
    for (var o = 0; o + 188 <= u8.length; o += 188) {
      if (u8[o] !== 0x47) { var n = u8.indexOf(0x47, o + 1); if (n < 0) break; o = n - 188; continue; }
      if (!(u8[o + 1] & 0x40)) continue;
      var afc = (u8[o + 3] >> 4) & 3, q = o + 4;
      if (afc === 2) continue;
      if (afc === 3) q += 1 + u8[q];
      if (q + 14 > o + 188 || u8[q] !== 0 || u8[q + 1] !== 0 || u8[q + 2] !== 1 || !(u8[q + 7] & 0x80)) continue;
      var sid = u8[q + 3], b = q + 9;
      var pts = ((u8[b] >> 1) & 7) * 1073741824 + u8[b + 1] * 4194304 + (u8[b + 2] >> 1) * 32768 + u8[b + 3] * 128 + (u8[b + 4] >> 1);
      if (sid >= 0xE0 && sid <= 0xEF) return pts;
      if (sid >= 0xC0 && sid <= 0xDF && audio === null) audio = pts;
    }
    return audio;
  }

  function concatU8(list) {
    var n = 0, o, p = 0;
    list.forEach(function (a) { n += a.length; });
    o = new Uint8Array(n);
    list.forEach(function (a) { o.set(a, p); p += a.length; });
    return o;
  }

  /* Conversor .ts -> MP4 (mux.js) com linha do tempo contínua. Quando o
     relógio pula (descontinuidade marcada, salto de PTS ou parte faltando),
     reinicia o relógio do conversor (senão ele descarta os quadros quando o
     relógio volta para trás) e depois emenda o trecho no fim do anterior
     com o fmp4Fixer. */
  async function tsConverter() {
    if (skipMux) { job0.status('Sem conversor desta vez (a página recarregou ao carregá-lo).'); return null; }
    job0.status('Carregando conversor MP4…');
    var muxjs = await loadMux();
    if (!muxjs) return null;
    var mux = new muxjs.mp4.Transmuxer(), init = null, buf = [], fx = null, out = new Collector();
    mux.on('data', function (sg) { if (!init) init = new Uint8Array(sg.initSegment); buf.push(new Uint8Array(sg.data)); });
    var prevPts = null, prevDur = 0, first = true, force = false;
    return {
      push: function (u8, dur, disc) {
        var pts = firstPts(u8), reset = false;
        if (!first) {
          var cont = !disc && !force && pts !== null && prevPts !== null;
          if (cont) {
            var d = ((pts - prevPts) % PTS_WRAP + PTS_WRAP) % PTS_WRAP;
            cont = Math.abs(d - prevDur * 90000) <= 5 * 90000;
          }
          if (!cont) { reset = true; mux.setBaseMediaDecodeTime(0); }
        }
        buf = [];
        mux.push(u8); mux.flush();
        if (buf.length) {
          if (!fx) fx = fmp4Fixer(init);
          var seg = concatU8(buf);
          out.push(fx.fix(seg, dur, reset).data);
        }
        prevPts = pts; prevDur = dur || prevDur; first = false; force = false;
      },
      skip: function () { force = true; },
      blob: function () { return init && out.count ? out.blob(setInitDuration(init, fx.end()), 'video/mp4') : null; }
    };
  }

  // fMP4: lê as escalas de tempo (timescale) de cada trilha no init
  function boxes(u8, start, end, cb) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (var o = start; o + 8 <= end;) {
      var size = dv.getUint32(o), type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]), h = 8;
      if (size === 1) { size = dv.getUint32(o + 8) * 4294967296 + dv.getUint32(o + 12); h = 16; }
      else if (size === 0) size = end - o;
      if (size < 8 || o + size > end) break;
      cb(type, o, o + h, o + size, dv);
      o += size;
    }
  }
  function timescales(init) {
    var ts = {};
    if (!init) return ts;
    boxes(init, 0, init.length, function (t, o, b, e) {
      if (t !== 'moov') return;
      boxes(init, b, e, function (t2, o2, b2, e2) {
        if (t2 !== 'trak') return;
        var id = null, scale = null;
        boxes(init, b2, e2, function (t3, o3, b3, e3, dv) {
          if (t3 === 'tkhd') id = dv.getUint32(b3 + (init[b3] === 1 ? 20 : 12));
          if (t3 === 'mdia') boxes(init, b3, e3, function (t4, o4, b4, e4, dv4) {
            if (t4 === 'mdhd') scale = dv4.getUint32(b4 + (init[b4] === 1 ? 20 : 12));
          });
        });
        if (id !== null && scale) ts[id] = scale;
      });
    });
    return ts;
  }
  // Reescreve o tfdt (início de cada fragmento) para manter o tempo contínuo
  function fmp4Fixer(init) {
    var scale = timescales(init), offset = {}, expected = {}, force = false;
    function read(f) { return f.v1 ? f.dv.getUint32(f.pos + 4) * 4294967296 + f.dv.getUint32(f.pos + 8) : f.dv.getUint32(f.pos + 4); }
    return {
      // devolve os bytes do segmento (corrigidos se preciso) e se mudou algo
      fix: function (u8, dur, disc) {
        // sidx/styp: índice por segmento com os tempos antigos; num arquivo
        // único são opcionais e ficariam errados depois da correção
        var keep = [], dropped = false;
        boxes(u8, 0, u8.length, function (t, o, b, e) {
          if (t === 'sidx' || t === 'styp') dropped = true; else keep.push(u8.subarray(o, e));
        });
        if (dropped) u8 = concatU8(keep);
        var tfdts = [];
        boxes(u8, 0, u8.length, function (t, o, b, e) {
          if (t !== 'moof') return;
          boxes(u8, b, e, function (t2, o2, b2, e2) {
            if (t2 !== 'traf') return;
            var id = null;
            boxes(u8, b2, e2, function (t3, o3, b3, e3, dv) {
              if (t3 === 'tfhd') id = dv.getUint32(b3 + 4);
              if (t3 === 'tfdt' && id !== null) tfdts.push({ id: id, pos: b3, v1: u8[b3] === 1, dv: dv });
            });
          });
        });
        var seen = {}, changed = false;
        tfdts.forEach(function (f) {
          var sc = scale[f.id] || 90000, val = read(f);
          if (!seen[f.id]) {
            seen[f.id] = 1;
            var at = val / sc + (offset[f.id] || 0);
            if (expected[f.id] !== undefined && (force || disc || Math.abs(at - expected[f.id]) > 5)) offset[f.id] = expected[f.id] - val / sc;
            expected[f.id] = val / sc + (offset[f.id] || 0) + dur;
          }
          if (offset[f.id]) {
            var nv = Math.max(0, Math.round(val + offset[f.id] * sc));
            if (f.v1) { f.dv.setUint32(f.pos + 4, Math.floor(nv / 4294967296)); f.dv.setUint32(f.pos + 8, nv % 4294967296); }
            else f.dv.setUint32(f.pos + 4, nv % 4294967296);
            changed = true;
          }
        });
        force = false;
        return { data: u8, changed: changed || dropped };
      },
      skip: function () { force = true; },
      // fim do vídeo em segundos (maior fim entre as trilhas)
      end: function () {
        var m = 0;
        Object.keys(expected).forEach(function (k) { if (expected[k] > m) m = expected[k]; });
        return m;
      }
    };
  }

  /* Grava a duração real no cabeçalho (mvhd/tkhd/mdhd). O conversor deixava
     0xFFFFFFFF ("desconhecida"), que o iPhone mostrava como ~13 horas. */
  function setInitDuration(init, seconds) {
    if (!init || !(seconds > 0)) return init;
    var u8 = new Uint8Array(init), movieScale = 1000;
    function put(dv, pos, v1, val) {
      val = Math.round(val);
      if (v1) { dv.setUint32(pos, Math.floor(val / 4294967296)); dv.setUint32(pos + 4, val % 4294967296); }
      else dv.setUint32(pos, Math.min(val, 4294967295));
    }
    boxes(u8, 0, u8.length, function (t, o, b, e) {
      if (t !== 'moov') return;
      boxes(u8, b, e, function (t2, o2, b2, e2, dv) {
        if (t2 === 'mvhd') {
          var v1 = u8[b2] === 1;
          movieScale = dv.getUint32(b2 + (v1 ? 20 : 12)) || 1000;
          put(dv, b2 + (v1 ? 24 : 16), v1, seconds * movieScale);
        }
        if (t2 !== 'trak') return;
        boxes(u8, b2, e2, function (t3, o3, b3, e3, dv3) {
          if (t3 === 'tkhd') { var w1 = u8[b3] === 1; put(dv3, b3 + (w1 ? 28 : 20), w1, seconds * movieScale); }
          if (t3 === 'mdia') boxes(u8, b3, e3, function (t4, o4, b4, e4, dv4) {
            if (t4 !== 'mdhd') return;
            var x1 = u8[b4] === 1, sc = dv4.getUint32(b4 + (x1 ? 20 : 12)) || 90000;
            put(dv4, b4 + (x1 ? 24 : 16), x1, seconds * sc);
          });
        });
      });
    });
    return u8;
  }

  var job0 = null; // download em andamento (para mensagens do conversor)

  async function downloadHls(item, job) {
    job0 = job;
    job.status('Lendo playlist…');
    var url = item.url;
    var text = await fetchText(url, job.signal);
    if (!/^#EXTM3U/.test(text.trim())) throw fatal('Não é uma playlist HLS');
    var note = '';
    if (/#EXT-X-STREAM-INF/.test(text)) {
      var m = parseMaster(text, url);
      if (!m.variants.length) throw fatal('Playlist sem variantes de vídeo');
      var v = m.variants.filter(function (x) { return x.url === item.choice; })[0] ||
        m.variants.filter(function (x) { return item.choiceKey && variantKey(x) === item.choiceKey; })[0] || m.variants[0];
      item.choice = v.url;
      item.choiceKey = variantKey(v);
      if (m.audioSep) note = ' (áudio vem separado neste site; o vídeo pode ficar sem som)';
      url = v.url;
      job.status('Qualidade: ' + variantLabel(v) + note);
      text = await fetchText(url, job.signal);
    }
    var pl = parseMedia(text, url);
    if (pl.key) throw fatal('Stream criptografado (' + pl.key + '), não suportado');
    if (pl.byterange) throw fatal('Playlist com BYTERANGE, não suportada');
    if (!pl.segments.length) throw fatal('Playlist vazia');
    var fmp4 = !!pl.map || /\.(m4s|mp4|m4v|cmfv)(\?|$)/i.test(pl.segments[0].url);
    if (!pl.ended) return downloadLive(pl, url, fmp4, job, note);

    /* VOD: cada parte vai para o armazenamento; ao retomar, baixa só as que faltam */
    var segs = pl.segments;
    var all = await S.jobs();
    var meta = all.filter(function (x) { return x.id === jobId(item.url, item.choice) && !x.done; })[0] ||
      // mesmo vídeo e mesma qualidade, mas o link da qualidade mudou
      all.filter(function (x) { return x.kind === 'hls' && x.url === item.url && !x.done && item.choiceKey && x.key === item.choiceKey; })[0];
    if (meta && meta.count !== segs.length) {
      // a playlist mudou (outro número de partes): as partes antigas não servem
      await S.del(meta.id); meta = null;
      job.status('A playlist mudou desde a última vez; começando de novo.');
    }
    if (!meta) meta = { id: jobId(item.url, item.choice), v: 2, kind: 'hls', url: item.url, choice: item.choice || '', key: item.choiceKey || '', name: baseName(), t: Date.now(), count: segs.length, have: 0, bytes: 0 };
    var id = meta.id;
    meta.fmp4 = fmp4; meta.v = 2;
    await S.putJob(meta);
    var have = {};
    (await S.keys(id)).forEach(function (i) { have[i] = 1; });
    if (pl.map && !have[-1]) await S.put(id, -1, new Blob([await fetchBytes(pl.map, job.signal)]));
    var todo = [];
    for (var i = 0; i < segs.length; i++) if (!have[i]) todo.push(i);
    var got = segs.length - todo.length;
    if (got && todo.length) job.status('Retomando: ' + got + ' de ' + segs.length + ' partes já baixadas.');

    // Relê a playlist para pegar links novos (quando os antigos expiram).
    // Uma releitura por vez, no máximo a cada 5 s.
    var refreshing = null, lastRefresh = 0;
    function refresh() {
      if (refreshing) return refreshing;
      if (Date.now() - lastRefresh < 5000) return Promise.resolve();
      refreshing = (async function () {
        try {
          var t = await fetchText(item.url, job.signal), mu = url;
          if (/#EXT-X-STREAM-INF/.test(t)) {
            var mm = parseMaster(t, item.url);
            var vv = mm.variants.filter(function (x) { return variantKey(x) === item.choiceKey; })[0];
            if (!vv) return;
            mu = vv.url;
            t = await fetchText(mu, job.signal);
          }
          var np = parseMedia(t, mu);
          if (np.segments.length === segs.length) np.segments.forEach(function (sg, k) { segs[k].url = sg.url; });
        } catch (e) {} finally { lastRefresh = Date.now(); refreshing = null; }
      })();
      return refreshing;
    }

    // Baixa uma parte tentando de novo na hora (6 vezes). A partir da 3ª
    // falha, ou com erro HTTP 4xx (link expirado), relê a playlist antes.
    var retrying = {};
    function show() {
      var r = Object.keys(retrying);
      job.progress(got / segs.length, got + '/' + segs.length + ' partes · ' + fmtBytes(meta.bytes) +
        (r.length ? ' · tentando de novo a parte ' + r.map(function (k) { return +k + 1; }).join(', ') : '') + note);
    }
    async function getSeg(k) {
      for (var t = 0; ; t++) {
        try {
          var b = await fetchBytes(segs[k].url, job.signal, 1);
          delete retrying[k];
          return b;
        } catch (e) {
          if (job.signal.aborted || t >= 5) { delete retrying[k]; throw e; }
          retrying[k] = 1; show();
          if (t >= 2 || /HTTP 4\d\d/.test(e.message || '')) await refresh();
          await sleep(Math.min(4000, 600 * (t + 1)));
        }
      }
    }

    var next = 0, failed = 0, lastErr = null;
    async function worker() {
      while (next < todo.length && !job.signal.aborted) {
        var k = todo[next++], b;
        try {
          b = await getSeg(k);
          await S.put(id, k, new Blob([b]));
        } catch (e) {
          if (job.signal.aborted) return;
          failed++; lastErr = e;
          continue;
        }
        got++; meta.bytes += b.length; job.saved = true;
        meta.have = got;
        await S.putJob(meta);
        show();
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (job.signal.aborted) throw new DOMException('Pausado', 'AbortError');
    meta.have = got;
    await S.putJob(meta);
    if (failed) {
      var err = new Error(failed + (failed === 1 ? ' parte não baixou' : ' partes não baixaram') +
        ' mesmo tentando de novo (' + ((lastErr && lastErr.message) || 'erro de rede') + ').');
      err.missing = failed;
      err.hls = { id: id, segs: segs, fmp4: fmp4 };
      throw err;
    }
    // "complete" = todas as partes baixadas. Não apaga nada: se a montagem
    // falhar, a próxima tentativa só monta de novo, sem baixar.
    meta.complete = true;
    await S.putJob(meta);
    return assembleHls(id, segs, fmp4, job, false);
  }

  /* Junta as partes guardadas, lendo uma por vez do armazenamento.
     Corrige o tempo nas emendas (ver tsConverter/fmp4Fixer). Com skipMissing,
     pula as partes que não baixaram. */
  async function assembleHls(id, segs, fmp4, job, skipMissing) {
    job.status('Montando arquivo…');
    var name = ((await S.jobs()).filter(function (x) { return x.id === id; })[0] || {}).name || baseName();
    var count = segs.length, i, b, missing = 0;
    var bad = [];
    // Lê uma parte guardada. Se não existir ou não der para ler, anota para
    // baixar de novo só ela (ou pula, com skipMissing).
    async function piece(k) {
      var x = null, u8 = null;
      try { x = await S.get(id, k); if (x) u8 = await blobBytes(x); } catch (e) { x = null; }
      if (!x || !u8) { if (skipMissing) missing++; else bad.push(k); return null; }
      return { blob: x, u8: u8 };
    }
    async function redo() {
      for (var j = 0; j < bad.length; j++) await S.delChunk(id, bad[j]);
      var m = (await S.jobs()).filter(function (x) { return x.id === id; })[0];
      if (m) { m.complete = false; m.have = Math.max(0, (m.have || count) - bad.length); await S.putJob(m); }
      var e = new Error(bad.length + (bad.length === 1 ? ' parte guardada estava ilegível' : ' partes guardadas estavam ilegíveis') +
        '; baixando só ' + (bad.length === 1 ? 'ela' : 'elas') + ' de novo.');
      e.redo = true;
      return e;
    }
    function done(blob, ext) {
      return { blob: blob, name: name + '.' + ext, id: id, missing: missing };
    }
    if (fmp4) {
      var initB = await S.get(id, -1), init = initB ? await blobBytes(initB) : null;
      var fx = fmp4Fixer(init), parts = [];
      for (i = 0; i < count; i++) {
        b = await piece(i);
        if (!b) { fx.skip(); continue; }
        // sem mudança, usa a parte guardada (fica no disco, não na memória)
        var r = fx.fix(b.u8, segs[i].dur, segs[i].disc);
        parts.push(r.changed ? new Blob([r.data]) : b.blob);
        if (i % 20 === 0) job.progress((i + 1) / count, 'Montando… ' + (i + 1) + '/' + count);
      }
      if (bad.length) throw await redo();
      if (init) parts.unshift(setInitDuration(init, fx.end()));
      return done(new Blob(parts, { type: 'video/mp4' }), 'mp4');
    }
    var conv = await tsConverter();
    if (conv) {
      for (i = 0; i < count; i++) {
        b = await piece(i);
        if (!b) { conv.skip(); continue; }
        if (bad.length) continue; // já vai ter que montar de novo; só confere as outras
        conv.push(b.u8, segs[i].dur, segs[i].disc);
        job.progress((i + 1) / count, 'Convertendo para MP4… ' + (i + 1) + '/' + count);
      }
      if (bad.length) throw await redo();
      var mp4 = conv.blob();
      if (!mp4) throw fatal('Falha ao converter para MP4');
      return done(mp4, 'mp4');
    }
    var raw = [];
    for (i = 0; i < count; i++) { b = await piece(i); if (b) raw.push(b.blob); }
    if (bad.length) throw await redo();
    return done(new Blob(raw, { type: 'video/mp2t' }), 'ts');
  }

  /* Ao vivo: grava até o usuário parar (não dá para retomar uma transmissão) */
  async function downloadLive(pl, url, fmp4, job, note) {
    var init = pl.map ? await fetchBytes(pl.map, job.signal) : null;
    var raw = new Collector();
    var feed = fmp4 ? null : await tsConverter(), fx = fmp4 ? fmp4Fixer(init) : null;
    var bytes = 0, done = 0;
    function store(buf, seg) {
      bytes += buf.length;
      if (feed) feed.push(buf, seg.dur, seg.disc);
      else raw.push(fx ? fx.fix(buf, seg.dur, seg.disc).data : buf);
    }
    var last = -1, startedAt = Date.now(), firstRound = true;
    job.live(true);
    while (!job.stopped && !job.signal.aborted) {
      var fresh = pl.segments.filter(function (s) { return s.seq > last; });
      if (firstRound && fresh.length > 3) fresh = fresh.slice(-3); // começa perto do "agora"
      firstRound = false;
      for (var k = 0; k < fresh.length && !job.signal.aborted && !job.stopped; k++) {
        try { store(await fetchBytes(fresh[k].url, job.signal), fresh[k]); done++; }
        catch (e) { if (job.signal.aborted) break; if (feed) feed.skip(); else if (fx) fx.skip(); }
        last = fresh[k].seq;
        var secs = Math.round((Date.now() - startedAt) / 1000);
        job.progress(-1, 'Gravando ' + Math.floor(secs / 60) + ':' + ('0' + secs % 60).slice(-2) + ' · ' + fmtBytes(bytes) + note);
      }
      if (job.stopped || pl.ended) break;
      await sleep(Math.max(1000, pl.target * 500));
      try { pl = parseMedia(await fetchText(url, job.signal), url); } catch (e) { if (job.signal.aborted) break; }
    }
    if (job.signal.aborted && !job.stopped) throw new DOMException('Cancelado', 'AbortError');
    if (!done) throw fatal('Nada gravado');
    job.status('Montando arquivo…');
    if (fmp4) return { blob: raw.blob(setInitDuration(init, fx.end()), 'video/mp4'), name: baseName() + '.mp4' };
    if (feed) {
      var mp4 = feed.blob();
      if (!mp4) throw fatal('Falha ao converter para MP4');
      return { blob: mp4, name: baseName() + '.mp4' };
    }
    return { blob: raw.blob(null, 'video/mp2t'), name: baseName() + '.ts' };
  }

  /* ---------- Painel ---------- */

  var host = document.createElement('div');
  host.id = '__vdl_host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;right:0;bottom:0;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  root.innerHTML =
    '<style>' +
    '*{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}' +
    '.p{margin:0 auto;max-width:560px;max-height:70vh;overflow:auto;background:#1c1c1e;color:#f2f2f7;' +
    'border-radius:16px 16px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom));box-shadow:0 -6px 30px rgba(0,0,0,.45);font-size:15px;line-height:1.35}' +
    '.h{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}' +
    '.h b{font-size:17px}' +
    'button{font:inherit;font-size:15px;border:0;border-radius:10px;padding:9px 13px;background:#0a84ff;color:#fff;cursor:pointer}' +
    'button.g{background:#3a3a3c}button.r{background:#ff453a}button:disabled{opacity:.5}' +
    '.it{background:#2c2c2e;border-radius:12px;padding:10px;margin:8px 0}' +
    '.u{display:block;color:#64d2ff;font-size:12px;word-break:break-all;margin:4px 0 8px;text-decoration:none;max-height:3.6em;overflow:hidden}' +
    '.tag{display:inline-block;font-size:11px;font-weight:600;padding:2px 7px;border-radius:6px;background:#48484a;margin-right:6px;text-transform:uppercase}' +
    '.row{display:flex;gap:8px;flex-wrap:wrap}' +
    '.bar{height:6px;background:#3a3a3c;border-radius:3px;overflow:hidden;margin-top:8px;display:none}' +
    '.bar i{display:block;height:100%;width:0;background:#30d158;transition:width .2s}' +
    '.bar.ind i{width:30%;animation:m 1.2s infinite linear}' +
    '@keyframes m{from{margin-left:-30%}to{margin-left:100%}}' +
    '.s{font-size:13px;color:#aeaeb2;margin-top:6px;min-height:1em}' +
    '.s:empty{display:none}' +
    '.e{color:#ff6961}.ok{color:#30d158}.n{font-size:13px;color:#aeaeb2}' +
    '.top{display:flex;gap:10px;align-items:flex-start}' +
    '.th{position:relative;flex:0 0 112px;width:112px;height:63px;border-radius:8px;overflow:hidden;background:#000 center/cover no-repeat;' +
    'display:flex;align-items:center;justify-content:center;color:#636366;font-size:22px}' +
    '.th video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .2s}' +
    '.th video.on{opacity:1}' +
    '.th .d{position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.75);color:#fff;font-size:11px;font-weight:600;padding:1px 5px;border-radius:4px;font-variant-numeric:tabular-nums}' +
    '.info{min-width:0;flex:1}' +
    '.q{font-size:14px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}' +
    '.q:empty{display:none}' +
    '.tag.live{background:#ff453a;color:#fff}.tag.hd{background:#0a84ff;color:#fff}' +
    'select{font:inherit;font-size:15px;width:100%;margin:2px 0 8px;padding:8px;border-radius:10px;border:0;background:#3a3a3c;color:#f2f2f7}' +
    '</style>' +
    '<div class="p"><div class="h"><b>Baixar vídeo</b><span class="row">' +
    '<button class="g" data-a="scan">Atualizar</button><button class="g" data-a="close">Fechar</button></span></div>' +
    '<div class="list"></div></div>';
  var list = root.querySelector('.list');
  // Toques no painel não chegam ao site (alguns reagem a qualquer clique)
  ['click', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit']
    .forEach(function (t) { root.addEventListener(t, function (e) { e.stopPropagation(); }); });

  /* Durante o download: pausa os vídeos do site e desliga as prévias,
     para sobrar memória para o arquivo. */
  function freeMemory() {
    document.querySelectorAll('video, audio').forEach(function (v) { try { if (!v.paused) v.pause(); } catch (e) {} });
    list.querySelectorAll('.th video').forEach(function (v) {
      var th = v.parentNode;
      v.removeAttribute('src'); v.load(); v.remove();
      if (!th.style.backgroundImage) th.firstChild.textContent = '▶';
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var jobs = [];
  var finishedHere = {}; // downloads concluídos neste painel: as partes ainda são usadas para salvar
  var renderSeq = 0;
  async function render() {
    var seq = ++renderSeq;
    var res = collect();
    /* Downloads guardados: apaga os concluídos de antes e os muito antigos;
       os incompletos aparecem com "Continuar". */
    var stored = [];
    try { stored = await S.jobs(); } catch (e) {}
    if (seq !== renderSeq) return;
    var partial = {};
    stored.forEach(function (m) {
      if (finishedHere[m.id]) return;
      // apaga os já salvos (e os de versões antigas que chegaram ao fim) e os muito antigos
      if (m.done || (m.complete && !m.v) || Date.now() - m.t > 7 * 864e5) { S.del(m.id); return; }
      partial[m.url] = m;
    });
    Object.keys(partial).forEach(function (u) {
      var m = partial[u];
      var it = res.items.filter(function (x) { return x.url === u; })[0];
      if (!it) { it = { url: u, kind: m.kind, label: 'incompleto', poster: null }; res.items.unshift(it); }
      it.partial = m;
      it.choice = m.choice || it.choice;
      it.choiceKey = m.key || it.choiceKey;
    });
    list.querySelectorAll('video').forEach(function (v) { v.removeAttribute('src'); v.load(); });
    list.textContent = '';
    if (lastCrash) {
      list.appendChild(el('p', 's e', 'Da última vez a página recarregou durante "' + lastCrash.step + '". ' +
        (skipMux ? 'Agora o vídeo será salvo sem conversão: sai em .ts (abre no VLC, mas não entra na galeria).'
                 : 'Provavelmente faltou memória no iPhone: escolha uma qualidade menor.')));
    }
    if (!res.items.length) {
      var msg = el('p', 'n', 'Nenhum vídeo encontrado. Dê play no vídeo, espere alguns segundos e toque em "Atualizar".');
      list.appendChild(msg);
      if (res.blobs) list.appendChild(el('p', 'n', 'O player usa blob:, então o link real só aparece depois que o vídeo começa a carregar.'));
      return;
    }
    // Incompletos primeiro, depois HLS/arquivos do player
    res.items.sort(function (a, b) {
      var sa = (a.partial ? -4 : 0) + (a.label === 'player' ? 0 : 2) + (a.kind === 'hls' ? 0 : 1);
      var sb = (b.partial ? -4 : 0) + (b.label === 'player' ? 0 : 2) + (b.kind === 'hls' ? 0 : 1);
      return sa - sb;
    });
    var boxes = {}, previews = 0;
    res.items.forEach(function (item) {
      var box = el('div', 'it');
      boxes[item.url] = box;
      var top = el('div', 'top');
      var th = el('div', 'th', '▶');
      var dur = el('span', 'd'); dur.hidden = true;
      th.appendChild(dur);
      var poster = item.poster || (item.label === 'player' || item.label === 'og:video' ? res.poster : null);
      if (poster) { th.style.backgroundImage = 'url("' + poster.replace(/"/g, '%22') + '")'; th.firstChild.textContent = ''; }
      var info = el('div', 'info');
      var head = el('div');
      head.appendChild(el('span', 'tag', item.kind === 'hls' ? 'HLS' : extOf(item.url)));
      if (item.label) head.appendChild(el('span', 'tag', item.label));
      if (item.partial && item.label !== 'incompleto') head.appendChild(el('span', 'tag live', 'incompleto'));
      var qline = el('div', 'q');
      var a = el('a', 'u', item.url);
      a.href = item.url; a.target = '_blank'; a.rel = 'noopener';
      info.appendChild(head); info.appendChild(qline); info.appendChild(a);
      top.appendChild(th); top.appendChild(info);
      box.appendChild(top);
      var sel = el('select'); sel.hidden = true; sel.style.display = 'none';
      box.appendChild(sel);

      /* Qualidade, duração e tamanho: preenchidos aos poucos */
      var q = { h: 0, res: '', bw: 0, dur: 0, size: 0, live: false, n: 0 };
      function showInfo() {
        var parts = [];
        if (q.h) parts.push(qualityName(q.h) + (q.res ? ' (' + q.res + ')' : ''));
        if (q.bw) parts.push(fmtRate(q.bw));
        if (q.size) parts.push(fmtBytes(q.size));
        else if (q.bw && q.dur && !q.live) parts.push('~' + fmtBytes(Math.round(q.bw * q.dur / 8)));
        qline.textContent = parts.join(' · ');
        var t = q.live ? 'AO VIVO' : fmtTime(q.dur);
        dur.textContent = t; dur.hidden = !t;
        dur.style.background = q.live ? '#ff453a' : '';
      }
      function hide(u) { if (u !== item.url && boxes[u]) boxes[u].style.display = 'none'; }
      async function mediaInfo(u) {
        var t = await fetchText(u);
        var pl = parseMedia(t, u);
        q.live = !pl.ended;
        var d = 0;
        t.replace(/#EXTINF:([\d.]+)/g, function (_, x) { d += parseFloat(x); });
        if (!q.live) q.dur = d;
        showInfo();
      }
      (async function () {
        try {
          if (item.kind === 'hls') {
            var t = await fetchText(item.url);
            if (/#EXT-X-STREAM-INF/.test(t)) {
              var m = parseMaster(t, item.url);
              m.variants.forEach(function (v) { hide(v.url); });
              m.audio.forEach(hide);
              if (!m.variants.length) return;
              var cur = m.variants.filter(function (v) { return v.url === item.choice; })[0] ||
                m.variants.filter(function (v) { return item.choiceKey && variantKey(v) === item.choiceKey; })[0] || m.variants[0];
              item.choice = cur.url;
              item.choiceKey = variantKey(cur);
              Object.assign(q, { h: cur.h, res: cur.res, bw: cur.bw });
              if (m.variants.length > 1) {
                m.variants.forEach(function (v) {
                  var o = el('option', '', variantLabel(v)); o.value = v.url; sel.appendChild(o);
                });
                sel.value = cur.url;
                sel.hidden = false; sel.style.display = '';
                sel.onchange = function () {
                  var v = m.variants[sel.selectedIndex];
                  if (item.partial && item.partial.choice !== v.url && item.partial.key !== variantKey(v)) {
                    st.className = 's'; st.textContent = 'O download incompleto é de outra qualidade; esta começa do zero.';
                    idle(null);
                  } else if (item.partial) idle(pctOf(item.partial));
                  item.choice = v.url;
                  item.choiceKey = variantKey(v);
                  Object.assign(q, { h: v.h, res: v.res, bw: v.bw });
                  showInfo();
                };
                head.appendChild(el('span', 'tag hd', m.variants.length + ' qualidades'));
              }
              showInfo();
              await mediaInfo(cur.url);
            } else if (/#EXTINF/.test(t)) {
              var pl = parseMedia(t, item.url);
              q.live = !pl.ended;
              var d = 0;
              t.replace(/#EXTINF:([\d.]+)/g, function (_, x) { d += parseFloat(x); });
              if (!q.live) q.dur = d;
              showInfo();
            }
          } else {
            var r = await fetch(item.url, { method: 'HEAD' });
            q.size = +r.headers.get('content-length') || 0;
            showInfo();
          }
        } catch (e) { /* sem acesso: fica só com a prévia */ }
      })();

      /* Prévia: o próprio vídeo (o Safari do iPhone toca HLS nativamente) */
      if (previews++ < 8 && item.label !== 'áudio') {
        var pv = document.createElement('video');
        pv.muted = true; pv.playsInline = true; pv.preload = 'metadata';
        pv.setAttribute('playsinline', ''); pv.setAttribute('muted', '');
        pv.onloadedmetadata = function () {
          if (pv.videoHeight && !q.h) { q.h = pv.videoHeight; q.res = pv.videoWidth + 'x' + pv.videoHeight; }
          if (isFinite(pv.duration) && pv.duration > 0 && !q.dur) q.dur = pv.duration;
          if (pv.duration === Infinity) q.live = true;
          showInfo();
        };
        pv.onloadeddata = function () { pv.classList.add('on'); th.firstChild.textContent = ''; };
        pv.onerror = function () { pv.remove(); };
        pv.src = item.url + (item.url.indexOf('#') < 0 ? '#t=1' : '');
        th.insertBefore(pv, dur);
        box._pv = pv;
      }
      var row = el('div', 'row');
      var go = el('button', '', 'Baixar');
      var stop = el('button', 'g', 'Pausar'); stop.style.display = 'none';
      var discard = el('button', 'r', 'Descartar'); discard.style.display = 'none';
      var copy = el('button', 'g', 'Copiar link');
      row.appendChild(go); row.appendChild(stop); row.appendChild(discard); row.appendChild(copy);
      box.appendChild(row);
      var bar = el('div', 'bar'); bar.appendChild(el('i'));
      var st = el('div', 's');
      box.appendChild(bar); box.appendChild(st);
      list.appendChild(box);

      function pctOf(m) {
        if (m.complete) return 100;
        var f = m.kind === 'hls' ? (m.count ? m.have / m.count : 0) : (m.total ? m.saved / m.total : 0);
        return Math.min(99, Math.floor(f * 100));
      }
      /* Parado: "Baixar", ou "Continuar (N%)" + "Descartar" se há partes guardadas */
      function idle(pct) {
        go.disabled = false;
        stop.style.display = 'none'; stop.disabled = false;
        if (pct != null) {
          go.textContent = pct >= 100 ? 'Montar o vídeo' : 'Continuar (' + pct + '%)';
          discard.style.display = '';
          bar.style.display = 'block'; bar.classList.remove('ind'); bar.firstChild.style.width = pct + '%';
        } else {
          go.textContent = 'Baixar';
          discard.style.display = 'none';
        }
      }
      if (item.partial) {
        idle(pctOf(item.partial));
        st.className = 's';
        st.textContent = item.partial.complete
          ? 'Todas as partes' + (item.partial.name ? ' de "' + item.partial.name + '"' : '') + ' já foram baixadas. Toque em "Montar o vídeo".'
          : 'Download incompleto' + (item.partial.name ? ' ("' + item.partial.name + '")' : '') + '. Toque em Continuar para baixar só o que falta.';
      }
      discard.onclick = async function () {
        var ms = (await S.jobs()).filter(function (m) { return m.url === item.url && !finishedHere[m.id]; });
        for (var i = 0; i < ms.length; i++) await S.del(ms[i].id);
        item.partial = null;
        idle(null);
        bar.style.display = 'none';
        st.className = 's'; st.textContent = 'Partes apagadas.';
      };

      copy.onclick = function () {
        var done = function () { st.className = 's ok'; st.textContent = 'Link copiado.'; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(item.url).then(done, function () { prompt('Copie o link:', item.url); });
        } else prompt('Copie o link:', item.url);
      };

      var saveRow = el('div', 'row'); saveRow.style.marginTop = '8px'; saveRow.hidden = true; saveRow.style.display = 'none';
      box.appendChild(saveRow);

      /* Depois do download: botão para a galeria (precisa de um toque,
         o iOS só abre a folha de compartilhar a partir de um toque). */
      function offerSave(out) {
        var size = fmtBytes(out.blob.size);
        var file = galleryFile(out);
        saveRow.textContent = '';
        st.className = 's ok';
        if (!file) {
          saveBlob(out.blob, out.name);
          st.textContent = 'Pronto: ' + size + '. Confirme "Baixar"; o arquivo fica em Arquivos > Downloads.' +
            (/\.ts$/.test(out.name) ? ' A galeria não aceita .ts: abra no VLC.' :
             /\.(webm|mkv)$/.test(out.name) ? ' A galeria não aceita este formato.' : '');
          return;
        }
        var gal = el('button', '', 'Salvar na Galeria');
        var fil = el('button', 'g', 'Salvar em Arquivos');
        saveRow.appendChild(gal); saveRow.appendChild(fil);
        saveRow.hidden = false; saveRow.style.display = '';
        st.textContent = 'Pronto: ' + size + '. Toque em "Salvar na Galeria" e depois em "Salvar Vídeo".';
        gal.onclick = function () {
          navigator.share({ files: [file] }).then(function () {
            st.className = 's ok'; st.textContent = 'Enviado. Se escolheu "Salvar Vídeo", ele está no app Fotos.';
          }, function (e) {
            if (e && e.name === 'AbortError') return; // fechou a folha sem escolher
            st.className = 's e';
            st.textContent = 'Não deu para abrir o compartilhamento. Use "Salvar em Arquivos" e, no app Arquivos, compartilhe › Salvar Vídeo.';
          });
        };
        fil.onclick = function () {
          saveBlob(out.blob, out.name);
          st.className = 's ok'; st.textContent = 'Confirme "Baixar"; o arquivo fica em Arquivos > Downloads.';
        };
      }

      go.onclick = async function () {
        saveRow.hidden = true; saveRow.style.display = 'none';
        freeMemory();
        var ctrl = new AbortController();
        var job = {
          signal: ctrl.signal, stopped: false, saved: !!item.partial, frac: item.partial ? pctOf(item.partial) / 100 : 0,
          status: function (t) { st.className = 's'; st.textContent = t; mark(t); },
          progress: function (f, t) {
            if (f >= 0) job.frac = f;
            bar.style.display = 'block';
            bar.classList.toggle('ind', f < 0);
            bar.firstChild.style.width = f < 0 ? '' : Math.floor(f * 100) + '%';
            if (t) { st.className = 's'; st.textContent = t; }
          },
          live: function () { job.isLive = true; stop.textContent = 'Parar e salvar'; stop.className = ''; }
        };
        jobs.push(ctrl);
        go.disabled = true; discard.style.display = 'none';
        stop.style.display = ''; stop.textContent = 'Pausar'; stop.className = 'g';
        stop.onclick = function () {
          if (job.isLive) { job.stopped = true; stop.disabled = true; }
          else ctrl.abort();
        };
        var out = null, err = null, paused = false;
        for (var attempt = 0; ; attempt++) {
          try {
            out = await (item.kind === 'hls' ? downloadHls(item, job) : downloadFile(item, job));
            break;
          } catch (e) {
            if (ctrl.signal.aborted) { paused = true; break; }
            var msg = (e && e.message) || '';
            // Erro de rede no meio: tenta continuar sozinho (3 vezes).
            // Sem nada baixado, um TypeError costuma ser bloqueio do site (CORS).
            // Com algo já baixado, tenta de novo até com erro HTTP: a playlist é
            // lida outra vez e links expirados costumam vir renovados.
            var retry = !e.fatal && attempt < 4 && (job.saved || (!(e instanceof TypeError) && !/HTTP 4\d\d/.test(msg)));
            if (!retry) { err = e; break; }
            for (var w = [1, 2, 5, 10][attempt]; w > 0 && !ctrl.signal.aborted; w--) {
              st.className = 's'; st.textContent = (e.redo || e.missing ? e.message + ' ' : 'A conexão falhou. ') +
                'Continuando em ' + w + ' s… (' + Math.floor(job.frac * 100) + '% já guardado)';
              await sleep(1000);
            }
            if (ctrl.signal.aborted) { paused = true; break; }
          }
        }
        unmark();
        var pct = job.saved && !job.isLive ? Math.min(99, Math.floor(job.frac * 100)) : null;
        if (out) {
          if (out.id) { finishedHere[out.id] = 1; markDone(out.id); }
          item.partial = null;
          idle(null);
          job.progress(1);
          offerSave(out);
          return;
        }
        idle(pct);
        if (paused) {
          st.className = 's';
          st.textContent = pct != null ? 'Pausado. O que já baixou está guardado; toque em Continuar.' : 'Cancelado.';
          if (pct == null) bar.style.display = 'none';
          return;
        }
        st.className = 's e';
        var m = (err && err.message) || String(err);
        if (err instanceof TypeError || /fetch|Load failed|NetworkError/i.test(m))
          m = pct != null ? 'A conexão caiu.' :
            'O site bloqueou o download pelo navegador. Toque e segure no link azul acima e escolha "Baixar Arquivo Vinculado" (só para arquivos diretos), ou copie o link.';
        if (pct != null) m += ' O que já baixou (' + pct + '%) está guardado: toque em "Continuar" quando quiser' +
          (S.persistent() ? ', mesmo depois de recarregar a página.' : '.');
        else bar.style.display = 'none';
        st.textContent = m;
        // Poucas partes que não baixam de jeito nenhum: dá para salvar sem elas
        var h = err && err.hls;
        if (h && err.missing <= Math.max(3, Math.ceil(h.segs.length * 0.02))) {
          var skipBtn = el('button', 'g', 'Salvar sem ' + (err.missing === 1 ? 'a parte que falhou' : 'as ' + err.missing + ' partes que falharam'));
          saveRow.textContent = ''; saveRow.appendChild(skipBtn);
          saveRow.hidden = false; saveRow.style.display = '';
          st.textContent += ' Ou salve sem ' + (err.missing === 1 ? 'ela' : 'elas') + ': o vídeo pula esse trecho.';
          skipBtn.onclick = async function () {
            skipBtn.disabled = true; go.disabled = true; discard.style.display = 'none';
            try {
              var out2 = await assembleHls(h.id, h.segs, h.fmp4, job, true);
              finishedHere[h.id] = 1; markDone(h.id);
              item.partial = null;
              idle(null);
              job.progress(1);
              offerSave(out2);
              st.textContent = st.textContent.replace('Pronto: ', 'Pronto (sem ' + out2.missing + ' de ' + h.segs.length + ' partes): ');
            } catch (e2) {
              st.className = 's e'; st.textContent = (e2 && e2.message) || String(e2);
              skipBtn.disabled = false; go.disabled = false;
            } finally { unmark(); }
          };
        }
      };
    });
  }

  root.querySelector('[data-a="scan"]').onclick = render;
  root.querySelector('[data-a="close"]').onclick = function () { window.__vdl.close(); };
  window.__vdl = {
    close: function () {
      jobs.forEach(function (c) { try { c.abort(); } catch (e) {} });
      root.querySelectorAll('video').forEach(function (v) { v.removeAttribute('src'); v.load(); });
      host.remove();
      window.__vdl = null;
    }
  };
  (document.body || document.documentElement).appendChild(host);
  render();
})();
