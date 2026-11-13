'use strict';

const VERSION = '1.0.2';
const LS_KEY = 'pokepoke.v1';
const LOGOS = ['assets/logo-a.jpg', 'assets/logo-b.jpg'];
const MAX_CLIPS = 10;
const MAX_REC_SEC = 10;
const LONG_PRESS_MS = 3000;
// Built-in win sounds per prize, picked by a keyword in the prize name.
const PRIZE_SOUNDS = [
  { key: '米果', files: ['assets/sounds/rice-1.mp3', 'assets/sounds/rice-2.mp3', 'assets/sounds/rice-3.mp3'] },
  { key: '魷魚絲', files: ['assets/sounds/squid-1.mp3', 'assets/sounds/squid-2.mp3', 'assets/sounds/squid-3.mp3'] },
  { key: '抱抱', files: ['assets/sounds/hug-1.mp3', 'assets/sounds/hug-2.mp3', 'assets/sounds/hug-3.mp3'] },
];

const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const clampInt = (v, lo, hi, d) => { v = parseInt(v, 10); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/* =========================================================================
   State (config + current board) — localStorage
   ========================================================================= */
function defaultConfig() {
  return {
    rows: 5, cols: 6,
    prizes: [
      { id: uid(), name: '米果獎', count: 14 },
      { id: uid(), name: '魷魚絲獎', count: 6 },
      { id: uid(), name: '抱抱獎', count: 10 },
    ],
    blank: '銘謝惠顧',
    title: '戳戳樂',
    subtitle: '1344聲工場 × CXC',
    sound: true,
    prizeSounds: true,
    volume: 0.8,
    pin: '1344',
  };
}

let config, board;

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (raw && raw.config) {
      config = Object.assign(defaultConfig(), raw.config);
      board = raw.board && Array.isArray(raw.board.cells) ? raw.board : null;
    }
  } catch (e) { /* fall through to defaults */ }
  if (!config) config = defaultConfig();
  // v1.0.0 shipped placeholder prizes (頭獎/二獎/三獎 on 10×10). If an iPad still has
  // those untouched and nothing poked yet, switch it to the real event prizes.
  const sig = config.rows + 'x' + config.cols + ':' + config.prizes.map(p => p.name + p.count).join(',');
  if (sig === '10x10:頭獎1,二獎3,三獎10' && (!board || !board.opened.some(Boolean))) {
    const d = defaultConfig();
    Object.assign(config, { rows: d.rows, cols: d.cols, prizes: d.prizes });
    board = null;
  }
  if (!board) board = makeBoard();
  saveState();
}

function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ config, board })); }
  catch (e) { toast('儲存失敗：iPad 儲存空間不足？'); }
}

function prizeTotal(cfg = config) { return cfg.prizes.reduce((s, p) => s + (p.count | 0), 0); }

function randInt(n) { // unbiased, crypto-backed
  const a = new Uint32Array(1), lim = Math.floor(0x100000000 / n) * n;
  do crypto.getRandomValues(a); while (a[0] >= lim);
  return a[0] % n;
}

function makeBoard() {
  const total = config.rows * config.cols;
  const cells = new Array(total).fill(-1);
  let k = 0;
  const prizes = config.prizes.filter(p => p.count > 0).map(p => ({ id: p.id, name: p.name.trim() || '獎品', count: p.count | 0 }));
  prizes.forEach((p, pi) => { for (let j = 0; j < p.count && k < total; j++) cells[k++] = pi; });
  for (let i = total - 1; i > 0; i--) { const j = randInt(i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  return {
    id: uid(), createdAt: Date.now(),
    rows: config.rows, cols: config.cols,
    prizes, blank: config.blank.trim() || '銘謝惠顧',
    cells, opened: new Array(total).fill(0),
  };
}

function remainingOf(pi) {
  let won = 0;
  board.cells.forEach((c, i) => { if (c === pi && board.opened[i]) won++; });
  return board.prizes[pi].count - won;
}
const openedCount = () => board.opened.reduce((s, v) => s + v, 0);

/* =========================================================================
   IndexedDB — recordings + prize images
   ========================================================================= */
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('pokepoke', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('clips'); r.result.createObjectStore('images'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    put: (s, k, v) => run(s, 'readwrite', st => st.put(v, k)),
    del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
    entries: (s) => run(s, 'readonly', st => {
      const acc = [];
      st.openCursor().onsuccess = e => { const c = e.target.result; if (c) { acc.push([c.key, c.value]); c.continue(); } };
      return acc;
    }),
  };
})();

const prizeImg = new Map(); // prizeId -> dataURL

/* =========================================================================
   Audio — built-in synth sounds + recorded clips
   ========================================================================= */
const audio = {
  ctx: null, master: null, noise: null,
  clips: new Map(), // slot -> { buf: AudioBuffer, start, dur }
  lastClip: -1,
  prizeSets: new Map(), // PRIZE_SOUNDS key -> [{ buf, start, dur }]
  lastPrize: new Map(), // PRIZE_SOUNDS key -> last index played

  make() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    const n = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.3, this.ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
    return this.ctx;
  },
  unlock() { // call inside a user gesture
    this.make();
    try { if (navigator.audioSession && !recorder.active) navigator.audioSession.type = 'playback'; } catch (e) {}
    if (this.ctx.state !== 'running') this.ctx.resume();
    this.master.gain.value = config.volume;
  },
  get on() { return config.sound && this.ctx; },
  decode(buf) {
    this.make();
    return new Promise((res, rej) => this.ctx.decodeAudioData(buf.slice(0), res, rej));
  },
  tone(f, t, dur, type = 'triangle', vol = 0.25, fEnd) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (fEnd) o.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  },
  poke() {
    if (!this.on) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.7;
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    s.connect(bp); bp.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + 0.15);
    this.tone(150, t, 0.14, 'sine', 0.6, 55);
  },
  lose() {
    if (!this.on) return;
    const t = this.ctx.currentTime + 0.05;
    this.tone(392, t, 0.22, 'triangle', 0.18);
    this.tone(311, t + 0.16, 0.38, 'triangle', 0.16);
  },
  sparkle(at = 0) {
    const t = this.ctx.currentTime + at;
    [2093, 2637, 3136, 2349, 3520, 4186].forEach((f, i) => this.tone(f, t + i * 0.045, 0.25, 'sine', 0.07));
  },
  fanfare() {
    const t = this.ctx.currentTime + 0.05;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, t + i * 0.09, 0.26, 'triangle', 0.24));
    [1046.5, 1318.5, 1568].forEach(f => this.tone(f, t + 0.4, 1.0, 'triangle', 0.13));
    [523.25, 659.25].forEach(f => this.tone(f, t + 0.4, 1.0, 'sine', 0.12));
    this.sparkle(0.45);
  },
  playBuf(c, at = 0) {
    const s = this.ctx.createBufferSource();
    s.buffer = c.buf; s.connect(this.master);
    s.start(this.ctx.currentTime + at, c.start);
    return c.dur;
  },
  prizeSet(name) { // the built-in sound set for a prize name, if any are loaded
    const def = PRIZE_SOUNDS.find(d => (name || '').includes(d.key));
    const set = def && this.prizeSets.get(def.key);
    return set && set.length ? [def.key, set] : null;
  },
  playClip(slot, at = 0) {
    const c = this.clips.get(slot);
    if (!c) return 0;
    const s = this.ctx.createBufferSource();
    s.buffer = c.buf; s.connect(this.master);
    s.start(this.ctx.currentTime + at, c.start);
    return c.dur;
  },
  win(prizeName) {
    if (!this.on) return;
    const ps = config.prizeSounds && this.prizeSet(prizeName);
    if (ps) {
      const [key, set] = ps;
      let k = randInt(set.length);
      if (set.length > 1) while (k === this.lastPrize.get(key)) k = randInt(set.length);
      this.lastPrize.set(key, k);
      this.sparkle();
      this.playBuf(set[k], 0.2);
      return;
    }
    const slots = [...this.clips.keys()];
    if (!slots.length) return this.fanfare();
    let pick = slots[randInt(slots.length)];
    if (slots.length > 1) while (pick === this.lastClip) pick = slots[randInt(slots.length)];
    this.lastClip = pick;
    this.sparkle();
    this.playClip(pick, 0.2);
  },
};

function leadingSilence(buf) { // seconds of near-silence at the start (trimmed on playback)
  const d = buf.getChannelData(0), thr = 0.02;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > thr) return Math.max(0, i / buf.sampleRate - 0.04);
  return 0;
}

async function loadClips() {
  try {
    for (const [slot, rec] of await db.entries('clips')) {
      try {
        const buf = await audio.decode(rec.data);
        audio.clips.set(slot, { buf, start: rec.start || 0, dur: buf.duration - (rec.start || 0) });
      } catch (e) { console.warn('clip decode failed', slot, e); }
    }
  } catch (e) { console.warn('idb clips', e); }
}

async function loadPrizeSounds() {
  await Promise.all(PRIZE_SOUNDS.map(async d => {
    const set = [];
    for (const f of d.files) {
      try {
        const r = await fetch(f);
        if (!r.ok) throw new Error(r.status);
        const buf = await audio.decode(await r.arrayBuffer());
        const start = leadingSilence(buf);
        set.push({ buf, start, dur: buf.duration - start });
      } catch (e) { console.warn('prize sound failed', f, e); }
    }
    audio.prizeSets.set(d.key, set);
  }));
}

async function loadImages() {
  try { for (const [id, url] of await db.entries('images')) prizeImg.set(id, url); }
  catch (e) { console.warn('idb images', e); }
}

/* =========================================================================
   Game screen
   ========================================================================= */
const boardEl = $('#board'), frameEl = $('#boardFrame');
let busy = false;

function renderHeader() {
  $('#titleText').textContent = config.title || '戳戳樂';
  $('#subtitleText').textContent = config.subtitle || '';
  document.title = config.title || '戳戳樂';
  const n = openedCount(), total = board.cells.length;
  $('#progressText').innerHTML = `已戳 <b>${n}</b> / ${total}`;
}

function cellLabel(i) {
  const c = board.cells[i];
  return c >= 0 ? board.prizes[c].name : board.blank;
}

function fillResult(cell, i) {
  const win = board.cells[i] >= 0;
  cell.classList.add('open', win ? 'win' : 'lose');
  const r = cell.querySelector('.result');
  r.textContent = cellLabel(i);
  sizeResult(r, win);
}

function sizeResult(r, win) {
  const size = parseFloat(boardEl.style.getPropertyValue('--cell')) || 60;
  const len = [...r.textContent].length;
  const perLine = len > 4 ? Math.ceil(len / 2) : Math.max(len, 2);
  let fs = Math.min(size * (win ? 0.32 : 0.22), (size * 0.84) / perLine);
  if (!win && size < 46) fs = 0;
  r.style.fontSize = fs + 'px';
}

function renderBoard() {
  boardEl.textContent = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < board.cells.length; i++) {
    const r = Math.floor(i / board.cols), c = i % board.cols;
    const cell = el('div', 'cell');
    cell.dataset.i = i;
    const res = el('div', 'result');
    cell.appendChild(res);
    if (board.opened[i]) {
      fillResult(cell, i);
    } else {
      const cover = el('div', 'cover');
      cover.style.backgroundImage = `url("${LOGOS[(r + c) % 2]}")`;
      cell.appendChild(cover);
    }
    frag.appendChild(cell);
  }
  boardEl.appendChild(frag);
  fitBoard();
  renderPanel();
  renderHeader();
}

function fitBoard() {
  const pad = frameEl.clientWidth < 600 ? 10 : 16;
  const w = frameEl.clientWidth - pad * 2;
  const h = frameEl.clientHeight - pad * 2;
  const g = 0.09, { rows, cols } = board;
  const size = Math.max(12, Math.floor(Math.min(w / (cols + (cols - 1) * g), h / (rows + (rows - 1) * g))));
  const gap = Math.max(2, Math.round(size * g));
  boardEl.style.setProperty('--pad', pad + 'px');
  boardEl.style.setProperty('--cell', size);
  boardEl.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
  boardEl.style.gridAutoRows = `${size}px`;
  boardEl.style.gap = `${gap}px`;
  boardEl.querySelectorAll('.cell.open .result').forEach(r => sizeResult(r, r.parentNode.classList.contains('win')));
}

function renderPanel() {
  const list = $('#prizeList');
  list.textContent = '';
  let left = 0;
  board.prizes.forEach((p, pi) => {
    const rem = remainingOf(pi);
    left += rem;
    const li = el('li');
    li.dataset.pi = pi;
    if (rem <= 0) li.classList.add('gone');
    const url = prizeImg.get(p.id);
    if (url) { const im = el('img', 'thumb'); im.src = url; im.alt = ''; li.appendChild(im); }
    else li.appendChild(el('span', 'thumb', [...p.name][0] || '獎'));
    li.appendChild(el('span', 'name', p.name));
    const cnt = el('span', 'count');
    cnt.innerHTML = `<b>${rem}</b> / ${p.count}`;
    li.appendChild(cnt);
    list.appendChild(li);
  });
  $('#allGone').hidden = !(board.prizes.length && left === 0);
}

/* --- poking --- */
let pressed = null;
boardEl.addEventListener('pointerdown', e => {
  audio.unlock();
  const cell = e.target.closest('.cell');
  if (!cell || busy || cell.classList.contains('open')) return;
  pressed = cell;
  cell.classList.add('press');
});
window.addEventListener('pointerup', e => {
  const cell = pressed;
  pressed = null;
  if (!cell) return;
  cell.classList.remove('press');
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (target && target.closest('.cell') === cell) poke(+cell.dataset.i, cell);
});
window.addEventListener('pointercancel', () => { if (pressed) pressed.classList.remove('press'); pressed = null; });

function poke(i, cell) {
  if (busy || board.opened[i]) return;
  busy = true;
  board.opened[i] = 1;
  saveState(); // commit before any animation — a reload can never re-poke

  const cover = cell.querySelector('.cover');
  const bg = cover ? cover.style.backgroundImage : '';
  if (cover) cover.remove();
  burst(cell, bg);
  audio.poke();
  fillResult(cell, i);
  cell.classList.add('fresh');
  renderHeader();

  const pi = board.cells[i];
  if (pi >= 0) {
    setTimeout(() => {
      renderPanel();
      const li = $(`#prizeList li[data-pi="${pi}"]`);
      if (li) li.classList.add('bump');
      showWin(pi, i);
      audio.win(board.prizes[pi].name);
    }, 420);
  } else {
    setTimeout(() => audio.lose(), 150);
    toast(`${board.blank}，再接再厲！`, 1400);
    setTimeout(() => { busy = false; cell.classList.remove('fresh'); }, 550);
  }
}

function burst(cell, bg) {
  const size = cell.offsetWidth;
  const j = () => 40 + Math.random() * 20; // jagged split point, percent
  const T = `${j()}% 0`, R = `100% ${j()}%`, B = `${j()}% 100%`, L = `0 ${j()}%`, C = `${j()}% ${j()}%`;
  const shapes = [
    [`0 0, ${T}, ${C}, ${L}`, -1, -1],
    [`${T}, 100% 0, ${R}, ${C}`, 1, -1],
    [`${C}, ${R}, 100% 100%, ${B}`, 1, 1],
    [`${L}, ${C}, ${B}, 0 100%`, -1, 1],
  ];
  for (const [poly, sx, sy] of shapes) {
    const s = el('div', 'shard');
    s.style.backgroundImage = bg;
    s.style.clipPath = s.style.webkitClipPath = `polygon(${poly})`;
    s.style.setProperty('--dx', `${sx * size * (0.45 + Math.random() * 0.35)}px`);
    s.style.setProperty('--dy', `${sy * size * (0.45 + Math.random() * 0.35)}px`);
    s.style.setProperty('--rot', `${sx * (15 + Math.random() * 35)}deg`);
    cell.appendChild(s);
    setTimeout(() => s.remove(), 650);
  }
  const ring = el('div', 'ring');
  cell.appendChild(ring);
  setTimeout(() => ring.remove(), 550);
}

/* --- win overlay --- */
const winOverlay = $('#winOverlay'), winClose = $('#winClose');
function showWin(pi, i) {
  const p = board.prizes[pi];
  $('#winName').textContent = p.name;
  const url = prizeImg.get(p.id), img = $('#winImg');
  if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
  $('#winCell').textContent = `第 ${i + 1} 格`;
  winOverlay.hidden = false;
  winClose.disabled = true;
  setTimeout(() => { winClose.disabled = false; }, 900);
  confetti();
}
winClose.addEventListener('click', () => {
  winOverlay.hidden = true;
  stopConfetti();
  boardEl.querySelectorAll('.cell.fresh').forEach(c => c.classList.remove('fresh'));
  busy = false;
});

let confettiRaf = 0;
function confetti() {
  const cv = $('#confetti'), ctx = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
  const W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr;
  const colors = ['#d4b24c', '#f0d57a', '#76c2e5', '#f6e6cd', '#8ba39a', '#ffffff'];
  const parts = Array.from({ length: 180 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.2, y: H * 0.42,
    vx: (Math.random() - 0.5) * 26 * dpr, vy: (-Math.random() * 22 - 8) * dpr,
    w: (6 + Math.random() * 8) * dpr, h: (8 + Math.random() * 12) * dpr,
    r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  cancelAnimationFrame(confettiRaf);
  const step = now => {
    const age = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, Math.min(1, 4 - age));
    for (const p of parts) {
      p.vy += 0.55 * dpr; p.vx *= 0.985; p.vy *= 0.985;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 1.7)));
      ctx.restore();
    }
    if (age < 4) confettiRaf = requestAnimationFrame(step);
  };
  confettiRaf = requestAnimationFrame(step);
}
function stopConfetti() {
  cancelAnimationFrame(confettiRaf);
  const cv = $('#confetti');
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}

/* --- toast --- */
let toastTimer;
function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* =========================================================================
   Staff access: long-press title 3 s → PIN
   ========================================================================= */
let lpTimer;
const hot = $('#adminHotspot');
hot.addEventListener('pointerdown', () => { clearTimeout(lpTimer); lpTimer = setTimeout(openPin, LONG_PRESS_MS); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => hot.addEventListener(ev, () => clearTimeout(lpTimer)));
hot.addEventListener('contextmenu', e => e.preventDefault());

let pinBuf = '';
function openPin() { pinBuf = ''; drawPin(); $('#pinOverlay').hidden = false; }
function drawPin() { $('#pinDots').querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k < pinBuf.length)); }
$('#pinPad').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const k = b.dataset.k;
  if (k === 'cancel') { $('#pinOverlay').hidden = true; return; }
  if (k === 'del') pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 4) pinBuf += b.textContent;
  drawPin();
  if (pinBuf.length === 4) {
    if (pinBuf === config.pin) { $('#pinOverlay').hidden = true; openAdmin(); }
    else {
      const dots = $('#pinDots');
      dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
      setTimeout(() => { pinBuf = ''; drawPin(); }, 350);
    }
  }
});

/* =========================================================================
   Admin
   ========================================================================= */
function openAdmin() {
  $('#admin').hidden = false;
  showTab('board');
}
$('#adminClose').addEventListener('click', () => {
  if (recorder.active) recorder.stop();
  $('#admin').hidden = true;
  renderBoard();
});
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.dataset.tab !== name; });
  if (name === 'board') renderAdminBoard();
  if (name === 'clips') renderClips();
  if (name === 'settings') renderSettings();
}

/* --- board & prizes tab --- */
function fmtTime(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function configDiffers() {
  if (board.rows !== config.rows || board.cols !== config.cols) return true;
  if ((config.blank.trim() || '銘謝惠顧') !== board.blank) return true;
  const a = config.prizes.filter(p => p.count > 0).map(p => `${p.name.trim() || '獎品'}#${p.count}`).join('|');
  const b = board.prizes.map(p => `${p.name}#${p.count}`).join('|');
  return a !== b;
}

function renderAdminBoard() {
  const n = openedCount(), total = board.cells.length;
  const won = board.prizes.reduce((s, p, pi) => s + p.count - remainingOf(pi), 0);
  const prizeAll = board.prizes.reduce((s, p) => s + p.count, 0);
  let txt = `開盤時間 ${fmtTime(board.createdAt)}\n已戳 ${n} / ${total} 格，已開出 ${won} / ${prizeAll} 個獎品。`;
  if (configDiffers()) txt += '\n⚠ 下方設定已變更，按「開新盤」後才會生效。';
  const st = $('#boardStatus');
  st.textContent = txt;
  st.style.whiteSpace = 'pre-line';

  $('#cfgRows').value = config.rows;
  $('#cfgCols').value = config.cols;
  $('#cfgBlank').value = config.blank;
  renderPrizeRows();
  renderSummary();
}

function renderSummary() {
  const total = config.rows * config.cols, pz = prizeTotal();
  $('#cfgTotal').textContent = `＝ ${total} 格`;
  const s = $('#cfgSummary'), btn = $('#newBoard');
  if (pz > total) {
    s.textContent = `獎品共 ${pz} 個，超過格數 ${total}，請減少獎品或加大盤面。`;
    s.classList.add('bad'); btn.disabled = true;
  } else if (pz === 0) {
    s.textContent = '至少要有 1 個獎品。';
    s.classList.add('bad'); btn.disabled = true;
  } else {
    s.textContent = `總共 ${total} 格：獎品 ${pz} 個、${config.blank.trim() || '銘謝惠顧'} ${total - pz} 格（中獎率 ${(pz / total * 100).toFixed(1)}%）`;
    s.classList.remove('bad'); btn.disabled = false;
  }
}

function cfgChanged() { saveState(); renderSummary(); renderAdminBoardStatusOnly(); }
function renderAdminBoardStatusOnly() {
  const st = $('#boardStatus');
  const has = st.textContent.includes('⚠');
  if (configDiffers() !== has) renderAdminBoard();
}

$('#cfgRows').addEventListener('change', e => { config.rows = clampInt(e.target.value, 2, 20, config.rows); e.target.value = config.rows; cfgChanged(); });
$('#cfgCols').addEventListener('change', e => { config.cols = clampInt(e.target.value, 2, 20, config.cols); e.target.value = config.cols; cfgChanged(); });
$('#cfgBlank').addEventListener('input', e => { config.blank = e.target.value; cfgChanged(); });

function renderPrizeRows() {
  const wrap = $('#prizeRows');
  wrap.textContent = '';
  config.prizes.forEach((p, idx) => {
    const row = el('div', 'prize-row');

    const pimg = el('label', 'pimg');
    const url = prizeImg.get(p.id);
    if (url) pimg.style.backgroundImage = `url("${url}")`; else pimg.textContent = '加圖';
    const file = el('input'); file.type = 'file'; file.accept = 'image/*';
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const dataUrl = await shrinkImage(f, 320);
        prizeImg.set(p.id, dataUrl);
        await db.put('images', p.id, dataUrl);
        renderPrizeRows(); renderPanel();
      } catch (e) { toast('圖片讀取失敗'); }
    });
    pimg.appendChild(file);
    row.appendChild(pimg);

    const name = el('input'); name.type = 'text'; name.maxLength = 12; name.placeholder = '獎項名稱'; name.value = p.name;
    name.addEventListener('input', () => { p.name = name.value; cfgChanged(); });
    row.appendChild(name);

    const step = el('div', 'stepper');
    const minus = el('button', '', '−'), plus = el('button', '', '＋');
    const num = el('input'); num.type = 'number'; num.min = 0; num.max = 400; num.inputMode = 'numeric'; num.value = p.count;
    const setN = v => { p.count = clampInt(v, 0, 400, p.count); num.value = p.count; cfgChanged(); };
    minus.addEventListener('click', () => setN(p.count - 1));
    plus.addEventListener('click', () => setN(p.count + 1));
    num.addEventListener('change', () => setN(num.value));
    step.append(minus, num, plus);
    row.appendChild(step);

    const del = el('button', 'del', '✕'); del.title = '刪除這個獎項';
    del.addEventListener('click', () => {
      if (!confirm(`刪除「${p.name || '未命名'}」？`)) return;
      config.prizes.splice(idx, 1);
      cfgChanged(); renderPrizeRows();
    });
    row.appendChild(del);
    wrap.appendChild(row);
  });
}

$('#addPrize').addEventListener('click', () => {
  config.prizes.push({ id: uid(), name: '', count: 1 });
  cfgChanged(); renderPrizeRows();
  const inputs = $('#prizeRows').querySelectorAll('input[type=text]');
  inputs[inputs.length - 1].focus();
});

$('#newBoard').addEventListener('click', async () => {
  const n = openedCount();
  const msg = n > 0
    ? `目前這一盤已戳了 ${n} 格，開新盤會清掉進度並重新洗牌。確定嗎？`
    : '用目前的設定重新洗牌，開一盤新的？';
  if (!confirm(msg)) return;
  board = makeBoard();
  saveState();
  // drop images no longer used by config or the new board
  const keep = new Set(config.prizes.map(p => p.id));
  for (const id of [...prizeImg.keys()]) if (!keep.has(id)) { prizeImg.delete(id); db.del('images', id).catch(() => {}); }
  renderAdminBoard();
  renderBoard();
  toast('已開新盤');
});

function shrinkImage(file, max) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const s = Math.min(im.naturalWidth, im.naturalHeight);
      const cv = document.createElement('canvas'); cv.width = cv.height = Math.min(max, s);
      cv.getContext('2d').drawImage(im, (im.naturalWidth - s) / 2, (im.naturalHeight - s) / 2, s, s, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      res(cv.toDataURL('image/jpeg', 0.85));
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
    im.src = url;
  });
}

/* --- recordings tab --- */
const recorder = {
  active: false, slot: -1, mr: null, stream: null, chunks: [], timer: 0, started: 0, raf: 0, analyser: null,
  mime() {
    for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  },
  async start(slot) {
    if (this.active) return;
    audio.unlock();
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) {}
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast('無法使用麥克風，請到「設定 › Safari › 麥克風」允許'); return; }
    const mime = this.mime();
    this.mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    Object.assign(this, { active: true, slot, stream, chunks: [], started: performance.now() });
    this.mr.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.onstop = () => this.finish();
    this.mr.start();
    try {
      const src = audio.ctx.createMediaStreamSource(stream);
      this.analyser = audio.ctx.createAnalyser(); this.analyser.fftSize = 512;
      src.connect(this.analyser);
    } catch (e) { this.analyser = null; }
    this.timer = setTimeout(() => this.stop(), MAX_REC_SEC * 1000);
    this.tick();
    renderClips();
  },
  tick() {
    const row = document.querySelector(`.clip-row[data-slot="${this.slot}"]`);
    if (row) {
      const sec = (performance.now() - this.started) / 1000;
      row.querySelector('.info').textContent = `錄音中… ${Math.max(0, MAX_REC_SEC - sec).toFixed(0)} 秒後自動停止`;
      const bar = row.querySelector('.meter i');
      if (bar && this.analyser) {
        const a = new Uint8Array(this.analyser.fftSize); this.analyser.getByteTimeDomainData(a);
        let peak = 0; for (const v of a) peak = Math.max(peak, Math.abs(v - 128));
        bar.style.width = Math.min(100, peak / 128 * 160) + '%';
      }
    }
    if (this.active) this.raf = requestAnimationFrame(() => this.tick());
  },
  stop() {
    if (!this.active) return;
    clearTimeout(this.timer);
    try { this.mr.stop(); } catch (e) { this.finish(); }
  },
  async finish() {
    cancelAnimationFrame(this.raf);
    this.stream.getTracks().forEach(t => t.stop());
    const slot = this.slot, type = (this.mr && this.mr.mimeType) || 'audio/mp4';
    this.active = false;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    const blob = new Blob(this.chunks, { type });
    try { await saveClip(slot, await blob.arrayBuffer(), type); }
    catch (e) { toast('錄音儲存失敗，請再試一次'); }
    renderClips();
  },
};

async function saveClip(slot, data, type, maxSec = 20) {
  const buf = await audio.decode(data);
  if (buf.duration > maxSec) throw new Error('too long');
  const start = leadingSilence(buf);
  await db.put('clips', slot, { data, type, start, savedAt: Date.now() });
  audio.clips.set(slot, { buf, start, dur: buf.duration - start });
}

function renderClips() {
  const okMic = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder;
  const warn = $('#micWarn');
  warn.hidden = !!okMic;
  if (!okMic) warn.textContent = window.isSecureContext
    ? '這個瀏覽器不支援直接錄音，可以用「匯入」選擇音檔。'
    : '要放在 HTTPS 網址上才能錄音；目前可以用「匯入」選擇音檔。';

  const wrap = $('#clipRows');
  wrap.textContent = '';
  for (let s = 0; s < MAX_CLIPS; s++) {
    const c = audio.clips.get(s), isRec = recorder.active && recorder.slot === s;
    const row = el('div', 'clip-row'); row.dataset.slot = s;
    row.appendChild(el('div', 'no', s + 1));
    const mid = el('div');
    const info = el('div', 'info' + (c || isRec ? '' : ' empty'), c ? `${c.dur.toFixed(1)} 秒` : '尚未錄音');
    mid.appendChild(info);
    if (isRec) { const m = el('div', 'meter'); m.appendChild(el('i')); mid.appendChild(m); }
    row.appendChild(mid);

    const acts = el('div', 'acts');
    if (isRec) {
      const stop = el('button', 'btn small rec', '■ 停止');
      stop.addEventListener('click', () => recorder.stop());
      acts.appendChild(stop);
    } else {
      const rec = el('button', 'btn small', c ? '重錄' : '● 錄音');
      rec.disabled = !okMic || recorder.active;
      rec.addEventListener('click', () => recorder.start(s));
      acts.appendChild(rec);
      if (c) {
        const play = el('button', 'btn small', '▶ 試聽');
        play.disabled = recorder.active;
        play.addEventListener('click', () => { audio.unlock(); audio.playClip(s); });
        const del = el('button', 'btn small danger', '刪除');
        del.disabled = recorder.active;
        del.addEventListener('click', async () => {
          if (!confirm(`刪除第 ${s + 1} 段錄音？`)) return;
          audio.clips.delete(s);
          await db.del('clips', s).catch(() => {});
          renderClips();
        });
        acts.append(play, del);
      }
      const imp = el('label', 'btn small file', '匯入');
      const f = el('input'); f.type = 'file'; f.accept = 'audio/*';
      f.addEventListener('change', async () => {
        const file = f.files[0];
        if (!file) return;
        try { audio.unlock(); await saveClip(s, await file.arrayBuffer(), file.type || 'audio/mp4'); toast(`第 ${s + 1} 段已匯入`); }
        catch (e) { toast(e.message === 'too long' ? '音檔太長，請選 20 秒以內的' : '這個音檔格式無法使用'); }
        renderClips();
      });
      imp.appendChild(f);
      if (recorder.active) imp.style.pointerEvents = 'none';
      acts.appendChild(imp);
    }
    row.appendChild(acts);
    wrap.appendChild(row);
  }
}

/* --- settings tab --- */
function renderSettings() {
  $('#cfgTitle').value = config.title;
  $('#cfgSubtitle').value = config.subtitle;
  $('#cfgSound').checked = config.sound;
  $('#cfgPrizeSounds').checked = config.prizeSounds;
  $('#cfgVolume').value = config.volume;
  $('#cfgPin').value = '';
  $('#versionText').textContent = `戳戳樂 v${VERSION}`;
  const info = $('#storageInfo');
  info.textContent = '設定、盤面進度、獎品圖和錄音都只存在這台 iPad 上。';
  if (navigator.storage && navigator.storage.estimate) {
    Promise.all([navigator.storage.estimate(), navigator.storage.persisted ? navigator.storage.persisted() : false])
      .then(([est, kept]) => {
        info.textContent += ` 目前使用約 ${(est.usage / 1048576).toFixed(1)} MB${kept ? '，已設為永久保存' : ''}。`;
      }).catch(() => {});
  }
}
$('#cfgTitle').addEventListener('input', e => { config.title = e.target.value; saveState(); renderHeader(); });
$('#cfgSubtitle').addEventListener('input', e => { config.subtitle = e.target.value; saveState(); renderHeader(); });
$('#cfgSound').addEventListener('change', e => { config.sound = e.target.checked; saveState(); });
$('#cfgPrizeSounds').addEventListener('change', e => { config.prizeSounds = e.target.checked; saveState(); });
$('#cfgVolume').addEventListener('input', e => { config.volume = +e.target.value; if (audio.master) audio.master.gain.value = config.volume; saveState(); });
$('#testSound').addEventListener('click', () => {
  audio.unlock();
  if (!config.sound) { toast('音效目前是關閉的'); return; }
  const names = board.prizes.map(p => p.name);
  const name = names.length ? names[randInt(names.length)] : '';
  if (name) toast(`試聽：${name}`, 1200);
  audio.win(name);
});
$('#savePin').addEventListener('click', () => {
  const v = $('#cfgPin').value.trim();
  if (!/^\d{4}$/.test(v)) { toast('密碼要是 4 位數字'); return; }
  config.pin = v; saveState(); $('#cfgPin').value = '';
  toast('密碼已更新');
});
$('#factoryReset').addEventListener('click', () => {
  if (!confirm('清除全部資料？設定、盤面進度、獎品圖和錄音都會刪除，無法復原。')) return;
  if (!confirm('再確認一次：真的要全部清除？')) return;
  localStorage.removeItem(LS_KEY);
  const r = indexedDB.deleteDatabase('pokepoke');
  r.onsuccess = r.onerror = r.onblocked = () => location.reload();
});

/* =========================================================================
   Boot
   ========================================================================= */
let fitRaf = 0;
const refit = () => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(fitBoard); };
window.addEventListener('resize', refit);
if (window.ResizeObserver) new ResizeObserver(refit).observe(frameEl);

// keep the iPad awake while the game is on screen
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); }
  catch (e) { /* not supported / denied */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
document.addEventListener('pointerdown', () => { if (!wakeLock || wakeLock.released) keepAwake(); }, { passive: true });

// stop pinch / double-tap zoom and the rubber-band scroll on iPad
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('touchmove', e => { if (!e.target.closest('.admin-body, #prizeList')) e.preventDefault(); }, { passive: false });

(async function boot() {
  loadState();
  await loadImages();
  renderBoard();
  loadClips();
  loadPrizeSounds();
  keepAwake();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
  }
})();
