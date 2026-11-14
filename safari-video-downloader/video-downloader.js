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
    function add(u, kind, label) {
      if (!u) return;
      if (u.indexOf('blob:') === 0) { blobs++; return; }
      if (u.indexOf('data:') === 0) return;
      u = abs(u);
      if (!u || found.has(u)) return;
      if (!kind) kind = HLS_RE.test(u) ? 'hls' : 'file';
      found.set(u, { url: u, kind: kind, label: label || '' });
    }
    function scan(doc) {
      doc.querySelectorAll('video, audio').forEach(function (v) {
        add(v.currentSrc, null, v.tagName === 'AUDIO' ? 'áudio' : 'player');
        add(v.getAttribute('src') && v.src, null, 'player');
        v.querySelectorAll('source[src]').forEach(function (s) { add(s.src, null, 'player'); });
      });
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
    return { items: Array.from(found.values()), blobs: blobs };
  }

  /* ---------- Utilidades ---------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
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

  function pickVariant(text, url) {
    var lines = text.split(/\r?\n/), best = null, audioSep = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (l.indexOf('#EXT-X-MEDIA:') === 0 && /TYPE=AUDIO/.test(l) && attr(l, 'URI')) audioSep = true;
      if (l.indexOf('#EXT-X-STREAM-INF:') === 0) {
        var bw = parseInt(attr(l, 'BANDWIDTH'), 10) || 0;
        var u = (lines[i + 1] || '').trim();
        if (u && u[0] !== '#' && (!best || bw > best.bw)) best = { bw: bw, url: abs(u, url), res: attr(l, 'RESOLUTION') };
      }
    }
    if (best) best.audioSep = audioSep;
    return best;
  }

  async function downloadHls(item, job) {
    job.status('Lendo playlist…');
    var url = item.url;
    var text = await fetchText(url, job.signal);
    if (!/^#EXTM3U/.test(text.trim())) throw new Error('Não é uma playlist HLS');
    var note = '';
    if (/#EXT-X-STREAM-INF/.test(text)) {
      var v = pickVariant(text, url);
      if (!v) throw new Error('Playlist sem variantes');
      if (v.audioSep) note = ' (áudio vem separado neste site; o vídeo pode ficar sem som)';
      url = v.url;
      job.status('Qualidade: ' + (v.res || Math.round(v.bw / 1000) + ' kbps') + note);
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
    '.e{color:#ff6961}.ok{color:#30d158}.n{font-size:13px;color:#aeaeb2}' +
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
    res.items.forEach(function (item) {
      var box = el('div', 'it');
      var head = el('div');
      head.appendChild(el('span', 'tag', item.kind === 'hls' ? 'HLS' : extOf(item.url)));
      if (item.label) head.appendChild(el('span', 'tag', item.label));
      box.appendChild(head);
      var a = el('a', 'u', item.url);
      a.href = item.url; a.target = '_blank'; a.rel = 'noopener';
      box.appendChild(a);
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
      host.remove();
      window.__vdl = null;
    }
  };
  (document.body || document.documentElement).appendChild(host);
  render();
})();
