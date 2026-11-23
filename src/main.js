/* VidGrab Desktop — Electron main process.
   One window, one job: paste a YouTube link, save the video.
   There is no website here and no way to navigate away from the app UI. */
'use strict';

const { app, BrowserWindow, Menu, shell, net, dialog, clipboard, nativeTheme, ipcMain, nativeImage } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

/* The interface lives beside src/ in both dev and packaged builds (app.asar/ui). */
const UI_INDEX = path.join(__dirname, '..', 'ui', 'index.html');

/* VidGrab's own mark. electron-builder reads build/icon.icns for the packaged
   .app, but that file never reaches a running `electron .` session, so the
   window and the Dock fall back to Electron's logo. Loading the PNG explicitly
   fixes it in dev, and build/icon.png is bundled into the asar for the same
   reason on Windows and Linux. */
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');
let iconCache;

function appIcon() {
  if (iconCache !== undefined) return iconCache;
  let img = null;
  try {
    const loaded = nativeImage.createFromPath(ICON_PATH);
    if (loaded && !loaded.isEmpty()) img = loaded;
  } catch (_) {}
  iconCache = img;
  return img;
}

const ENGINE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const ENGINE_NAME = { darwin: 'yt-dlp_macos', linux: 'yt-dlp', win32: 'yt-dlp.exe' }[process.platform] || 'yt-dlp';
const ENGINE_TARBALL = ENGINE_BASE + 'yt-dlp.tar.gz';
/* A real yt-dlp build is tens of MB. Anything smaller is a failed fetch or an
   error page, and caching it is what made the old app throw EACCES forever. */
const MIN_ENGINE_BYTES = 512 * 1024;
const MIN_SOURCE_BYTES = 200 * 1024;
const XATTR = '/usr/bin/xattr';

let win = null;
let job = null;            // active yt-dlp child process
let engineTask = null;     // in-flight engine fetch, shared by all callers
let ffmpegCache;           // undefined = not looked up yet
let engineCache;           // proven engine descriptor, reused for the session
let lastError = null;
/* VG_DEBUG=1 prints which engine and which path each job took. Off by default:
   the app should never write its internals anywhere the user can see. */
const DEBUG = !!(process.env.VG_DEBUG || '').trim();
/* Test seam, only live under VG_DEBUG. VG_FORCE_ENGINE=1 makes every job take
   the engine path instead of the direct fetch, so the fallback that serves HLS
   and DASH videos and recovers from an expired stream URL can be exercised on
   demand instead of waiting for one to fail in the wild. */
const FORCE_ENGINE = DEBUG && !!(process.env.VG_FORCE_ENGINE || '').trim();
/* Test seam, likewise. VG_POISON_URLS=1 replaces the parked stream URLs with a
   dead address right before the fast path runs, so the "stream expired →
   recover through the engine" route is exercised on demand instead of waiting
   hours for a signature to actually rot. */
const POISON_URLS = DEBUG && !!(process.env.VG_POISON_URLS || '').trim();
const planCache = new Map(); // url -> resolved format plan from the last read

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch (_) { return {}; }
}
function writeSettings(patch) {
  const next = Object.assign(readSettings(), patch);
  try { fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2)); } catch (_) {}
  return next;
}
function downloadDir() {
  const s = readSettings();
  const dir = s.downloadDir && fs.existsSync(s.downloadDir) ? s.downloadDir : app.getPath('downloads');
  return dir;
}

const enginePath = () => path.join(app.getPath('userData'), 'bin', ENGINE_NAME);

/* ---------- the download engine ---------- */

/* Is the cached engine actually a runnable binary? Reads the first four bytes
   so an HTML error page or a truncated body is never treated as a good cache. */
function engineIsSane(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return false; }
  if (!st.isFile() || st.size < MIN_ENGINE_BYTES) return false;
  const b = Buffer.alloc(4);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, b, 0, 4, 0);
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  const macho64 = b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe;
  const macho32 = b[0] === 0xce && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe;
  const fat = (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe) ||
              (b[0] === 0xbe && b[1] === 0xba && b[2] === 0xfe && b[3] === 0xca);
  const elf = b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
  const pe = b[0] === 0x4d && b[1] === 0x5a;
  return macho64 || macho32 || fat || elf || pe;
}

function makeExecutable(file) {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (!(mode & 0o100)) fs.chmodSync(file, mode | 0o755);
  } catch (_) {}
  /* A file pulled over the network can carry a quarantine attribute, which
     makes macOS refuse to exec it. spawnSync, not spawn: an async spawn error
     is emitted on the 'error' event and would take down the main process. */
  if (process.platform === 'darwin' && fs.existsSync(XATTR)) {
    try { spawnSync(XATTR, ['-d', 'com.apple.quarantine', file], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
  }
}

/* ---------- the engine, and why Python is worth preferring ----------

   Measured on this machine: the single-file yt-dlp build spends 28-31 seconds
   unpacking itself before it does anything at all — `yt-dlp --version` with no
   network takes 30 s. The same release running through python3 from the release
   tarball takes under a second, and a full link extraction drops from 29 s to
   about 8 s. Extraction and download both pay that toll, so when a Python 3
   interpreter new enough for yt-dlp is present the app uses it. The standalone
   binary stays as the fallback for machines without one. */

const PY_MIN = [3, 11];   /* yt-dlp refuses anything older, outright */

/* macOS ships a system trust bundle, but a python.org build carries no CA store
   of its own unless its extra "Install Certificates" step was run. Pointing
   Python at the OS bundle keeps certificate verification ON; without it every
   HTTPS fetch dies with CERTIFICATE_VERIFY_FAILED, which is exactly what made
   the first Python attempt fail. */
function caBundle() {
  const cands = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'];
  for (const p of cands) {
    try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

/* GNU tar lives at /usr/bin/tar on macOS and most Linux distros. Windows 10+
   ships bsdtar on PATH as tar.exe and has no /usr/bin at all, so the hardcoded
   path made engine setup fail outright there. */
function tarBin() {
  if (process.platform === 'win32') return 'tar';
  return fs.existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar';
}

/* The release tarball wraps everything in one top-level folder. Dropping
   --strip-components and descending here instead of relying on that flag: GNU
   tar understands it, bsdtar on Windows does not, so the flat extract plus this
   lookup behaves the same on all three platforms. */
function engineRoot(staging) {
  if (srcEngineIsSane(staging)) return staging;
  let kids = [];
  try { kids = fs.readdirSync(staging, { withFileTypes: true }); } catch (_) { return null; }
  const dirs = kids.filter((k) => k.isDirectory());
  if (dirs.length !== 1) return null;
  const inner = path.join(staging, dirs[0].name);
  return srcEngineIsSane(inner) ? inner : null;
}

/* Every directory a real Python install might hide behind on Windows. */
function winPythonRoots() {
  const out = [];
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  if (local) out.push(path.join(local, 'Programs', 'Python'));
  out.push(pf, pf86, 'C:\\');
  out.push(path.join(os.homedir(), 'scoop', 'apps', 'python'));
  return out;
}

function pythonCandidates() {
  const win = process.platform === 'win32';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exe = win ? 'python.exe' : 'python3';
  const out = [];

  const add = (p) => {
    if (!p || !path.isAbsolute(p) || out.indexOf(p) !== -1) return;
    try {
      const st = fs.statSync(p);
      /* On Windows X_OK says little about a real executable; insist on a file.
         The Microsoft Store leaves a zero-byte python3 alias on PATH that only
         opens the Store, and it is filtered out here as well as by the probe. */
      if (st.isFile() && (!win || /\.exe$/i.test(p))) out.push(p);
    } catch (_) {}
  };

  if (win) {
    /* The `py` launcher is the most dependable sign of a Windows install. */
    if (process.env.SystemRoot) add(path.join(process.env.SystemRoot, 'py.exe'));
    add(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Launcher', 'py.exe'));
    for (const parent of winPythonRoots()) {
      let kids = [];
      try { kids = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { continue; }
      for (const k of kids) {
        if (!k.isDirectory() || !/python/i.test(k.name)) continue;
        add(path.join(parent, k.name, exe));
        add(path.join(parent, k.name, 'python3.exe'));
      }
    }
  } else {
    /* Homebrew and /usr/local first: /usr/bin/python3 is Apple's stale 3.9,
       which yt-dlp rejects. */
    for (const p of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) add(p);
  }
  for (const d of dirs) add(path.join(d, exe));
  return out;
}

function pythonVersion(p) {
  const r = spawnSync(p, ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])'],
    { timeout: 15000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return null;
  const m = /(\d+)\.(\d+)/.exec(String(r.stdout || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/* Only used to decide whether fetching the source engine is worth trying before
   it exists on disk. Once it does, pythonFor() settles the question for real. */
function suitablePython() {
  for (const p of pythonCandidates()) {
    const v = pythonVersion(p);
    if (v && (v[0] > PY_MIN[0] || (v[0] === PY_MIN[0] && v[1] >= PY_MIN[1]))) return p;
  }
  return null;
}

function engineEnv(py, dir, ffmpegPath) {
  const env = spawnEnv(ffmpegPath);
  env.PYTHONDONTWRITEBYTECODE = '1';
  if (dir) env.PYTHONPATH = dir;
  const ca = caBundle();
  if (ca) {
    env.SSL_CERT_FILE = ca;
    env.REQUESTS_CA_BUNDLE = ca;
  }
  return env;
}

/* The only test that matters: does this interpreter actually run this engine,
   over HTTPS? Version floors and PATH guesses both burned an earlier attempt —
   -E silently discarded the PYTHONPATH the engine was found by, and a 3.15
   build with no CA bundle starts fine then fails every request. So the probe
   runs the real thing and checks the exit code. */
function pythonFor(dir) {
  for (const py of pythonCandidates()) {
    const zipapp = path.join(dir, 'yt-dlp');
    if (fs.existsSync(zipapp)) {
      const z = spawnSync(py, [zipapp, '--version'],
        { env: engineEnv(py, dir, null), timeout: 25000, windowsHide: true, stdio: 'ignore' });
      if (z.status === 0) return { py: py, mode: 'zipapp' };
    }
    const m = spawnSync(py, ['-s', '-B', '-m', 'yt_dlp', '--version'],
      { env: engineEnv(py, dir, null), timeout: 25000, windowsHide: true, stdio: 'ignore' });
    if (m.status === 0) return { py: py, mode: 'module' };
  }
  return null;
}

function srcEngineDir() {
  return path.join(app.getPath('userData'), 'engine-src');
}

function srcEngineIsSane(dir) {
  try {
    return fs.statSync(path.join(dir, 'yt_dlp', '__main__.py')).isFile();
  } catch (_) {
    return false;
  }
}

function isGzip(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/* Download the release tarball, prove it is whole, unpack it. Same rule as the
   binary: nothing half-written is ever treated as a usable engine. */
async function fetchSrcEngine(dir) {
  const tmp = dir + '.tar.gz.part';
  fs.mkdirSync(dir, { recursive: true });
  try { fs.unlinkSync(tmp); } catch (_) {}

  let res;
  try {
    res = await net.fetch(ENGINE_TARBALL, { method: 'GET', redirect: 'follow' });
  } catch (e) {
    throw new Error('Could not reach the download engine. Check your internet connection.');
  }
  if (!res.ok) {
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
    throw new Error('The download engine is unavailable right now (HTTP ' + res.status + ').');
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(tmp);
  let written = 0;
  try {
    if (!res.body) throw new Error('Empty response while fetching the download engine.');
    const reader = res.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buf = Buffer.from(chunk.value);
      written += buf.length;
      if (!out.write(buf)) await new Promise((ok) => out.once('drain', ok));
      if (total) send('vg:engine', { pct: Math.min(99, (written / total) * 100), bytes: written, total });
    }
    await new Promise((ok, err) => { out.end(() => ok()); out.once('error', err); });
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }

  const head = Buffer.alloc(2);
  let fd;
  try {
    fd = fs.openSync(tmp, 'r');
    fs.readSync(fd, head, 0, 2, 0);
  } catch (_) {
    head[0] = 0;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  if (written < MIN_SOURCE_BYTES || !isGzip(head)) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('The download engine came through damaged. Please try again.');
  }

  const staging = dir + '.new';
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const x = spawnSync(tarBin(), ['-xzf', tmp, '-C', staging],
    { windowsHide: true, stdio: 'ignore' });
  try { fs.unlinkSync(tmp); } catch (_) {}
  const root = engineRoot(staging);
  if (x.status !== 0 || !root) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('The download engine came through damaged. Please try again.');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(root, dir);
  fs.rmSync(staging, { recursive: true, force: true });
  send('vg:engine', { pct: 100, bytes: written, total: written });
  return dir;
}

/* Self-healing: a poisoned, truncated or non-executable cache is cleared and
   refetched instead of being handed to spawn() forever. Returns an engine
   descriptor, never a bare path. The proven descriptor is cached for the rest
   of the session, so the probe is paid once, not once per download. */
async function ensureEngine() {
  if (engineCache) return engineCache;

  const dir = srcEngineDir();
  if (srcEngineIsSane(dir)) {
    const py = pythonFor(dir);
    if (py) {
      engineCache = { kind: 'src', py: py.py, mode: py.mode, dir: dir };
      return engineCache;
    }
    /* The engine is on disk but no interpreter here can run it. Do not keep
       probing on every job; fall through to the standalone binary. */
  } else if (suitablePython()) {
    if (!engineTask) {
      engineTask = fetchSrcEngine(dir)
        .then(() => {
          const py = pythonFor(dir);
          return py ? { kind: 'src', py: py.py, mode: py.mode, dir: dir } : null;
        })
        .catch((e) => { lastError = e; return null; })
        .finally(() => { engineTask = null; });
    }
    const got = await engineTask;
    if (got) {
      engineCache = got;
      return got;
    }
    /* No Python engine: fall through to the standalone binary. */
  }

  const dest = enginePath();
  if (!engineIsSane(dest)) {
    for (const stale of [dest, dest + '.part']) {
      try { fs.unlinkSync(stale); } catch (_) {}
    }
    if (!engineTask) {
      engineTask = fetchEngine().finally(() => { engineTask = null; });
    }
    await engineTask;
  } else {
    makeExecutable(dest);
  }
  engineCache = { kind: 'bin', bin: enginePath() };
  return engineCache;
}

/* Drop a cache that has proved damaged, so the next call rebuilds it instead of
   handing the same broken engine to spawn() forever. */
function invalidateEngine(engine) {
  engineCache = null;
  if (!engine) return;
  if (engine.kind === 'bin') {
    try { fs.unlinkSync(engine.bin); } catch (_) {}
  } else if (engine.kind === 'src') {
    try { fs.rmSync(engine.dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/* Turn an engine descriptor plus yt-dlp's own arguments into a real spawn. */
function engineSpawn(engine, args, ffmpegPath) {
  if (engine && engine.kind === 'src') {
    const env = engineEnv(engine.py, engine.dir, ffmpegPath);
    if (engine.mode === 'zipapp') {
      /* The tarball's launcher is a self-contained zipapp: it carries yt_dlp
         and its optional dependencies inside one file, so nothing has to be
         found on PYTHONPATH. */
      return { file: engine.py, args: [path.join(engine.dir, 'yt-dlp')].concat(args), env: env };
    }
    return { file: engine.py, args: ['-s', '-B', '-m', 'yt_dlp'].concat(args), env: env };
  }
  return { file: engine ? engine.bin : enginePath(), args: args, env: spawnEnv(ffmpegPath) };
}

/* Fetch the standalone binary to a temp file, prove it is whole, then move it
   into place. Used when no python3 is available. */
async function fetchEngine() {
  const dest = enginePath();
  const tmp = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.unlinkSync(tmp); } catch (_) {}

  let res;
  try {
    res = await net.fetch(ENGINE_BASE + ENGINE_NAME, { method: 'GET', redirect: 'follow' });
  } catch (e) {
    throw new Error('Could not reach the download engine. Check your internet connection.' + (e && e.message ? ' (' + e.message + ')' : ''));
  }
  if (!res.ok) {
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
    throw new Error('The download engine is unavailable right now (HTTP ' + res.status + '). Try again in a minute.');
  }

  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(tmp);
  let written = 0;
  try {
    if (!res.body) throw new Error('Empty response while fetching the download engine.');
    const reader = res.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buf = Buffer.from(chunk.value);
      written += buf.length;
      if (!out.write(buf)) await new Promise((ok) => out.once('drain', ok));
      if (total) send('vg:engine', { pct: Math.min(99, (written / total) * 100), bytes: written, total });
    }
    await new Promise((ok, err) => { out.end(() => ok()); out.once('error', err); });
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }

  if (!engineIsSane(tmp)) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('The download engine came through damaged. Please try again.');
  }
  makeExecutable(tmp);
  fs.renameSync(tmp, dest);
  send('vg:engine', { pct: 100, bytes: written, total: written });
  return dest;
}

/* ---------- ffmpeg (needed to turn audio into MP3) ---------- */

function findFfmpeg() {
  if (ffmpegCache !== undefined) return ffmpegCache;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    /* The usual ways ffmpeg arrives on Windows: a manual C:\ffmpeg build, the
       winget and Chocolatey shims, and scoop's shims folder. */
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    dirs.push('C:\\ffmpeg\\bin', path.join(pf, 'ffmpeg', 'bin'), path.join(pf86, 'ffmpeg', 'bin'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
      'C:\\ProgramData\\chocolatey\\bin',
      path.join(os.homedir(), 'scoop', 'shims'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'));
  }
  dirs.push(path.join(app.getPath('userData'), 'bin'));
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  let found = null;
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try { fs.accessSync(p, fs.constants.X_OK); found = p; break; } catch (_) {}
    }
    if (found) break;
  }
  ffmpegCache = found;
  return found;
}

function spawnEnv(ffmpegPath) {
  const env = Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', LANG: (process.env.LANG || 'en_US.UTF-8') });
  if (ffmpegPath) {
    const dir = path.dirname(ffmpegPath);
    if ((env.PATH || '').indexOf(dir) === -1) env.PATH = dir + path.delimiter + (env.PATH || '');
  }
  return env;
}

/* ---------- yt-dlp ---------- */

function runYtDlp(engine, args, env, onLine) {
  return new Promise((resolve, reject) => {
    const s = engineSpawn(engine, args, findFfmpeg());
    const p = spawn(s.file, s.args, { env: env || s.env, windowsHide: true });
    let out = '';
    let err = '';
    const eat = (stream) => {
      let carry = '';
      stream.on('data', (d) => {
        carry += String(d);
        const parts = carry.split(/[\r\n]+/);
        carry = parts.pop();
        for (const line of parts) {
          if (onLine) onLine(line);
          if (stream === p.stdout) out += line + '\n';
          else err += line + '\n';
        }
      });
    };
    eat(p.stdout);
    eat(p.stderr);
    p.on('error', reject);
    p.on('close', (code, signal) => {
      if (signal) return resolve({ code: -1, signal, out, err });
      resolve({ code, out, err });
    });
  });
}

const YT_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'ytimg.com'];
function isYouTubeLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  return YT_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

function humanSize(bytes) {
  if (!bytes || bytes < 0) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
}

function humanDuration(sec) {
  if (!sec || sec < 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}

/* A stream the app can fetch itself: one whole file over plain HTTPS, not an
   HLS/DASH manifest split into thousands of fragments. Those are the formats
   whose URL in the extraction is the actual media. */
function progressive(f) {
  return !!(f && f.url && (f.protocol === 'https' || f.protocol === 'http') && !/m3u8|mpd|manifest/i.test(String(f.protocol)));
}

function streamOf(f) {
  return {
    id: String(f.format_id),
    url: f.url,
    ext: f.ext || 'mp4',
    bytes: Number(f.filesize) || Number(f.filesize_approx) || 0,
    vcodec: f.vcodec || '',
    acodec: f.acodec || '',
  };
}

/* Pick the real formats behind each quality chip.

   Two rules the previous version broke, both found by running it:
   - ext=mp4 is not enough. YouTube ships AV1 (396/398/399) inside an MP4
     container, and QuickTime will not play it. Pin the codec to avc1.
   - Decide the format IDs here, once, and hand them to yt-dlp on the
     download. Letting yt-dlp re-rank "best mp4" later is what quietly served
     396+140 (AV1) when the user asked for 360p. */
function pickPlan(meta, ffmpegPath) {
  const src = Array.isArray(meta.formats) ? meta.formats : [];
  /* A plan is only returned if it carries at least one chip. Every chip that
     reaches the screen is therefore downloadable: the app never offers a
     quality it cannot deliver, which is what made the old build say
     "that quality is not available" after showing the button. */
  return planFrom(src, meta, ffmpegPath, true)
    || planFrom(src, meta, ffmpegPath, false)
    || { chips: [], byId: {}, videoId: meta.id || null, direct: false };
}

/* First pass: progressive streams only, which the app can fetch itself with no
   second engine spawn. Second pass, used only if a video offers nothing else:
   accept HLS and DASH too and let the yt-dlp fallback handle them. A video with
   no H.264 at all still gets its audio chip rather than an empty list. */
function planFrom(src, meta, ffmpegPath, wantProgressive) {
  const ok = wantProgressive ? progressive : function () { return true; };
  const bytesOf = (f) => (f ? Number(f.filesize) || Number(f.filesize_approx) || Number(f.frag_size) || 0 : 0);
  const hasVideo = (f) => !!(f.vcodec && f.vcodec !== 'none');
  const hasAudio = (f) => !!(f.acodec && f.acodec !== 'none');
  const isH264 = (f) => /^avc1/i.test(String(f.vcodec || ''));
  const isAAC = (f) => /^mp4a/i.test(String(f.acodec || ''));
  const quality = (f) => (f.tbr || 0) || (bytesOf(f) / Math.max(1, meta.duration || 1));

  const sep = src.filter((f) => hasVideo(f) && !hasAudio(f) && isH264(f) && ok(f));
  const single = src.filter((f) => hasVideo(f) && hasAudio(f) && isH264(f) && isAAC(f) && ok(f));
  const audios = src.filter((f) => hasAudio(f) && !hasVideo(f) && isAAC(f) && ok(f));
  const bestAudio = audios.slice().sort((a, b) => (b.audio_quality || 0) - (a.audio_quality || 0) || bytesOf(b) - bytesOf(a))[0];

  const plan = { chips: [], byId: {}, videoId: meta.id || null };

  const sub = (parts) => parts.filter(Boolean).join(' · ');
  const heightTag = (h) => (h >= 2160 ? '4K' : h >= 1440 ? '2K' : h >= 1080 ? 'Full HD' : h >= 720 ? 'HD' : h ? h + 'p' : '');

  const tbrOf = (f) => Number(f && f.tbr) || 0;
  const atHeight = (list, h) => list.filter((f) => f.height === h)
    .sort((a, b) => tbrOf(b) - tbrOf(a) || bytesOf(b) - bytesOf(a))[0];

  /* Two ways to reach the same resolution: a video-only stream plus the audio
     stream (merged by ffmpeg), or a progressive file that already carries both.
     Older videos serve their highest H.264 only as a progressive file — format
     18 at 360p — while the separate streams stop at 240p. Ranking only the
     separate streams made "Best" offer LESS than the video can actually give.
     So each height is decided from both pools, on total bitrate. */
  const candidateAt = (h) => {
    const cands = [];
    const v = atHeight(sep, h);
    if (v && bestAudio) {
      /* Either size can be absent from the manifest. Showing the audio's size
         alone as the total would make 240p and 144p look identically sized, so
         an unknown video stream means no size is claimed at all. */
      const vb = bytesOf(v);
      const ab = bytesOf(bestAudio);
      cands.push({
        sel: v.format_id + '+' + bestAudio.format_id,
        bytes: vb && ab ? vb + ab : 0,
        tbr: tbrOf(v) + tbrOf(bestAudio),
        merge: true, height: h,
        streams: wantProgressive ? [streamOf(v), streamOf(bestAudio)] : null,
      });
    } else if (v) {
      cands.push({ sel: String(v.format_id), bytes: bytesOf(v), tbr: tbrOf(v), merge: false, height: h, streams: wantProgressive ? [streamOf(v)] : null });
    }
    const p = atHeight(single, h);
    if (p) cands.push({ sel: String(p.format_id), bytes: bytesOf(p), tbr: tbrOf(p), merge: false, height: h, streams: wantProgressive ? [streamOf(p)] : null });
    if (!cands.length) return null;
    /* Without ffmpeg there is nothing to mux, so a file that already carries
       both tracks is the only honest choice at this height. */
    if (!ffmpegPath) {
      const solo = cands.filter((c) => !c.merge);
      if (solo.length) return solo.sort((a, b) => (b.tbr - a.tbr) || (b.bytes - a.bytes))[0];
    }
    cands.sort((a, b) => (b.tbr - a.tbr) || (b.bytes - a.bytes));
    return cands[0];
  };

  const heights = [];
  for (const f of sep.concat(single)) {
    if (f.height && f.height >= 144 && heights.indexOf(f.height) === -1) heights.push(f.height);
  }
  heights.sort((a, b) => b - a);

  const chosen = [];
  for (const h of heights) {
    const c = candidateAt(h);
    if (c) chosen.push(c);
  }

  const chipFor = (key, c) => {
    plan.byId[key] = c;
    plan.chips.push({ id: key, kind: 'mp4', label: key === 'best' ? 'Best' : c.height + 'p', sub: sub([key === 'best' ? heightTag(c.height) : '', c.bytes ? humanSize(c.bytes) : '']) });
  };

  if (chosen.length) {
    chipFor('best', chosen[0]);
    /* Keep the row short, and never repeat the quality "Best" already is. */
    const rest = chosen.filter((c) => c.sel !== chosen[0].sel);
    const useful = rest.filter((c) => c.height >= 360);
    for (const c of (useful.length ? useful : rest).slice(0, 3)) {
      chipFor('h' + c.height, c);
    }
  }

  if (bestAudio) {
    const atag = sub([bestAudio.acodec && bestAudio.acodec.replace(/^mp4a\.[0-9.]+\s*/, '').toUpperCase(), humanSize(bytesOf(bestAudio))]) || 'audio only';
    if (ffmpegPath) {
      plan.byId.mp3 = { sel: bestAudio.format_id, bytes: bytesOf(bestAudio), audio: true, toMp3: true, streams: wantProgressive ? [streamOf(bestAudio)] : null };
      plan.chips.push({ id: 'mp3', kind: 'mp3', label: 'MP3', sub: atag });
    } else {
      /* No ffmpeg: a single m4a stream still saves without any conversion. */
      plan.byId.m4a = { sel: bestAudio.format_id, bytes: bytesOf(bestAudio), audio: true, streams: wantProgressive ? [streamOf(bestAudio)] : null };
      plan.chips.push({ id: 'm4a', kind: 'm4a', label: 'M4A', sub: atag });
    }
  }
  /* Empty plans fall through so the HLS pass gets a chance. Returning a
     chip-less object here is what made the app show a Download button with no
     quality behind it, then refuse the press. */
  return plan.chips.length ? plan : null;
}

/* Arguments every yt-dlp invocation shares.
   No extractor-args tricks: an earlier version passed player_skip=m3u8 to shave
   a few seconds off extraction, but that silently removes the HLS formats from
   the manifest, so the quality list could shrink or empty out. The saving was
   ~3 s against a ~30 s engine start, and the start is now hidden behind typing
   and paid only once per job — so keep every format the video offers. */
function baseArgs() {
  return ['--no-playlist', '--no-warnings', '--newline',
    '--socket-timeout', '20', '-R', '10', '--retries', '10'];
}

/* Build the yt-dlp argument list from a resolved plan entry. */
function argsFor(entry) {
  /* Deliberately no --no-progress: the [download] lines still carry the
     destination and phase messages we parse. The percentage bar itself is
     driven off the file on disk, because the bundled engine block-buffers these
     lines behind an 8 KB wall when stdout is a pipe.
     --no-part makes each stream grow under its real name, so the size we poll
     is the size that counts. */
  const a = baseArgs().concat(['--no-part', '--concurrent-fragments', '4']);
  if (entry.toMp3) {
    a.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  }
  a.push('-f', entry.sel);
  /* An audio chip names one audio-only stream, so there is nothing to merge and
     no flag is needed. --no-merge was pushed here by an earlier version and
     does not exist in this release: the engine answered
     "yt-dlp: error: no such option: --no-merge" and every MP3 on the fallback
     path failed at the start. Only a video+audio pair asks for a container. */
  if (!entry.audio && entry.merge) a.push('--merge-output-format', 'mp4');
  return a;
}

/* Where a finished extraction is parked so the download can reuse it. */
function metaDir() {
  const d = path.join(app.getPath('userData'), 'meta');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

/* Parked extractions are only good for a few hours; clear what has aged out
   so the folder does not grow with the user's history. */
function pruneMeta() {
  const d = metaDir();
  let entries = [];
  try { entries = fs.readdirSync(d); } catch (_) { return; }
  const cut = Date.now() - 12 * 3600 * 1000;
  for (const n of entries) {
    if (n.slice(-5) !== '.json') continue;
    try {
      if (fs.statSync(path.join(d, n)).mtimeMs < cut) fs.unlinkSync(path.join(d, n));
    } catch (_) {}
  }
}

async function videoInfo(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return { ok: false, error: 'Paste a YouTube link first.' };
  if (!isYouTubeLink(url)) return { ok: false, error: 'That does not look like a YouTube link. Copy the address from YouTube and try again.' };
  let engine;
  try {
    engine = await ensureEngine();
  } catch (e) {
    return { ok: false, error: userError(e, 'Could not prepare the download engine. Check your internet connection and try again.') };
  }
  const ffmpegPath = findFfmpeg();
  try {
    /* No explicit env here: engineSpawn sets PYTHONPATH for the Python engine,
       and overriding it would make the source tree invisible to the child. */
    const r = await runYtDlp(engine, baseArgs().concat(['-J', url]));
    if (r.code !== 0) {
      return { ok: false, error: cleanEngineError(r.err || r.out) };
    }
    const meta = JSON.parse(r.out);
    const plan = pickPlan(meta, ffmpegPath);
    plan.title = meta.title || 'video';
    /* Park the whole extraction on disk. On a machine with no Python, where the
       standalone engine spends ~30 s unpacking itself, handing this back with
       --load-info-json skips a second extraction. With the Python engine a
       fresh lookup costs under a second, so the live URL is used instead and
       the parked file is only a fallback. */
    if (meta.id) {
      const file = path.join(metaDir(), String(meta.id) + '.json');
      try {
        fs.writeFileSync(file, r.out);
        plan.infoJson = file;
        plan.at = Date.now();
        pruneMeta();
      } catch (_) {}
    }
    /* Remember what we resolved for this exact link, so the download uses the
       same format IDs the chips were built from. */
    planCache.set(url, plan);
    return {
      ok: true,
      id: meta.id || null,
      title: meta.title || 'YouTube video',
      uploader: meta.channel || meta.uploader || '',
      duration: humanDuration(meta.duration),
      seconds: meta.duration || 0,
      thumbnail: meta.thumbnail || null,
      size: plan.byId.best ? humanSize(plan.byId.best.bytes) : '',
      formats: plan.chips,
      needsFfmpeg: !ffmpegPath,
    };
  } catch (e) {
    if (e instanceof SyntaxError) return { ok: false, error: 'The video details came back unreadable. Try again.' };
    return { ok: false, error: userError(e, 'Could not read that link. Check the address and try again.') };
  }
}

/* yt-dlp's stderr is long and full of ANSI; show the one line that means it. */
/* Is this failure the engine itself, rather than the video or the network?
   Those must never reach the user as text: they are fixable by switching engine
   or refetching, and a Python traceback means nothing to anyone. */
function engineLevelFailure(text) {
  const t = String(text || '');
  return /CERTIFICATE_VERIFY_FAILED|unable to get local issuer|ImportError|ModuleNotFoundError|No module named|unsupported version of Python|Traceback \(most recent call last\)|EACCES|EPERM|Permission denied|Not a directory|cannot execute binary file|quarantine/i.test(t);
}

function cleanEngineError(text) {
  const lines = String(text || '').split(/[\r\n]+/).map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(Boolean);
  const err = lines.filter((l) => /^ERROR/i.test(l)).pop();
  /* yt-dlp prefixes its own tag: "[youtube:truncated_id]", "[download]",
     "[Extractor]". It names an internal subsystem, so strip it before the
     sentence is judged or shown. */
  const line = String(err || lines.pop() || '').replace(/^\[[a-z0-9_.:-]+\]\s*/i, '');
  if (engineLevelFailure(line) || engineLevelFailure(text)) {
    if (/CERTIFICATE_VERIFY_FAILED|local issuer/i.test(text)) return 'The download engine could not verify YouTube\'s certificate. Trying again with the built-in engine.';
    return 'The download engine is not working on this computer. It will repair itself on the next attempt.';
  }
  /* A link that is not a complete video address is the user's typo, and the
     engine's wording ("Incomplete YouTube ID", "looks truncated") is its
     diagnostics, not an explanation. */
  if (/truncated|Incomplete YouTube ID|not a valid YouTube|Invalid URL|no video id|Unsupported URL/i.test(line)) {
    return 'That link is not a complete YouTube video address. Copy the whole thing from the browser bar and try again.';
  }
  if (/Sign in to confirm|not available in your country|Premium/i.test(line)) return 'YouTube will not serve this video anonymously — it may be age-restricted, members-only or region-locked.';
  if (/Private video|Unavailable/i.test(line)) return 'This video is private or unavailable.';
  if (/Video unavailable|Removed/i.test(line)) return 'This video has been removed from YouTube.';
  if (/getaddrinfo|ENOTFOUND|Network is unreachable|Unable to connect/i.test(line)) return 'No internet connection right now. Check your network and try again.';
  if (/Extracting|ffmpeg/i.test(line)) return 'Converting this format needs ffmpeg, which is not installed. Try MP4 instead.';
  /* A raw engine line is never shown as-is: it is either a Python path or a
     stack frame, and pasting one at the user is what put
     ".../python3: No module named yt_dlp" on the screen. */
  if (/^\/|\.py:\d+|File "/.test(line)) return 'Something went wrong reading that video. Try again.';
  return line ? line.replace(/^ERROR:\s*/, '').slice(0, 200) : 'YouTube refused that link. Check the address and try again.';
}

/* The one door every message leaves by. Node and Python both describe their own
   failures — "spawn /usr/local/bin/python3 ENOENT", an errno, a stack frame —
   and none of that means anything to someone trying to save a video. Anything
   that still looks like internals after cleanEngineError has had its chance is
   replaced by the plain fallback. */
function userError(e, fallback) {
  const text = e == null ? '' : (typeof e === 'string' ? e : String((e && (e.stack || e.message)) || e));
  const said = cleanEngineError(text);
  if (!text.trim()) return fallback || 'Something went wrong. Try again.';
  if (/^(\/|[A-Za-z]:\\)|\.py:\d+|File "|ENOENT|EACCES|EPERM|ERR_[A-Z_]+|at \w+\s+\(|Cannot find module|Traceback/i.test(said)) {
    return fallback || 'Something went wrong. Try again.';
  }
  return said;
}

/* ---------- the job ---------- */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const MEDIA_EXT = ['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.mp3', '.m4a', '.opus', '.wav', '.aac', '.flac'];

/* Find the file we just wrote: prefer the paths yt-dlp printed, then fall back
   to whatever this job touched in the destination folder. */
function resolveOutput(dir, candidates, videoId, startedAt) {
  for (const c of candidates) {
    if (c && fs.existsSync(c) && !/\.part$|\.ytdl$/.test(c)) return c;
  }
  const hits = mineEntries(dir, videoId, candidates, startedAt)
    .filter((e) => !e.temp && MEDIA_EXT.indexOf(path.extname(e.name).toLowerCase()) !== -1)
    .sort((a, b) => b.mtime - a.mtime);
  return hits.length ? path.join(dir, hits[0].name) : null;
}

const DEST_RE = /\[(?:download|ExtractingAudio|ExtractAudio|Merger)\][^:]*destination:\s*(.+)/i;
const MERGE_RE = /Merging formats into\s+"?(.+?)"?\s*$/i;

/* Files this job owns. Only entries touched after the job started count,
   otherwise a leftover download of the same video from an earlier run is
   mistaken for progress and the bar jumps straight to 99%. */
function mineEntries(dir, videoId, candidates, startedAt) {
  const names = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return names; }
  const wanted = [];
  for (const c of candidates) { const b = path.basename(c); if (b && wanted.indexOf(b) === -1) wanted.push(b); }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const n = e.name;
    const mine = (videoId && n.indexOf('[' + videoId + ']') !== -1) ||
                 wanted.some((w) => n === w || n === w + '.part' || n.indexOf(w + '.f') === 0);
    if (!mine) continue;
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch (_) { continue; }
    if (st.mtimeMs < startedAt - 1500) continue;
    names.push({ name: n, size: st.size, mtime: st.mtimeMs, temp: /\.part$|\.ytdl$|\.part\./.test(n) });
  }
  return names;
}

function jobBytes(dir, videoId, candidates, startedAt) {
  /* yt-dlp downloads some streams through a sidecar (".mp4-Frag39") that is
     later folded into the real file. Counting both would double the bytes and
     slam the bar into its ceiling, so each stream contributes its largest
     single on-disk presence. */
  const best = new Map();
  for (const e of mineEntries(dir, videoId, candidates, startedAt)) {
    const key = e.name.replace(/-Frag\d+$/i, '');
    const prev = best.get(key) || 0;
    if (e.size > prev) best.set(key, e.size);
  }
  let sum = 0;
  for (const v of best.values()) sum += v;
  return sum;
}

/* Remove everything a cancelled job left behind. Only files this job created
   (mtime at or after its start) and that carry its video ID or one of its
   destination names are touched, so a finished file from an earlier press of a
   different quality survives untouched. With --no-part an interrupted stream
   grows under its real name, so this is the only thing standing between a
   cancel and a truncated file that plays as a corrupt one. */
function sweepJob(dir, videoId, candidates, startedAt) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  const wanted = [];
  for (const c of candidates || []) { const b = path.basename(c); if (b && wanted.indexOf(b) === -1) wanted.push(b); }
  let removed = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const n = e.name;
    const mine = (videoId && n.indexOf('[' + videoId + ']') !== -1) ||
                 wanted.some((w) => n === w || n === w + '.part' || n.indexOf(w + '.f') === 0 || n.indexOf(w + '-Frag') === 0);
    if (!mine) continue;
    const full = path.join(dir, n);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.mtimeMs < startedAt - 1500) continue;
    try { fs.unlinkSync(full); removed++; } catch (_) {}
  }
  if (DEBUG && removed) console.log('[vg] swept ' + removed + ' leftover file(s) from a cancelled job');
  return removed;
}

/* Delete a job's scratch folder, retrying if something still holds it. A cancel
   tears down an in-flight write stream, and the directory can refuse to go for
   a few hundred milliseconds while the descriptor closes. One attempt was what
   left .vidgrab-<pid>-<id>-tmp sitting in the downloads folder after Cancel. */
function rmTmp(dir, tries) {
  const left = tries === undefined ? 8 : tries;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (_) {}
  if (left <= 0) return false;
  const t = setTimeout(() => rmTmp(dir, left - 1), 350);
  if (t.unref) t.unref();
  return false;
}

/* Scratch folders from a crashed or killed run have no other collector: the
   app never looks in the downloads folder on launch, and a hidden dot-folder is
   invisible to the user. Every job sweeps the ones older than five minutes
   before starting, so nothing accumulates. Folders from a job still running are
   younger than that and left alone. */
function sweepStaleTmp(dir) {
  const cut = Date.now() - 5 * 60 * 1000;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.indexOf('.vidgrab-') !== 0 || e.name.indexOf('-tmp') !== e.name.length - 4) continue;
    const full = path.join(dir, e.name);
    try { if (fs.statSync(full).mtimeMs > cut) continue; } catch (_) { continue; }
    if (rmTmp(full, 1)) removed++;
  }
  if (DEBUG && removed) console.log('[vg] cleared ' + removed + ' stale scratch folder(s)');
  return removed;
}

/* One filename per quality. Without the suffix, asking for 480p after 720p
   would hit the same [id].mp4 name, yt-dlp would skip the download and the
   app would happily report the 720p file as the 480p one. */
function suffixFor(entry) {
  if (entry.toMp3) return ' MP3';
  if (entry.audio) return '';
  if (entry.height) return ' ' + entry.height + 'p';
  return '';
}

function alreadySaved(dir, videoId, suffix) {
  if (!videoId) return null;
  const esc = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\[' + videoId + '\\]' + esc + '\\.(?:mp4|m4a|mp3|webm|mkv|mov|m4v)$', 'i');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  const hits = [];
  for (const e of entries) {
    if (!e.isFile() || !re.test(e.name)) continue;
    try { hits.push({ name: e.name, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs }); } catch (_) {}
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits.length ? path.join(dir, hits[0].name) : null;
}

async function resolveEntry(url, fmtId) {
  const want = fmtId || 'best';
  let plan = planCache.get(url);
  if (!plan || !plan.byId[want]) {
    const info = await videoInfo(url);
    if (!info.ok) return { error: info.error };
    plan = planCache.get(url);
  }
  if (!plan) return { error: 'This video could not be read. Try again.' };
  /* The chip the user pressed always wins. Falling back to another quality
     would save something different from what was asked for. */
  let entry = plan.byId[want];
  if (!entry && !plan.chips.length) return { error: 'This video cannot be saved — YouTube is not offering any downloadable stream for it.' };
  if (!entry) entry = plan.byId[plan.chips[0].id];
  return { entry: entry, plan: plan };
}

/* ---------- fetching the bytes without a second engine spawn ----------

   Measured on this machine: `yt-dlp --version` — no network, no extraction —
   takes 28 to 31 seconds. The bundled engine is a single-file PyInstaller
   build that unpacks itself on every launch, so that toll was paid TWICE per
   download: once to read the link, once to fetch it. That is the "YouTube is
   slow to answer" stretch, and no extractor flag touches it.

   The extraction parked at read time already carries a direct HTTPS URL for
   every progressive stream, so the app can pull those bytes through
   Chromium's own network stack instead. One spawn, not two — and the byte
   count arrives on every chunk, which is exact progress rather than a polled
   file size. The engine path below stays as the fallback for HLS/DASH streams
   and for URLs that have expired. */

const MEDIA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function canFetchDirect(entry, ffmpegPath) {
  if (!entry || !Array.isArray(entry.streams) || !entry.streams.length) return false;
  if (!entry.streams.every((s) => s && s.url)) return false;
  /* Two streams still have to be muxed together, which needs ffmpeg. */
  if (entry.streams.length > 1 && !ffmpegPath) return false;
  if (entry.toMp3 && !ffmpegPath) return false;
  return true;
}

/* YouTube throttles an open-ended stream request and serves the very same bytes
   at full speed when the request declares a range. Measured on this machine,
   same minute, same 13 MB stream:
     GET, no Range header            ->   24 KiB/s
     GET, Range: bytes=0-3299999     -> 1.10 MB/s
     four ranged requests at once    ->  the whole file in ~6s
   So no request here is ever open-ended. The first slice is small so the bar
   starts moving almost at once; the rest is pulled in parallel slices written
   straight to their offsets, which also means no second copy of the file is
   ever made and no reassembly step is needed at the end. */
const SEG_FIRST = 1024 * 1024;      /* probe slice: fast first progress movement */
const SEG_SIZE = 4 * 1024 * 1024;   /* settled slice size once the stream's length is known */
const SEG_THREADS = 4;              /* ranged requests in flight per stream */

function cancelError() {
  const e = new Error('cancelled');
  e.code = 'ABORTED';
  return e;
}

/* One ranged GET. Resolves with the live response so the caller can consume it
   its own way; every exit path deregisters from the job, so a finished slice
   can never be aborted again by a later Cancel. */
function rangedGet(url, from, to, myJob, live) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url });
    req.setHeader('User-Agent', MEDIA_UA);
    req.setHeader('Referer', 'https://www.youtube.com/');
    req.setHeader('Accept', '*/*');
    req.setHeader('Accept-Language', 'en-US,en;q=0.9');
    req.setHeader('Range', 'bytes=' + from + '-' + (to == null ? '' : to));
    const off = () => { myJob.reqs.delete(req); myJob.hooks.delete(hook); live.delete(req); };
    const hook = () => { off(); reject(cancelError()); };
    myJob.reqs.add(req);
    myJob.hooks.add(hook);
    live.add(req);
    req.on('error', (e) => { off(); reject(e); });
    /* Aborting is not enough to end this promise: Electron's net stack
       guarantees no reliable event for a self-inflicted abort, so the old
       single-connection version hung here forever — runDirect never returned,
       its cleanup never ran, and .vidgrab-<pid>-<id>-tmp sat in the downloads
       folder with a truncated stream in it until an unrelated job swept it
       away. cancelJob now knocks on every hook directly, and this listener
       covers the case where a real event does arrive. */
    req.on('abort', hook);
    req.on('response', (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        const code = res.statusCode;
        off();
        res.resume(); /* drain it, or the socket is held open for nothing */
        return reject(new Error(code === 403 || code === 410
          ? 'The stream address expired. Trying again with a fresh lookup.'
          : 'YouTube answered ' + code + ' for that stream.'));
      }
      resolve({ res, status: res.statusCode, off });
    });
    req.end();
  });
}

/* Pull one response to disk at a byte offset. Writes are positional and
   synchronous, so nothing buffers in memory and no backpressure dance is
   needed: the socket cannot outrun the disk by a margin that matters here.
   The drain registers its OWN cancel hook: the rangedGet hook above it only
   settles the request promise, which is already resolved by the time bytes are
   flowing — cancelling without this left the drain hanging on a response
   nobody tears down, and the scratch folder survived the cancel. */
function drainTo(res, fd, pos, myJob, onBytes) {
  return new Promise((resolve, reject) => {
    let off = pos;
    let settled = false;
    const hook = () => bail(cancelError());
    const bail = (e) => {
      if (settled) return;
      settled = true;
      myJob.hooks.delete(hook);
      try { if (typeof res.destroy === 'function') res.destroy(); else if (typeof res.abort === 'function') res.abort(); } catch (_) {}
      reject(e);
    };
    myJob.hooks.add(hook);
    res.on('error', bail);
    res.on('abort', hook);
    res.on('data', (chunk) => {
      if (settled) return;
      if (myJob.cancelled) return bail(cancelError());
      try { fs.writeSync(fd, chunk, 0, chunk.length, off); } catch (e) { return bail(e); }
      off += chunk.length;
      if (onBytes) onBytes(chunk.length);
    });
    res.on('end', () => {
      if (settled) return;
      settled = true;
      myJob.hooks.delete(hook);
      resolve(off - pos);
    });
  });
}

async function fetchStream(stream, dest, myJob, onBytes) {
  /* A cancel can land between the slices, or between the two streams of a
     merged download. cancelJob has already run by then and will not come back,
     so starting a fresh request would hang on one nobody can abort. */
  if (myJob.cancelled) throw cancelError();
  const fd = fs.openSync(dest, 'w');
  const live = new Set();
  const ctl = { err: null };
  let complete = false;
  const killAll = () => {
    for (const r of live) { try { r.abort(); } catch (_) {} }
  };
  try {
    const probe = await rangedGet(stream.url, 0, SEG_FIRST - 1, myJob, live);
    let total = null;
    if (probe.status === 206) {
      const m = /\/(\d+)\s*$/.exec(String(probe.res.headers['content-range'] || ''));
      if (m) total = parseInt(m[1], 10);
    }
    if (probe.status === 200) {
      /* The server ignored the range and is sending the whole file on this one
         response. Take it as it comes — the old behaviour, still correct. */
      try {
        await drainTo(probe.res, fd, 0, myJob, onBytes);
        complete = true;
      } finally { probe.off(); killAll(); }
      return dest;
    }
    /* The parallel slices go up the MOMENT the probe's headers announce the
       file length — not after the probe has drained. Draining first was the
       cold-start tax: one connection at 79 KiB/s carried the whole first megabyte
       (13-70s on a big stream, during which the ETA printed was for a rate about
       to quadruple). With the workers already flying, that megabyte arrives on
       its own connection while four more carry the rest. allSettled never
       rejects, so if the probe drain fails below, the runners unwind harmlessly
       through killAll() in the catch. */
    const expect = total == null ? SEG_FIRST : Math.min(SEG_FIRST, total);
    const jobs = [];
    for (let s = expect; total != null && s < total; s += SEG_SIZE) jobs.push({ from: s, to: Math.min(total - 1, s + SEG_SIZE - 1) });
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        if (ctl.err || myJob.cancelled) return;
        const j = jobs[cursor++];
        const r = await rangedGet(stream.url, j.from, j.to, myJob, live);
        if (r.status !== 206) { r.off(); throw new Error('YouTube ignored the byte range for that stream.'); }
        try {
          const got = await drainTo(r.res, fd, j.from, myJob, onBytes);
          if (got < j.to - j.from + 1) throw new Error('The stream ended before the file was complete.');
        } finally { r.off(); }
      }
    };
    const runners = [];
    for (let i = 0; i < Math.min(SEG_THREADS, jobs.length); i++) runners.push(worker());
    const settledP = Promise.allSettled(runners);

    let written = 0;
    try {
      written = await drainTo(probe.res, fd, 0, myJob, onBytes);
    } finally { probe.off(); }
    /* With a known length a short probe means a hole nobody fills: refuse.
       With no length it just means the file is smaller than the probe slice —
       the stepping loop below walks to the real end. */
    if (total != null && written < expect) throw new Error('The stream ended before the file was complete.');

    if (total == null) {
      /* No length announced. Step forward in fixed slices until one comes back
         short, which is the end of the file. */
      for (let from = written; !ctl.err; from += SEG_FIRST) {
        const r = await rangedGet(stream.url, from, from + SEG_FIRST - 1, myJob, live);
        if (r.status !== 206) {
          /* A ranged request that comes back un-ranged would write the whole
             file at an offset and corrupt it. Refuse it; the engine fallback
             takes the job from here. */
          r.off();
          throw new Error('YouTube ignored the byte range for that stream.');
        }
        let got = 0;
        try {
          got = await drainTo(r.res, fd, from, myJob, onBytes);
        } finally { r.off(); }
        if (got < SEG_FIRST) { written = from + got; break; }
        written = from + got;
      }
      complete = true;
      return dest;
    }

    const settled = await settledP;
    const bad = settled.find((s) => s.status === 'rejected');
    if (bad) throw bad.reason;
    if (myJob.cancelled) throw cancelError();
    complete = true;
    return dest;
  } catch (e) {
    ctl.err = e;
    killAll();
    throw e;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    if (!complete) {
      /* Nothing half-written is left behind, whatever failed: a cancel, an
         expired URL, a short read. The scratch folder is emptied by runDirect. */
      try { fs.unlinkSync(dest); } catch (_) {}
    }
  }
}
/* Where the bundled tone lives. In a packaged app it sits OUTSIDE the asar,
   because afplay, paplay and SoundPlayer are separate programs and cannot read
   a path inside app.asar — which is why the WAV is an extraResource rather than
   a file under ui/. In a dev run it is beside src/. */
function chimeFile() {
  const cands = app.isPackaged
    ? [path.join(process.resourcesPath, 'chime.wav'),
       path.join(process.resourcesPath, 'assets', 'chime.wav')]
    : [path.join(__dirname, '..', 'assets', 'chime.wav')];
  for (const p of cands) {
    try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

function onPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [bin + '.exe', bin + '.com', bin + '.bat'] : [bin];
  for (const d of dirs) {
    for (const n of names) {
      try { if (fs.statSync(path.join(d, n)).isFile()) return true; } catch (_) {}
    }
  }
  return false;
}

function playDetached(file, args) {
  try {
    const p = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => { try { shell.beep(); } catch (_) {} });
    p.unref();
    return true;
  } catch (_) { return false; }
}

/* PowerShell's -EncodedCommand takes the script as base64 UTF-16LE. Passing the
   WAV that way instead of interpolating it into a quoted command line means a
   path holding a space, an apostrophe or a $ cannot break the command or inject
   into it. Single quotes are PowerShell's literal-string form. */
function psLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/* The finish chime. Deliberately played from the main process: a backgrounded
   window throttles its renderer, so a page-side sound arrives late or not at
   all — the one moment the user asked for it. macOS plays its own Glass, which
   is short, bright and impossible to mistake for an error tone; Windows and
   Linux play the bundled WAV through whichever audio player the machine
   actually has, and only when no player exists at all does it fall back to the
   OS beep. Fire-and-forget: the download is already saved, and nothing here may
   hold up the panel. */
function ding() {
  const wav = chimeFile();

  if (process.platform === 'darwin') {
    const glass = '/System/Library/Sounds/Glass.aiff';
    const f = fs.existsSync(glass) ? glass : wav;
    if (f && playDetached('/usr/bin/afplay', [f])) return;
  } else if (process.platform === 'win32') {
    if (wav) {
      const sys = process.env.SystemRoot || 'C:\\Windows';
      const ps = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (fs.existsSync(ps)) {
        const script = '$ErrorActionPreference="Stop";'
          + 'Add-Type -AssemblyName System;'
          + '$p = New-Object System.Media.SoundPlayer ' + psLiteral(wav) + ';'
          + '$p.PlaySync()';
        const b64 = Buffer.from(script, 'utf16le').toString('base64');
        if (playDetached(ps, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
          '-EncodedCommand', b64])) return;
      }
    }
  } else {
    /* One WAV, several plausible players: PulseAudio, PipeWire, plain ALSA, the
       freedesktop event-sound helper, and sox. Each is tried only if it is on
       PATH, so no player is spawned that cannot exist. */
    const players = [['paplay', [wav]], ['pw-play', [wav]], ['aplay', ['-q', wav]],
      ['canberra-gtk-play', ['-f', wav]], ['play', ['-q', wav]]];
    if (wav) {
      for (const [bin, args] of players) {
        if (onPath(bin) && playDetached(bin, args)) return;
      }
    }
  }
  try { shell.beep(); } catch (_) {}
}

function runFFmpeg(binPath, args, myJob) {
  return new Promise((resolve, reject) => {
    const p = spawn(binPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    if (myJob) myJob.proc = p;
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 4000) err += String(d); });
    /* A missing or unrunnable ffmpeg is the app's problem, not YouTube's, and
       Node's wording ("spawn ... ENOENT") must not reach the card. */
    p.on('error', (e) => {
      const msg = String((e && e.message) || '');
      reject(new Error(/ENOENT|EACCES|EPERM/i.test(msg)
        ? 'The tool that finishes the file is not installed. Try a video quality instead of MP3.'
        : 'The file could not be put together at the end.'));
    });
    p.on('close', (code) => {
      /* Cancelling during the mux must read as a cancellation, not a failure.
         An earlier version fell through to cleanEngineError, whose own last
         resort is "YouTube refused that link" — so pressing Cancel on an MP3
         blamed YouTube for stopping itself. */
      if (myJob && myJob.cancelled) { reject(new Error('cancelled')); return; }
      if (code === 0) return resolve();
      reject(new Error('The file could not be put together at the end. Try again, or pick a different quality.'));
    });
  });
}

/* Mirror yt-dlp's own naming closely enough that alreadySaved() recognizes
   both paths: it matches on "[id] suffix.ext", independent of the title. */
/* Windows treats these as devices, not filenames, and refuses them even with an
   extension appended. Case-insensitive, and COM0/LPT0 are not reserved. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function safeName(title, videoId, suffix) {
  let t = String(title || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  /* Windows also rejects a component that ends in a dot or a space — the case
     that bites when a title finishes with "..." or a trailing blank. */
  t = t.replace(/[. ]+$/, '');
  if (WIN_RESERVED.test(t)) t = '_' + t;
  return (t || 'video') + ' [' + (videoId || 'unknown') + ']' + suffix;
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate)) && n < 50) {
    candidate = stem + ' (' + n + ')' + ext;
    n++;
  }
  return candidate;
}

async function runDirect(entry, ctx) {
  const tmp = path.join(ctx.dir, '.vidgrab-' + process.pid + '-' + (ctx.videoId || 'job') + '-tmp');
  try { fs.mkdirSync(tmp, { recursive: true }); } catch (_) {}
  const total = entry.streams.reduce((s, x) => s + (x.bytes || 0), 0);
  let done = 0;
  const files = [];
  /* Declared out here, not inside the try: the catch has to see it to clean up
     a half-written file, and a const inside the block is not in scope there. */
  let finalPath = null;
  try {
    for (const st of entry.streams) {
      const dest = path.join(tmp, st.id + '.' + (st.ext || 'mp4'));
      await fetchStream(st, dest, ctx.myJob, (n) => {
        done += n;
        ctx.report('downloading', done, total);
      });
      files.push(dest);
    }
    if (ctx.myJob.cancelled) return { cancelled: true };

    const ext = entry.toMp3 ? 'mp3' : (entry.audio ? 'm4a' : 'mp4');
    finalPath = path.join(ctx.dir, uniqueName(ctx.dir, safeName(ctx.title, ctx.videoId, ctx.suffix) + '.' + ext));

    if (entry.toMp3) {
      ctx.report('converting', done, total);
      await runFFmpeg(ctx.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', files[0],
        '-codec:a', 'libmp3lame', '-qscale:a', '0', finalPath], ctx.myJob);
    } else if (files.length > 1) {
      ctx.report('merging', done, total);
      const ins = [];
      for (const f of files) ins.push('-i', f);
      /* -c copy: the streams are already H.264 and AAC, so this only remuxes.
         No re-encode, no quality loss, and it finishes in about a second. */
      await runFFmpeg(ctx.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error'].concat(ins,
        ['-map', '0:v:0', '-map', '1:a:0?', '-c', 'copy', '-movflags', '+faststart', finalPath]), ctx.myJob);
    } else {
      try { fs.renameSync(files[0], finalPath); } catch (_) { fs.copyFileSync(files[0], finalPath); }
    }
    ctx.report('done', total || done, total || done);
    return { ok: true, file: finalPath };
  } catch (e) {
    if (ctx.myJob.cancelled) {
      /* A cancel that landed during the mux or the encode leaves a half-written
         file under the real name. It must not survive as a playable-looking
         stub in the downloads folder. */
      try { if (finalPath && fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (_) {}
      return { cancelled: true };
    }
    if (/^cancelled$/i.test(String((e && e.message) || ''))) return { cancelled: true };
    return { error: e };
  } finally {
    rmTmp(tmp);
  }
}

async function startDownload(rawUrl, fmtId, _retry) {
  const url = String(rawUrl || '').trim();
  if (!url) return { ok: false, error: 'Paste a YouTube link first.' };
  if (!isYouTubeLink(url)) return { ok: false, error: 'That does not look like a YouTube link. Copy the address from YouTube and try again.' };
  if (job) cancelJob();

  const ffmpegPath = findFfmpeg();

  /* Use the plan the paste already produced if it is still held in memory.
     Resolved first, on purpose: when the direct fetch path can serve the job,
     the engine is never touched at all, so a cold cache costs nothing. */
  const want = fmtId || 'best';
  let plan = planCache.get(url);
  let entry = plan && plan.byId[want];
  if (!entry) {
    /* No cached plan for this quality: read the link, which is the only path
       that needs the engine. */
    const resolved = await resolveEntry(url, fmtId);
    if (resolved.error) return { ok: false, error: resolved.error };
    entry = resolved.entry;
    plan = resolved.plan;
  }
  if (!plan) return { ok: false, error: 'This video could not be read. Try again.' };

  const dir = downloadDir();
  /* Hidden scratch folders from a run that was killed or crashed have no other
     collector, so every job clears the old ones on its way past. */
  sweepStaleTmp(dir);
  const videoId = plan.videoId || (/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{6,})/.exec(url) || [])[1] || null;
  const suffix = suffixFor(entry);
  if (DEBUG) console.log('[vg] start', JSON.stringify({ url: url, want: want, sel: entry.sel, bytes: entry.bytes, audio: !!entry.audio, toMp3: !!entry.toMp3, streams: entry.streams ? entry.streams.length : 0, videoId: videoId, suffix: suffix }));

  /* Already on disk at this exact quality: say so at once instead of letting
     yt-dlp skip the download and leaving the bar frozen at 0%. */
  const existing = alreadySaved(dir, videoId, suffix);
  if (existing) {
    /* The press is answered, even though nothing was fetched: the chime marks
       "your file is ready" as much as a finished download. */
    ding();
    send('vg:done', { file: existing, dir: dir, already: true });
    return { ok: true, file: existing, dir: dir, already: true };
  }

  const startedAt = Date.now();
  const myJob = { proc: null, reqs: new Set(), hooks: new Set(), cancelled: false };
  job = myJob;

  /* Fast path: fetch the parked stream URLs ourselves. One engine spawn for
     the whole job instead of two, which is ~30 s of PyInstaller unpacking the
     user never has to wait for. */
  let fastEntry = entry;
  if (POISON_URLS && entry.streams && entry.streams.length) {
    /* Under test: replace the URLs with a dead address on a copy, so the plan
       in cache stays honest. Connection-refused is instant, which is exactly
       what an expired signature becomes: a fetch that cannot succeed. */
    fastEntry = Object.assign({}, entry, { streams: entry.streams.map((s) => Object.assign({}, s, { url: 'http://127.0.0.1:1/dead' })) });
    console.log('[vg] POISON_URLS: fast path will fail by design; recovery through the engine is under test');
  }
  if (!FORCE_ENGINE && canFetchDirect(fastEntry, ffmpegPath)) {
    const BUDGET = { starting: [0, 3], downloading: [3, 92], merging: [92, 98], converting: [92, 98], done: [98, 100] };
    let phase = 'starting';
    let phaseSince = startedAt;
    let winT = startedAt;     /* start of the window the rate is measured over */
    let winBytes = 0;         /* bytes seen inside that window */
    let prevDone = 0;
    let emaBps = 0;
    let goodBps = 0;          /* last rate measured over bytes that really moved */
    let lastByteAt = startedAt;
    let measured = false;
    let shownPct = 0;
    let lastReport = 0;

    const report = (next, done, total, force) => {
      const now = Date.now();
      if (next && next !== phase) { phase = next; phaseSince = now; }
      /* Chunks arrive far faster than the eye reads; 10 fps of updates is
         plenty and keeps the renderer cheap. */
      if (!force && now - lastReport < 100) return;
      lastReport = now;

      /* Rate measurement. An empty window is slid forward and discarded rather
         than averaged with zero: letting a pause into the average is what made
         the speed read 6 KiB/s and the ETA jump to 1:29 the moment YouTube
         went quiet, then snap back on resume. Only bytes that arrived count. */
      const moved = Math.max(0, done - prevDone);
      prevDone = done;
      if (moved > 0) { winBytes += moved; lastByteAt = now; }
      const winSecs = (now - winT) / 1000;
      if (winBytes > 0 && (winSecs >= 0.5 || !measured)) {
        const since = measured ? winSecs : Math.max(0.05, (now - startedAt) / 1000);
        const instant = winBytes / since;
        emaBps = measured ? emaBps * 0.6 + instant * 0.4 : instant;
        measured = true;
        goodBps = emaBps;
        winT = now;
        winBytes = 0;
      } else if (winBytes === 0 && winSecs >= 0.5) {
        winT = now;
      }
      const span = BUDGET[phase] || BUDGET.downloading;
      let pct = total ? span[0] + Math.min(1, done / total) * (span[1] - span[0]) : span[0];
      if (phase === 'merging' || phase === 'converting' || phase === 'starting') {
        const secs = (now - phaseSince) / 1000;
        pct = span[0] + (span[1] - span[0]) * (1 - Math.exp(-secs / 8));
      }
      if (pct <= shownPct) pct = Math.min(100, shownPct + 0.2);
      shownPct = pct;
      const left = total ? Math.max(0, total - done) : 0;
      /* A pause is YouTube withholding bytes, not the app stopping. It is only
         called a stall once bytes had started and then went quiet for two
         seconds; before the first byte it is still "opening the stream". */
      const stalled = phase === 'downloading' && measured && done > 0
        && (now - lastByteAt) > 2000 && done < (total || 1);
      /* The printed rate is the last one measured over bytes that really moved.
         It holds through a pause instead of falling toward zero, so the ETA
         stays believable and never snaps back when YouTube resumes. */
      const shownBps = goodBps;
      const speedTxt = shownBps > 1024 ? humanSize(shownBps) + '/s' : '';
      let eta = '';
      if (phase === 'downloading' && left > 0 && shownBps > 1024) {
        const secs = Math.round(left / shownBps);
        eta = secs < 60 ? secs + 's' : humanDuration(secs);
      }
      /* Name the wait while it is happening, so a slow first second never
         reads as a freeze. */
      const waited = Math.round((now - phaseSince) / 1000);
      let note = '';
      if (phase === 'merging') note = 'assembling ' + waited + 's';
      else if (phase === 'converting') note = 'encoding ' + waited + 's';
      else if (phase === 'starting' && waited >= 4) note = 'YouTube slow to answer ' + waited + 's';
      else if (phase === 'downloading' && done === 0 && waited >= 4) note = 'opening stream ' + waited + 's';
      else if (stalled) note = 'YouTube quiet ' + Math.round((now - lastByteAt) / 1000) + 's';
      send('vg:progress', {
        pct: pct,
        size: total ? humanSize(total) : humanSize(done),
        done: done, left: left,
        speed: speedTxt,
        eta: eta,
        stalled: stalled,
        note: note,
        phase: phase,
      });
    };

    report('starting', 0, fastEntry.bytes || 0);
    const r = await runDirect(fastEntry, {
      dir: dir, videoId: videoId, suffix: suffix,
      title: plan.title || 'video',
      ffmpegPath: ffmpegPath, myJob: myJob, report: report,
    });
    if (r.cancelled || myJob.cancelled) {
      if (job === myJob) job = null;
      return { ok: false, cancelled: true };
    }
    if (r.ok) {
      if (job === myJob) job = null;
      ding();
      send('vg:done', { file: r.file, dir: dir });
      return { ok: true, file: r.file, dir: dir };
    }
    /* Expired or refused stream: fall through to the engine, which re-extracts
       and knows how to handle HLS and DASH. */
    lastError = r.error;
  }

  let engine;
  try {
    engine = await ensureEngine();
  } catch (e) {
    return { ok: false, error: userError(e, 'Could not prepare the download engine. Check your internet connection and try again.') };
  }

  const args = argsFor(entry);
  args.push('-o', path.join(dir, '%(title).80s [%(id)s]' + suffix + '.%(ext)s'));
  /* Reusing the parked extraction saves a whole second engine start — but only
     where an engine start is expensive. On the Python engine it costs 0.3 s,
     so a live lookup is cheaper than risking a stale stream signature. */
  const infoFile = plan.infoJson;
  const reusable = engine.kind === 'bin' && infoFile && fs.existsSync(infoFile) && (Date.now() - (plan.at || 0)) < 3 * 3600 * 1000;
  if (reusable) args.push('--load-info-json', infoFile);
  else args.push(url);

  const candidates = [];
  let phase = 'starting';
  let cancelled = false;
  let expected = entry.bytes || 0;

  /* Progress comes from the file, not the pipe: the bundled Python engine
     holds the [download] lines behind an 8 KB buffer, so a parsed-only bar
     freezes for minutes.

     The bar is split into budgets so it can never sit parked at 99%:
       starting    0 -> 4    resolving the streams
       downloading 4 -> 88   bytes on disk against the expected total
       merging     88 -> 97  ffmpeg remuxing the two streams
       converting  88 -> 97  audio extraction
     Merging and converting creep on elapsed time, so a long mux still shows
     movement instead of looking like a hang. */
  const BUDGET = { starting: [0, 4], downloading: [4, 88], merging: [88, 97], converting: [88, 97] };
  let prevSum = 0;
  let winT = startedAt;      /* start of the window the rate is measured over */
  let winBytes = 0;          /* bytes seen inside that window */
  let emaBps = 0;
  let goodBps = 0;           /* last rate measured over bytes that really moved */
  let measured = false;
  let stalled = false;
  let lastGrowthAt = startedAt;
  let phaseSince = startedAt;
  let shownPct = 0;

  const creep = (span, cap) => {
    /* Time-based creep: asymptotic, never reaches the cap. */
    const secs = (Date.now() - phaseSince) / 1000;
    return span[0] + (span[1] - span[0]) * (1 - Math.exp(-secs / cap));
  };

  const tick = () => {
    const now = Date.now();
    const sum = jobBytes(dir, videoId, candidates, startedAt);

    /* Same discipline as the direct path: a window that carried no bytes is
       discarded instead of averaged with zero. Letting a pause into the average
       is what made the speed fall toward nothing and the ETA explode, which is
       precisely the moment the user is watching. */
    const moved = sum > prevSum ? sum - prevSum : 0;
    if (moved > 0) { winBytes += moved; lastGrowthAt = now; stalled = false; }
    if (sum !== prevSum) prevSum = sum;
    const winSecs = (now - winT) / 1000;
    if (winBytes > 0 && (winSecs >= 0.5 || !measured)) {
      const since = measured ? winSecs : Math.max(0.05, (now - startedAt) / 1000);
      const instant = winBytes / since;
      emaBps = measured ? emaBps * 0.6 + instant * 0.4 : instant;
      measured = true;
      goodBps = emaBps;
      winT = now;
      winBytes = 0;
    } else if (winBytes === 0 && winSecs >= 0.5) {
      winT = now;
    }
    /* Quiet for two seconds after bytes started: a pause, not a hang. */
    if (phase === 'downloading' && measured && sum > 0 && (now - lastGrowthAt) > 2000) stalled = true;

    let pct;
    if (phase === 'merging' || phase === 'converting') {
      pct = creep(BUDGET[phase], 45);
    } else if (phase === 'starting') {
      pct = creep(BUDGET.starting, 12);
    } else if (expected) {
      const frac = Math.min(1, sum / expected);
      pct = BUDGET.downloading[0] + frac * (BUDGET.downloading[1] - BUDGET.downloading[0]);
    } else {
      pct = creep(BUDGET.downloading, 240);
    }
    /* The bar only ever moves forward. */
    if (pct <= shownPct) pct = Math.min(97, shownPct + 0.15);
    shownPct = pct;

    const left = expected ? Math.max(0, expected - sum) : 0;
    /* Same rule as the direct path: the decay only flags the stall, the printed
       rate stays the last one that really moved bytes. */
    const shownBps = goodBps;
    let eta = '';
    if (shownBps > 1024 && left > 0 && phase === 'downloading') {
      const secs = Math.round(left / shownBps);
      eta = secs < 60 ? secs + 's' : humanDuration(secs);
    }
    /* Say what the wait actually is, so a slow lookup never reads as a freeze. */
    let note = '';
    const waited = Math.round((now - phaseSince) / 1000);
    if (phase === 'starting' && waited >= 8) note = 'YouTube slow to answer ' + waited + 's';
    else if (phase === 'merging') note = 'assembling ' + waited + 's';
    else if (phase === 'converting') note = 'encoding ' + waited + 's';
    else if (stalled) note = 'YouTube quiet ' + Math.round((now - lastGrowthAt) / 1000) + 's';
    send('vg:progress', {
      pct: pct,
      size: expected ? humanSize(expected) : humanSize(sum),
      done: sum,
      left: left,
      speed: shownBps > 1024 ? humanSize(shownBps) + '/s' : '',
      eta: eta,
      stalled: stalled,
      note: note,
      phase: phase,
    });
  };
  const timer = setInterval(tick, 700);
  if (timer.unref) timer.unref();

  const enter = (next) => {
    if (phase === next) return;
    phase = next;
    phaseSince = Date.now();
  };

  const onLine = (line) => {
    const d = DEST_RE.exec(line);
    if (d) {
      const pth = d[1].trim();
      if (candidates.indexOf(pth) === -1) candidates.push(pth);
      /* The first real stream also tells us its true size, which beats the
         estimate from the manifest. */
      const sz = /of\s+(~?[\d.,]+)\s*([KMGTP])?i?B/i.exec(line);
      if (sz && !expected) {
        const mult = { K: 1024, M: 1048576, G: 1073741824, T: 1099511627776 }[(sz[2] || 'M').toUpperCase()];
        const guess = parseFloat(sz[1]) * mult;
        if (guess > 0) expected = guess * Math.max(1, entry.sel.split('+').length - 1) * 1.02;
      }
      enter('downloading');
    }
    if (/Merging formats/i.test(line)) {
      enter('merging');
      const m = MERGE_RE.exec(line);
      if (m && candidates.indexOf(m[1].trim()) === -1) candidates.push(m[1].trim());
    }
    if (/\[ExtractAudio\]|\[ExtractingAudio\]|\[Fixup/i.test(line)) enter('converting');
  };

  const s = engineSpawn(engine, args, ffmpegPath);
  tick();
  const p = spawn(s.file, s.args, { env: s.env, windowsHide: true });
  myJob.proc = p;
  job = myJob;

  let out = '';
  let err = '';
  const eat = (stream, sink) => {
    let carry = '';
    stream.on('data', (d) => {
      carry += String(d);
      const parts = carry.split(/[\r\n]+/);
      carry = parts.pop();
      for (const line of parts) {
        onLine(line);
        if (sink === 'out') out += line + '\n'; else err += line + '\n';
      }
    });
  };
  eat(p.stdout, 'out');
  eat(p.stderr, 'err');

  const closed = await new Promise((resolve) => {
    p.on('error', (e) => resolve({ error: e }));
    p.on('close', (code, signal) => resolve({ code: code, signal: signal }));
  });

  clearInterval(timer);
  if (job === myJob) job = null;
  if (closed.signal || (closed.code === -1 && !closed.error)) {
    cancelled = true;
  }
  if (closed.error) {
    const msg = String(closed.error.message || '');
    if (/EACCES|EPERM|ENOENT/i.test(msg)) {
      invalidateEngine(engine);
      return { ok: false, error: 'The download engine was damaged and has been cleared. Try again and it will repair itself.' };
    }
    /* Node's own wording — an errno, a path — never becomes a sentence here. */
    return { ok: false, error: userError(closed.error, 'The download could not start. Try again.') };
  }
  if (cancelled) {
    /* An engine job that was stopped mid-write leaves an incomplete file under
       its real name: --no-part means there is no .part to tell it apart. Any
       leftover this job created has to go, or the next press of the same
       quality sees a truncated file and calls it done. */
    sweepJob(dir, videoId, candidates, startedAt);
    return { ok: false, cancelled: true };
  }
  if (closed.code !== 0) {
    /* A nonzero exit that mentions a damaged engine should not be retried
       against the same cache. */
    if (/EACCES|Permission denied/i.test(err)) {
      invalidateEngine(engine);
    }
    /* The parked extraction can go stale — rotated stream signatures, formats
       withdrawn since the paste. Drop it and re-read the video live once. */
    if (reusable && !_retry && /sign|expire|not valid|403|Withdrawn|missing|stale|Deprecated/i.test(err)) {
      try { fs.unlinkSync(infoFile); } catch (_) {}
      planCache.delete(url);
      return startDownload(url, fmtId, true);
    }
    return { ok: false, error: cleanEngineError(err || out) };
  }

  const file = resolveOutput(dir, candidates, videoId, startedAt);
  ding();
  send('vg:done', { file: file, dir: dir });
  return { ok: true, file: file, dir: dir };
}

function cancelJob() {
  if (!job) return false;
  const j = job;
  job = null;
  j.cancelled = true;
  /* The fast path is a set of in-flight HTTP requests — several slices of the
     same file at once — and the slow path a child process. Cancel whichever is
     live. Every request is torn down, not just the last one, and then every
     hook is knocked on directly, because Electron's net stack promises no
     reliable event for a self-inflicted abort and a promise left hanging here
     is a scratch folder left in the downloads folder forever. */
  for (const r of j.reqs) { try { r.abort(); } catch (_) {} }
  for (const h of j.hooks) { try { h(); } catch (_) {} }
  j.reqs.clear();
  j.hooks.clear();
  if (j.proc) {
    const p = j.proc;
    try { p.kill('SIGTERM'); } catch (_) {}
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 1500);
    if (t.unref) t.unref();
  }
  return true;
}

/* ---------- the window ---------- */

/* Only the app's own interface may load. Everything else is either opened in
   the browser (http/https) or refused outright. This is what makes a blank
   window impossible: the old app let href="/" walk to the filesystem root. */
function isAppPage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    const got = path.resolve(decodeURIComponent(u.pathname));
    return got === UI_INDEX || got === path.resolve(__dirname, '..', 'ui', 'index.htm') || got === UI_INDEX.replace(/\\/g, '/');
  } catch (_) {
    return false;
  }
}

function openOutside(url) {
  let u;
  try { u = new URL(url); } catch (_) { return; }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    shell.openExternal(url).catch(() => {});
  }
}

function guardContents(w) {
  const veto = (event, url) => {
    if (isAppPage(url)) return;
    event.preventDefault();
    openOutside(url);
  };
  w.webContents.on('will-navigate', veto);
  w.webContents.on('will-redirect', veto);
  try { w.webContents.on('will-frame-navigate', veto); } catch (_) {}
  w.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  w.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || url === '') return;
    lastError = 'The interface failed to load (' + code + ' ' + desc + ').';
    send('vg:fatal', { message: lastError });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Download',
      submenu: [
        { label: 'Paste Link and Start', accelerator: 'CmdOrCtrl+Shift+V', click: () => send('vg:shortcut', 'paste-start') },
        { label: 'Focus the Link Field', accelerator: 'CmdOrCtrl+L', click: () => send('vg:shortcut', 'focus') },
        { type: 'separator' },
        { label: 'Cancel Current Download', accelerator: 'CmdOrCtrl+.', click: () => { cancelJob(); send('vg:cancelled', {}); } },
        { type: 'separator' },
        { label: 'Show Downloads Folder', accelerator: 'CmdOrCtrl+Shift+D', click: () => shell.openPath(downloadDir()).catch(() => {}) },
      ],
    },
    { role: isMac ? 'windowMenu' : 'viewMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 460,
    minHeight: 540,
    title: 'VidGrab',
    icon: appIcon() || undefined,
    backgroundColor: dark ? '#0b1020' : '#eef2f8',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  guardContents(win);
  win.loadFile(UI_INDEX);
  win.on('resize', () => {});
}

/* ---------- boot ---------- */

/* A child-process or IPC failure should never take the window down with an
   error modal. Log it, keep running, and tell the page if it is user-facing. */
process.on('uncaughtException', (e) => {
  console.error('[vidgrab] uncaught:', e && (e.stack || e.message) || e);
  if (win && !win.isDestroyed()) {
    send('vg:error', { message: 'Something went wrong inside the app. Try again.' });
  }
});
process.on('unhandledRejection', (e) => {
  console.error('[vidgrab] unhandled rejection:', e && (e.stack || e.message) || e);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  /* Show as VidGrab in the menu bar and the About panel. The storage folder is
     pinned back to the package name on purpose: renaming it would orphan the
     download-engine cache and every parked extraction from earlier runs. */
  app.setName('VidGrab');
  try { app.setPath('userData', path.join(app.getPath('appData'), 'vidgrab-desktop')); } catch (_) {}

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('net.vidgrab.desktop');
    /* The Dock and the taskbar want the app's own icon, not Electron's. On
       macOS the .icns only lands in a packaged build, so set it here too. */
    const icon = appIcon();
    if (icon) {
      if (process.platform === 'darwin' && app.dock) {
        try { app.dock.setIcon(icon); } catch (_) {}
      }
    }
    buildMenu();

    ipcMain.handle('vg:info', (_e, url) => videoInfo(url));
    ipcMain.handle('vg:start', (_e, url, fmtId) => startDownload(url, fmtId));
    ipcMain.handle('vg:cancel', () => {
      const killed = cancelJob();
      if (killed) send('vg:cancelled', {});
      return killed;
    });
    ipcMain.handle('vg:paste', () => {
      try { return clipboard.readText() || ''; } catch (_) { return ''; }
    });
    ipcMain.handle('vg:reveal', (_e, file) => {
      if (file && fs.existsSync(file)) return shell.showItemInFolder(file) || true;
      shell.openPath(downloadDir()).catch(() => {});
      return true;
    });
    ipcMain.handle('vg:getDir', () => downloadDir());
    ipcMain.handle('vg:chooseDir', async () => {
      const r = await dialog.showOpenDialog(win, {
        title: 'Where should videos go?',
        defaultPath: downloadDir(),
        buttonLabel: 'Save here',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths.length) return downloadDir();
      writeSettings({ downloadDir: r.filePaths[0] });
      return r.filePaths[0];
    });
    ipcMain.handle('vg:version', () => ({
      version: app.getVersion(),
      platform: process.platform,
      ffmpeg: !!findFfmpeg(),
    }));

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    cancelJob();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { cancelJob(); });
}
