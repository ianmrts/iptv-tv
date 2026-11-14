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

  function saveBlob(blob, name) {
    var a = document.createElement('a');
    var href = URL.createObjectURL(blob);
    a.href = href;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(href); }, 120000);
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

  async function fetchBytes(url, signal) {
    return new Uint8Array(await (await fetchRetry(url, { signal: signal })).arrayBuffer());
  }

  var muxPromise = null;
  function loadMux() {
    if (window.muxjs) return Promise.resolve(window.muxjs);
    if (!muxPromise) {
      muxPromise = new Promise(function (res) {
        var s = document.createElement('script');
        s.src = MUXJS_URL;
        s.onload = function () { res(window.muxjs || null); };
        s.onerror = function () { res(null); };
        setTimeout(function () { res(window.muxjs || null); }, 15000);
        (document.head || document.documentElement).appendChild(s);
      });
    }
    return muxPromise;
  }

  /* ---------- Download de arquivo direto ---------- */

  async function downloadFile(item, job) {
    job.status('Conectando…');
    var r = await fetchRetry(item.url, { signal: job.signal }, 2);
    var total = +r.headers.get('content-length') || 0;
    var type = r.headers.get('content-type') || '';
    var parts = [], got = 0;
    if (r.body && r.body.getReader) {
      var reader = r.body.getReader();
      for (;;) {
        var x = await reader.read();
        if (x.done) break;
        parts.push(x.value);
        got += x.value.length;
        job.progress(total ? got / total : -1, fmtBytes(got) + (total ? ' de ' + fmtBytes(total) : ''));
      }
    } else {
      parts.push(new Uint8Array(await r.arrayBuffer()));
    }
    var blob = new Blob(parts, { type: type || 'video/mp4' });
    saveBlob(blob, baseName() + '.' + extOf(item.url, type));
    return fmtBytes(blob.size);
  }

  /* ---------- HLS ---------- */

  function attr(line, name) {
    var m = new RegExp('(?:^|[:,])' + name + '=("([^"]*)"|[^,]*)').exec(line);
    return m ? (m[2] !== undefined ? m[2] : m[1]) : null;
  }

  function parseMedia(text, url) {
    var lines = text.split(/\r?\n/);
    var p = { segments: [], seq: 0, target: 6, ended: /#EXT-X-ENDLIST/.test(text), map: null, key: null, byterange: false };
    var seq = null;
    lines.forEach(function (l) {
      l = l.trim();
      if (!l) return;
      if (l.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) p.seq = parseInt(l.slice(22), 10) || 0;
      else if (l.indexOf('#EXT-X-TARGETDURATION:') === 0) p.target = parseFloat(l.slice(22)) || 6;
      else if (l.indexOf('#EXT-X-MAP:') === 0) p.map = abs(attr(l, 'URI'), url);
      else if (l.indexOf('#EXT-X-KEY:') === 0) { var m = attr(l, 'METHOD'); if (m && m !== 'NONE') p.key = m; }
      else if (l.indexOf('#EXT-X-BYTERANGE') === 0) p.byterange = true;
      else if (l[0] !== '#') {
        if (seq === null) seq = p.seq;
        p.segments.push({ url: abs(l, url), seq: seq++ });
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

  function variantLabel(v) {
    var q = qualityName(v.h) || 'Qualidade';
    return q + (v.res ? ' (' + v.res + ')' : '') + (v.bw ? ' · ' + fmtRate(v.bw) : '');
  }

  async function downloadHls(item, job) {
    job.status('Lendo playlist…');
    var url = item.url;
    var text = await fetchText(url, job.signal);
    if (!/^#EXTM3U/.test(text.trim())) throw new Error('Não é uma playlist HLS');
    var note = '';
    if (/#EXT-X-STREAM-INF/.test(text)) {
      var m = parseMaster(text, url);
      if (!m.variants.length) throw new Error('Playlist sem variantes de vídeo');
      var v = m.variants.filter(function (x) { return x.url === item.choice; })[0] || m.variants[0];
      if (m.audioSep) note = ' (áudio vem separado neste site; o vídeo pode ficar sem som)';
      url = v.url;
      job.status('Qualidade: ' + variantLabel(v) + note);
      text = await fetchText(url, job.signal);
    }
    var pl = parseMedia(text, url);
    if (pl.key) throw new Error('Stream criptografado (' + pl.key + '), não suportado');
    if (pl.byterange) throw new Error('Playlist com BYTERANGE, não suportada');
    if (!pl.segments.length) throw new Error('Playlist vazia');

    var fmp4 = !!pl.map || /\.(m4s|mp4|m4v|cmfv)(\?|$)/i.test(pl.segments[0].url);
    var init = pl.map ? await fetchBytes(pl.map, job.signal) : null;
    var mux = null, muxed = [], muxInit = null;
    if (!fmp4) {
      job.status('Carregando conversor MP4…');
      var muxjs = await loadMux();
      if (muxjs) {
        mux = new muxjs.mp4.Transmuxer();
        mux.on('data', function (s) {
          if (!muxInit) muxInit = s.initSegment;
          muxed.push(new Uint8Array(s.data));
        });
      }
    }
    var raw = [];
    var bytes = 0, done = 0;
    function store(buf) {
      bytes += buf.length;
      if (mux) { mux.push(buf); mux.flush(); } else raw.push(buf);
    }

    if (pl.ended) {
      // VOD: baixa em paralelo (4 de cada vez) mantendo a ordem
      var segs = pl.segments, results = new Array(segs.length), next = 0, written = 0;
      async function worker() {
        while (next < segs.length && !job.signal.aborted) {
          var i = next++;
          results[i] = await fetchBytes(segs[i].url, job.signal);
          done++;
          while (written < segs.length && results[written]) { store(results[written]); results[written] = null; written++; }
          job.progress(done / segs.length, done + '/' + segs.length + ' partes · ' + fmtBytes(bytes) + note);
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (job.signal.aborted) throw new Error('Cancelado');
    } else {
      // Ao vivo: grava até o usuário parar
      var last = -1, startedAt = Date.now();
      job.live(true);
      var firstRound = true;
      while (!job.stopped && !job.signal.aborted) {
        var fresh = pl.segments.filter(function (s) { return s.seq > last; });
        if (firstRound && fresh.length > 3) fresh = fresh.slice(-3); // começa perto do "agora"
        firstRound = false;
        for (var k = 0; k < fresh.length && !job.signal.aborted && !job.stopped; k++) {
          try { store(await fetchBytes(fresh[k].url, job.signal)); done++; } catch (e) { if (job.signal.aborted) break; }
          last = fresh[k].seq;
          var secs = Math.round((Date.now() - startedAt) / 1000);
          job.progress(-1, 'Gravando ' + Math.floor(secs / 60) + ':' + ('0' + secs % 60).slice(-2) + ' · ' + fmtBytes(bytes) + note);
        }
        if (job.stopped || pl.ended) break;
        await sleep(Math.max(1000, pl.target * 500));
        try { pl = parseMedia(await fetchText(url, job.signal), url); } catch (e) { if (job.signal.aborted) break; }
      }
      if (job.signal.aborted && !job.stopped) throw new Error('Cancelado');
      if (!done) throw new Error('Nada gravado');
    }

    job.status('Montando arquivo…');
    var blob, ext;
    if (fmp4) {
      blob = new Blob([init || new Uint8Array(0)].concat(raw), { type: 'video/mp4' }); ext = 'mp4';
    } else if (mux && muxInit && muxed.length) {
      blob = new Blob([muxInit].concat(muxed), { type: 'video/mp4' }); ext = 'mp4';
    } else {
      if (mux) throw new Error('Falha ao converter para MP4');
      blob = new Blob(raw, { type: 'video/mp2t' }); ext = 'ts';
    }
    saveBlob(blob, baseName() + '.' + ext);
    return fmtBytes(blob.size) + (ext === 'ts' ? ' (.ts: abra no VLC)' : '');
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

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var jobs = [];
  function render() {
    var res = collect();
    list.querySelectorAll('video').forEach(function (v) { v.removeAttribute('src'); v.load(); });
    list.textContent = '';
    if (!res.items.length) {
      var msg = el('p', 'n', 'Nenhum vídeo encontrado. Dê play no vídeo, espere alguns segundos e toque em "Atualizar".');
      list.appendChild(msg);
      if (res.blobs) list.appendChild(el('p', 'n', 'O player usa blob:, então o link real só aparece depois que o vídeo começa a carregar.'));
      return;
    }
    // HLS master/arquivos do player primeiro
    res.items.sort(function (a, b) {
      var sa = (a.label === 'player' ? 0 : 2) + (a.kind === 'hls' ? 0 : 1);
      var sb = (b.label === 'player' ? 0 : 2) + (b.kind === 'hls' ? 0 : 1);
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
              item.choice = m.variants[0].url;
              Object.assign(q, { h: m.variants[0].h, res: m.variants[0].res, bw: m.variants[0].bw });
              if (m.variants.length > 1) {
                m.variants.forEach(function (v) {
                  var o = el('option', '', variantLabel(v)); o.value = v.url; sel.appendChild(o);
                });
                sel.hidden = false; sel.style.display = '';
                sel.onchange = function () {
                  var v = m.variants[sel.selectedIndex];
                  item.choice = v.url;
                  Object.assign(q, { h: v.h, res: v.res, bw: v.bw });
                  showInfo();
                };
                head.appendChild(el('span', 'tag hd', m.variants.length + ' qualidades'));
              }
              showInfo();
              await mediaInfo(m.variants[0].url);
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
      var stop = el('button', 'r', 'Cancelar'); stop.style.display = 'none';
      var copy = el('button', 'g', 'Copiar link');
      row.appendChild(go); row.appendChild(stop); row.appendChild(copy);
      box.appendChild(row);
      var bar = el('div', 'bar'); bar.appendChild(el('i'));
      var st = el('div', 's');
      box.appendChild(bar); box.appendChild(st);
      list.appendChild(box);

      copy.onclick = function () {
        var done = function () { st.className = 's ok'; st.textContent = 'Link copiado.'; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(item.url).then(done, function () { prompt('Copie o link:', item.url); });
        } else prompt('Copie o link:', item.url);
      };

      go.onclick = async function () {
        var ctrl = new AbortController();
        var job = {
          signal: ctrl.signal, stopped: false,
          status: function (t) { st.className = 's'; st.textContent = t; },
          progress: function (f, t) {
            bar.style.display = 'block';
            bar.classList.toggle('ind', f < 0);
            bar.firstChild.style.width = f < 0 ? '' : Math.round(f * 100) + '%';
            if (t) { st.className = 's'; st.textContent = t; }
          },
          live: function () { stop.textContent = 'Parar e salvar'; stop.className = ''; }
        };
        jobs.push(ctrl);
        go.disabled = true; stop.style.display = ''; stop.textContent = 'Cancelar'; stop.className = 'r';
        stop.onclick = function () {
          if (stop.textContent === 'Parar e salvar') { job.stopped = true; stop.disabled = true; }
          else ctrl.abort();
        };
        try {
          var size = await (item.kind === 'hls' ? downloadHls(item, job) : downloadFile(item, job));
          job.progress(1);
          st.className = 's ok';
          st.textContent = 'Pronto: ' + size + '. Confirme "Baixar"; o arquivo fica em Arquivos > Downloads.';
        } catch (e) {
          bar.style.display = 'none';
          st.className = 's e';
          var m = (e && e.message) || String(e);
          if (e && (e.name === 'AbortError' || ctrl.signal.aborted)) m = 'Cancelado.';
          else if (e instanceof TypeError || /fetch|Load failed|NetworkError/i.test(m))
            m = 'O site bloqueou o download pelo navegador. Toque e segure no link azul acima e escolha "Baixar Arquivo Vinculado" (só para arquivos diretos), ou copie o link.';
          st.textContent = m;
        } finally {
          go.disabled = false; stop.style.display = 'none'; stop.disabled = false;
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
