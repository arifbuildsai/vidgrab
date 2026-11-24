/* VidGrab Desktop — renderer.
   A small state machine over one card: idle -> reading -> ready -> working ->
   done, with error reachable from any of them. */
(function () {
  'use strict';

  var api = window.vidgrab;

  var body = document.body;
  var form = document.getElementById('dl-form');
  var input = document.getElementById('sf_url');
  var go = document.getElementById('btn-go');
  var goLabel = document.getElementById('go-label');
  var hint = document.getElementById('hint');
  var pasteBtn = document.getElementById('btn-paste');

  var video = document.getElementById('video');
  var thumb = document.getElementById('thumb');
  var vtitle = document.getElementById('vtitle');
  var vchan = document.getElementById('vchan');
  var vdur = document.getElementById('vdur');

  var quals = document.getElementById('quals');
  var bar = document.getElementById('bar');
  var fill = document.getElementById('fill');
  var pct = document.getElementById('pct');
  var pmeta = document.getElementById('pmeta');
  var cancelBtn = document.getElementById('btn-cancel');

  var doneBox = document.getElementById('done');
  var doneWord = document.getElementById('doneword');
  var doneFile = document.getElementById('donefile');
  var revealBtn = document.getElementById('btn-reveal');
  var againBtn = document.getElementById('btn-again');

  var oops = document.getElementById('oops');
  var oopsMsg = document.getElementById('oopsmsg');
  var retryBtn = document.getElementById('btn-retry');

  var dirBtn = document.getElementById('btn-dir');
  var dirName = document.getElementById('dirname');
  var ver = document.getElementById('ver');

  var state = 'idle';
  var link = '';
  var formats = [];
  var chosen = 'best';
  var lastFile = null;
  var busy = false;

  /* ---------- plumbing ---------- */

  function setState(next) {
    state = next;
    body.dataset.state = next;
  }

  function show(el) {
    if (el.hidden) {
      el.hidden = false;
      el.classList.remove('fade');
      void el.offsetWidth; /* restart the entrance animation */
      el.classList.add('fade');
    }
  }

  function hide(el) {
    el.hidden = true;
    el.classList.remove('fade');
  }

  function setBusy(on) {
    busy = on;
    go.disabled = on;
    input.readOnly = on;
  }

  function label(text) {
    goLabel.textContent = text;
  }

  /* An IPC rejection carries a raw Error, and its message is Node's or Python's
     wording — a path, an errno, a stack frame. Nothing that looks like the
     inside of the app is allowed to become a sentence on the card. */
  function plain(e, fallback) {
    var t = e == null ? '' : (typeof e === 'string' ? e : String(e.message || e.name || e));
    if (!t.trim()) return fallback;
    if (/^(\/|[A-Za-z]:\\)|\.py:\d+|File "|ENOENT|EACCES|EPERM|ERR_[A-Z_]+|at \w+\s+\(|Cannot find module|Traceback|\[object /i.test(t)) return fallback;
    return t.slice(0, 200);
  }

  /* The reveal button promised "Show in Finder" on every platform, which reads
     as a bug on Windows and Linux. navigator.platform is enough to pick the
     right word for the file manager the user actually has. */
  function osKind() {
    var p = String(navigator.platform || '');
    if (p.indexOf('Mac') === 0) return 'mac';
    if (/^Win/i.test(p)) return 'win';
    return 'linux';
  }

  function revealLabel(hasFile) {
    if (!hasFile) return 'Open folder';
    return { mac: 'Show in Finder', win: 'Show in Explorer', linux: 'Show in Files' }[osKind()] || 'Show in folder';
  }

  function resetPanels() {
    hide(video);
    hide(quals);
    hide(bar);
    hide(doneBox);
    hide(oops);
  }

  /* What a fresh download clears: the result panels, but NOT the video card or
     the quality row. Wiping those (the old resetPanels call in startWork) left
     the app offering nothing but a re-paste once a file had landed, so saving
     the MP3 of a video you had just saved meant typing the link again. */
  function clearResults() {
    hide(bar);
    hide(doneBox);
    hide(oops);
  }

  function error(message) {
    /* Keep the video card and the quality row when they are still valid — a
       failed MP3 should not force the link to be pasted again. They are only
       cleared when nothing was read, which is the case for a bad link. */
    clearResults();
    quals.classList.remove('locked');
    if (!formats.length) { hide(video); hide(quals); }
    oopsMsg.textContent = message || 'Something went wrong. Try again.';
    show(oops);
    setBusy(false);
    label(link ? 'Try again' : 'Download');
    setState('error');
  }

  function basename(p) {
    return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
  }

  function prettyDir(p) {
    var name = basename(p);
    if (!name) return 'Downloads';
    return name;
  }

  /* Thumbnails come from YouTube; only trusted image hosts are allowed in.
     A base64 data: URL is admitted too, and it weakens nothing here: it carries
     its own bytes, so it can never make the outbound request the host list
     exists to prevent — the one source that cannot leak the user's address. It is
     how the VG_DEMO_SHOTS seam hands over a local poster (tools/verify/
     demo-video.js) for the README screenshots, so the real paint path runs
     instead of a special case in this file. Image types only, base64 only: not
     text/html, and not a URL-shaped string wearing a data: prefix. */
  function safeThumb(url) {
    try {
      if (typeof url === 'string' && /^data:image\/(png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/.test(url)) return url;
      var u = new URL(url);
      if (u.protocol !== 'https:') return null;
      var ok = /(^|\.)ytimg\.com$/.test(u.hostname) || /(^|\.)googleusercontent\.com$/.test(u.hostname) || /(^|\.)ggpht\.com$/.test(u.hostname);
      return ok ? u.href : null;
    } catch (_) {
      return null;
    }
  }

  var YT_RE = /^(https?:\/\/)?((www|m|music)\.)?youtube\.com\/|^(https?:\/\/)?youtu\.be\//i;
  function looksLikeLink(v) {
    return YT_RE.test(String(v || '').trim());
  }

  /* ---------- quality chips ---------- */

  function renderQuals(list) {
    formats = list || [];
    quals.innerHTML = '';
    quals.classList.remove('locked', 'has-saved');
    /* Select the first chip the video actually offers. Hardcoding 'best' is
       what let the button read "Save video" while no quality was selected,
       so the press failed with "that quality is not available". */
    chosen = formats.length ? formats[0].id : '';
    formats.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'qual';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', f.id === chosen ? 'true' : 'false');
      b.dataset.id = f.id;
      var t1 = document.createElement('b');
      t1.textContent = f.label || f.id;
      b.appendChild(t1);
      if (f.sub) {
        var t2 = document.createElement('span');
        t2.textContent = f.sub;
        b.appendChild(t2);
      }
      b.addEventListener('click', function () {
        /* Quality is fixed while a job is running or a link is being read —
           changing it mid-flight would not change the bytes already going. */
        if (state === 'working' || state === 'reading') return;
        chosen = f.id;
        Array.prototype.forEach.call(quals.children, function (c) {
          c.setAttribute('aria-checked', c.dataset.id === chosen ? 'true' : 'false');
        });
        quals.classList.remove('has-saved');
        label(saveLabel(f));
      });
      quals.appendChild(b);
    });
  }

  function saveLabel(f) {
    if (!f) return 'Save video';
    if (f.kind === 'mp3') return 'Save as MP3';
    if (f.kind === 'm4a') return 'Save audio';
    if (f.id === 'best') return 'Save video';
    return 'Save ' + f.label;
  }

  /* ---------- the flow ---------- */

  function readLink() {
    var v = String(input.value || '').trim();
    if (!v) {
      input.focus();
      return null;
    }
    if (!looksLikeLink(v)) {
      error('That does not look like a YouTube link. Copy the address from YouTube and try again.');
      return null;
    }
    return v;
  }

  /* Reads overlap now that one starts on its own while the link is being typed.
     Editing the field mid-read must discard the in-flight result: without this
     counter, a prefetch for link A that finished after the user typed link B
     would paint A's title and chips while B sat in the box, and pressing
     Download would save A. */
  var readSeq = 0;
  var readingUrl = '';   /* the address the in-flight read is for */

  function readFile(v) {
    resetPanels();
    /* A new link means a new plan. Leaving the previous video's chips in place
       would let error() re-show them, and pressing Download could then save
       the wrong file. */
    formats = [];
    chosen = '';
    quals.classList.remove('locked', 'has-saved');
    var my = ++readSeq;
    readingUrl = v;
    setBusy(true);
    label('Reading the video…');
    setState('reading');
    api.info(v).then(function (r) {
      if (my !== readSeq) return;
      if (!r || !r.ok) {
        error((r && r.error) || 'Could not read that link. Check it and try again.');
        return;
      }
      link = v;
      vtitle.textContent = r.title || 'YouTube video';
      vchan.textContent = r.uploader || '';
      vdur.textContent = [r.duration, r.size].filter(Boolean).join(' · ');
      var t = safeThumb(r.thumbnail);
      if (t) {
        delete thumb.dataset.loaded;
        delete thumb.dataset.broken;
        thumb.onerror = function () { thumb.dataset.broken = '1'; thumb.removeAttribute('src'); };
        thumb.onload = function () { thumb.dataset.loaded = '1'; };
        thumb.src = t;
        if (thumb.complete && thumb.naturalWidth > 0) thumb.dataset.loaded = '1';
        show(video);
      } else {
        hide(video);
      }
      renderQuals(r.formats);
      if (!formats.length) {
        /* Nothing this video offers can be saved. Say that plainly rather
           than showing a Download button that will only fail. */
        error('This video cannot be saved — YouTube is not offering any downloadable stream for it (it may be a live or protected video).');
        return;
      }
      show(quals);
      if (r.needsFfmpeg) hint.textContent = 'Audio only as M4A — install ffmpeg for MP3 conversion.';
      else hint.textContent = 'MP4 saves H.264 + AAC, so it opens straight in QuickTime.';
      var def = formats.filter(function (f) { return f.id === chosen; })[0] || formats[0];
      label(saveLabel(def));
      setBusy(false);
      setState('ready');
    }).catch(function (e) {
      if (my !== readSeq) return;
      error(plain(e, 'Could not reach the downloader. Try again.'));
    });
  }

  /* Pressing Download while a read is still running must not be a dead click.
     The prefetch makes that window real: the link is pasted, the read starts on
     its own, and the user presses before it finishes. So the press is remembered
     and honoured the moment the plan lands. */
  var wantStartWhenReady = false;

  function startWork() {
    /* Last line of defence: never send a download the plan cannot answer. */
    if (!chosen || !formats.some(function (f) { return f.id === chosen; })) {
      error('Pick a quality first.');
      return;
    }
    clearResults();
    quals.classList.add('locked');
    setBusy(true);
    /* A new job starts with no rate. Leaving the previous one's numbers here
       would print a stale speed on a bar that has not moved yet. */
    lastSpeed = '';
    lastEta = '';
    fill.style.width = '0%';
    pct.textContent = '0%';
    pmeta.textContent = 'Preparing…';
    show(bar);
    label('Working…');
    setState('working');
    api.start(link, chosen).then(function (r) {
      if (r && r.cancelled) {
        idleAgain(false);
        return;
      }
      if (!r || !r.ok) {
        error((r && r.error) || 'The download did not finish. Try again.');
        return;
      }
      lastFile = r.file || null;
      hide(bar);
      /* Nothing was fetched when the same quality was already on disk, so the
         panel must not claim a save it did not do. */
      doneWord.textContent = r.already ? 'Already saved' : 'Saved';
      doneFile.textContent = lastFile ? basename(lastFile) : 'in ' + prettyDir(r.dir) + ' folder';
      revealBtn.textContent = revealLabel(lastFile);
      show(doneBox);
      setBusy(false);
      quals.classList.remove('locked');
      /* Tick the chip that this file came from, and leave the row live: the
         same video can be saved again at another quality without pasting it
         twice. */
      Array.prototype.forEach.call(quals.children, function (c) {
        c.classList.toggle('saved', c.dataset.id === chosen);
        c.setAttribute('aria-checked', c.dataset.id === chosen ? 'true' : 'false');
      });
      quals.classList.add('has-saved');
      label('Download another');
      setState('done');
    }).catch(function (e) {
      error(plain(e, 'The download did not finish. Try again.'));
    });
  }

  /* The field no longer holds the link that was read, so the plan behind the
     chips belongs to a different video and has to go. Keeping it meant the
     button could save the previous video while the box showed a new address. */
  function dropPlan() {
    clearResults();
    hide(video);
    hide(quals);
    quals.classList.remove('locked', 'has-saved');
    formats = [];
    chosen = '';
    link = '';
    setBusy(false);
    label('Download');
    setState('idle');
  }

  function idleAgain(clearLink) {
    if (clearLink) {
      dropPlan();
      input.value = '';
      hint.textContent = 'Works with regular videos, Shorts and YouTube Music links.';
    } else {
      /* Cancelled: the video on screen is still the video that was read, so
         keep the card and the chips and let the button start it again. */
      clearResults();
      quals.classList.remove('locked', 'has-saved');
      if (!formats.length) { hide(video); hide(quals); }
      setBusy(false);
      label(saveLabel(formats.filter(function (f) { return f.id === chosen; })[0] || formats[0]));
      setState(formats.length ? 'ready' : 'idle');
    }
    input.focus();
  }

  function onSubmit(e) {
    if (e) e.preventDefault();
    if (busy || state === 'working') return;

    var v = readLink();
    if (!v) return;
    /* The box holds a link that was already read: save the quality that is
       selected. Anything else is a new video and has to be read first. This
       one rule covers ready, done and error, which used to each have their own
       branch — and which is why a second press in the done state re-saved the
       first quality instead of the one just picked. */
    if (v === link && formats.length) { startWork(); return; }
    readFile(v);
  }

  /* ---------- clipboard button ---------- */

  function doPaste() {
    api.paste().then(function (text) {
      var v = String(text || '').trim();
      if (!v) {
        hint.textContent = 'Your clipboard is empty — paste with ' + (osKind() === 'mac' ? 'Cmd+V' : 'Ctrl+V') + '.';
        return;
      }
      input.value = v;
      input.focus();
      if (looksLikeLink(v) && state !== 'working') readFile(v);
      else if (!looksLikeLink(v)) error('The clipboard does not hold a YouTube link.');
    });
  }

  /* ---------- wiring ---------- */

  if (!api || !api.isDesktop) {
    /* Opened in a plain browser: say so instead of failing silently. */
    resetPanels();
    oopsMsg.textContent = 'This is the VidGrab desktop interface. Run it inside the VidGrab app, where the downloader lives.';
    show(oops);
    go.disabled = true;
    setState('idle');
    return;
  }

  form.addEventListener('submit', onSubmit);
  pasteBtn.addEventListener('click', doPaste);
  cancelBtn.addEventListener('click', function () {
    pmeta.textContent = 'Cancelling…';
    cancelBtn.disabled = true;
    api.cancel();
  });
  retryBtn.addEventListener('click', function () {
    if (link) readFile(link);
    else { idleAgain(true); input.focus(); }
  });
  againBtn.addEventListener('click', function () { idleAgain(true); });
  revealBtn.addEventListener('click', function () { api.reveal(lastFile || ''); });
  dirBtn.addEventListener('click', function () {
    api.chooseDir().then(function (d) { dirName.textContent = prettyDir(d); });
  });

  input.addEventListener('input', function () {
    /* Editing the address after a plan has been read invalidates it, in every
       state — ready included, where the old code left the previous video's chips
       live while the box held a different link. */
    if (link && String(input.value || '').trim() !== link) dropPlan();
    scheduleRead();
  });

  /* Reading a link takes a few seconds — the engine lookup plus YouTube's own
     answer. Starting it as soon as the text looks like a link means that wait
     overlaps with whatever the user does next, instead of beginning only when
     they press Download. With the Python engine it is short, but it is never
     free, and a paste followed by a click is the common case. */
  var readTimer = null;
  function scheduleRead() {
    if (readTimer) clearTimeout(readTimer);
    if (busy || (state !== 'idle' && state !== 'error')) return;
    var v = String(input.value || '').trim();
    if (!looksLikeLink(v) || v === link) return;
    readTimer = setTimeout(function () {
      readTimer = null;
      if (!busy && (state === 'idle' || state === 'error') && looksLikeLink(String(input.value || '').trim())) {
        readFile(String(input.value || '').trim());
      }
    }, 700);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state === 'working') {
      e.preventDefault();
      api.cancel();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  });

  /* menu shortcuts, delivered from the main process */
  api.on('vg:shortcut', function (what) {
    if (what === 'focus') { input.focus(); input.select(); }
    if (what === 'paste-start') { doPaste(); }
  });

  api.on('vg:engine', function (p) {
    if (state !== 'working' && state !== 'reading') return;
    pmeta.textContent = 'Preparing the downloader… ' + Math.round(p && p.pct ? p.pct : 0) + '%';
  });

  var lastSpeed = '';
  var lastEta = '';

  api.on('vg:progress', function (p) {
    if (!p) return;
    var v = Math.max(0, Math.min(100, Number(p.pct) || 0));
    fill.style.width = v + '%';
    pct.textContent = (v < 10 ? v.toFixed(1) : Math.round(v)) + '%';

    /* Speed and ETA are held, never cleared mid-download. A stall is shown as
       a stall — honest wording, still on screen — rather than blanking, which
       is what made a pause look like a dead app. They are only dropped before
       the first byte and after the last one, when there is no rate to report
       and the phase note speaks for itself. */
    if (p.speed) lastSpeed = p.speed;
    if (p.eta) lastEta = p.eta;
    /* Held for the whole job, including the assemble and encode phases at the
       end. An earlier version blanked them the moment the phase left
       'downloading', which is the same visual failure as a pause wiping them:
       the numbers disappear while work is still being done. They are cleared
       only when a new job starts, in startWork. */

    /* Numbers first, explanation last. This line is ellipsised on a narrow
       window, so anything at the end is the first thing lost — and the ETA is
       precisely what must survive. */
    var bits = [];
    if (lastSpeed) bits.push(p.stalled ? 'paused · ' + lastSpeed : lastSpeed);
    if (lastEta) bits.push('ETA ' + lastEta);
    if (p.phase === 'downloading') bits.push('of ' + (p.size || 'the file'));
    else if (p.phase === 'starting') bits.push('Connecting to YouTube');
    else if (p.phase === 'done') bits.push('Writing the file…');
    if (p.note) bits.push(p.note);
    bar.classList.toggle('stalled', !!p.stalled);
    pmeta.textContent = bits.join(' · ') || 'Downloading…';
    show(bar);
  });

  api.on('vg:cancelled', function () {
    if (state !== 'working') return;
    idleAgain(false);
    hint.textContent = 'Cancelled. Press Download to start again.';
  });

  api.on('vg:done', function (info) {
    if (info && info.file) lastFile = info.file;
  });

  api.on('vg:error', function (e) {
    error(plain(e, 'The download did not finish.'));
  });

  api.on('vg:fatal', function (e) {
    error(plain(e, 'The interface could not load.'));
  });

  /* ---------- boot ---------- */

  api.version().then(function (v) {
    if (v && v.version) ver.textContent = 'v' + v.version;
  }).catch(function () {});

  api.getDir().then(function (d) {
    dirName.textContent = prettyDir(d);
  }).catch(function () { dirName.textContent = 'Downloads'; });

  setState('idle');
  window.setTimeout(function () { input.focus(); }, 60);
})();
