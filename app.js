(() => {
'use strict';

/* Arizona MVD knowledge-test trainer. Data comes from data.js (window.BANK, built by tools/build.py).
   Progress lives in localStorage; everything works offline from file://. */

const B = window.BANK;
const QS = B.questions;
const SECS = B.sections;
const BY_ID = new Map(QS.map(q => [q.id, q]));
const SEC = new Map(SECS.map(s => [s.id, s]));
const SEC_Q = new Map(SECS.map(s => [s.id, QS.filter(q => q.s === s.id)]));
const BD = window.BADGES;
const BADGES = BD.badges;
const BADGE_BY_ID = new Map(BADGES.map(b => [b.id, b]));
const EXAM_SIZE = B.meta.exam_size;
const PASS_PCT = B.meta.pass_pct;
const MANUAL = 'manual/Arizona-Driver-License-Manual.pdf';
const KEY = 'azmvd.v1';
const BACKUP_KEY = 'azmvd.v1.before-battle';
const BACKUP_KEY_50 = 'azmvd.v1.before-limit50';
const LETTERS = ['A', 'B', 'C'];
const $app = document.getElementById('app');
const R = window.SRS;
const ALL_IDS = QS.map(q => q.id);
const SEC_IDS = new Map(SECS.map(s => [s.id, new Set(SEC_Q.get(s.id).map(q => q.id))]));
/* new questions come section by section in manual order, by page inside a section */
const MANUAL_ORDER = SECS.flatMap(s => SEC_Q.get(s.id).slice().sort((a, b) => a.p - b.p).map(q => q.id));

/* ---------- helpers ---------- */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(2)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
function shuffled(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
const plural = (n, f) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return f[a > 10 && a < 20 ? 2 : b > 1 && b < 5 ? 1 : b === 1 ? 0 : 2];
};
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const manualLink = p => h('a', { href: `${MANUAL}#page=${p}`, target: '_blank', rel: 'noopener' }, `мануал, стр. ${p}`);
const srcLabel = q => (q.src === 'o' ? `ADOT Practice Test #${q.t}, вопрос ${q.n}` : 'вопрос по мануалу');

/* ---------- state (localStorage, with in-memory fallback) ---------- */
let persist = true;
const freshSrs = () => ({
  cards: {}, cfg: Object.assign({}, R.DEFAULTS), cur: null,
  today: { day: 0, newDone: 0, revDone: 0, extraNew: 0 }, focus: null,
});
const freshBattles = () => ({ wins: 0, losses: 0, streak: 0, bestStreak: 0 });
const freshStreak = () => ({ last: 0, cur: 0, best: 0 });
const fresh = () => ({ v: 2, stats: {}, settings: { shuffle: true }, session: null, history: [], srs: freshSrs(), battle: null, battles: freshBattles(), streak: freshStreak(), badges: {}, badgeNew: [], limit50: true });
/* v1 -> v2: answers given before the schedule existed are only in stats. Bring them in once:
   last answer right -> learned (review, first interval as after "Хорошо"), wrong -> learning. */
function importStats(s) {
  const cfg = s.srs.cfg;
  const sGood = R.initS(R.GOOD), ivl = Math.max(1, Math.round(R.ivlFor(sGood, cfg.retention)));
  for (const [id, x] of Object.entries(s.stats)) {
    if (!BY_ID.has(id) || s.srs.cards[id] || !x.n) continue;
    const ts = x.ts || Date.now();
    s.srs.cards[id] = x.last === 1
      ? { st: R.REVIEW, step: 0, s: sGood, d: R.initD(R.GOOD), due: 0, ivl, day: R.dayOf(ts) + ivl, last: ts, reps: x.n, lapses: 0 }
      : R.schedule({}, R.AGAIN, ts, cfg, id);
  }
}
/* a saved state of any earlier version -> the current shape; whatever a version did not have gets its default */
function adopt(s) {
  const out = Object.assign(fresh(), s);
  out.srs = Object.assign(freshSrs(), out.srs);
  out.srs.cfg = Object.assign({}, R.DEFAULTS, out.srs.cfg);
  /* 1.4.1: the daily limit of new questions went from 20 to 50. A saved config keeps its old number, so raise it once
     (never lower a higher one); the marker keeps a later choice of the player from being overridden */
  if (!s.limit50) out.srs.cfg.newPerDay = Math.max(out.srs.cfg.newPerDay, 50);
  out.limit50 = true;
  out.battles = Object.assign(freshBattles(), out.battles);
  out.streak = Object.assign(freshStreak(), out.streak);
  out.badges = Object.assign({}, out.badges);
  out.badgeNew = (out.badgeNew || []).filter(id => BADGE_BY_ID.has(id));
  return out;
}
function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && (s.v === 1 || s.v === 2)) {
        /* a copy of the progress as it was before the card battle appeared, kept once */
        if (!('battles' in s) && localStorage.getItem(BACKUP_KEY) === null) localStorage.setItem(BACKUP_KEY, raw);
        if (!s.limit50 && localStorage.getItem(BACKUP_KEY_50) === null) localStorage.setItem(BACKUP_KEY_50, raw);
        return adopt(s);
      }
    }
  } catch (e) { /* storage unavailable: start empty */ }
  return fresh();
}
let state = loadState();
if (state.v === 1) {
  importStats(state);
  state.v = 2;
  store();
}
function save() {
  state.savedAt = Date.now();
  store();
  syncSoon();
}
function store() {
  awardCheck();
  if (!persist) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode etc. */ }
  if (state.badgeNew.length) setTimeout(showAward, 0);
}

/* ---------- sync between devices (a secret gist on the player's GitHub) ----------
   Every device keeps a token that may only touch gists. On open, when the page comes back and a few seconds after a
   save the gist is read, merged into this device's progress and written back, so two devices never wipe each other.
   The merge goes piece by piece: per question the later answer and the later review win, exams and badges are joined,
   counters take the larger. What is on screen right now (a test, a fight, the current card) stays this device's own.
   A reset is a time stamp: whatever is older than the latest reset on any device is dropped. */
const SYNC_KEY = 'azmvd.sync';
const SYNC_BACKUP_KEY = 'azmvd.v1.before-sync';
const SYNC_FILE = 'azmvd-progress.json';
const SYNC_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=AZ%20MVD%20sync';
const GH_API = 'https://api.github.com';
const freshSync = () => ({ token: '', gist: '', at: 0, err: '' });
let sync = freshSync();
try { sync = Object.assign(freshSync(), JSON.parse(localStorage.getItem(SYNC_KEY) || '{}')); } catch (e) { /* no storage */ }
function saveSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) { /* no storage */ }
}

function mergeStates(mine, other) {
  const cut = Math.max(mine.resetAt || 0, other.resetAt || 0);
  const live = s => ((s.savedAt || 0) >= cut ? s : Object.assign(fresh(), { savedAt: s.savedAt }));
  const a = live(mine), b = live(other);
  const srsCut = Math.max(cut, a.srs.resetAt || 0, b.srs.resetAt || 0);
  const newer = (a.savedAt || 0) >= (b.savedAt || 0) ? a : b;
  const out = adopt(JSON.parse(JSON.stringify(Object.assign({}, newer, { session: null, battle: null }))));
  /* what is on screen on this device */
  out.session = mine.session;
  out.battle = mine.battle;
  out.settings = mine.settings;
  out.srs.cur = mine.srs.cur;
  out.srs.focus = mine.srs.focus;
  out.badgeNew = mine.badgeNew.slice();

  const pickBy = (x, y, f) => (!x ? y : !y ? x : f(y) > f(x) ? y : x);
  out.stats = {};
  for (const id of new Set([...Object.keys(a.stats), ...Object.keys(b.stats)])) {
    const x = pickBy(a.stats[id], b.stats[id], s => s.ts || 0);
    if ((x.ts || 0) >= cut) out.stats[id] = x;
  }
  out.srs.cards = {};
  for (const id of new Set([...Object.keys(a.srs.cards), ...Object.keys(b.srs.cards)])) {
    const x = pickBy(a.srs.cards[id], b.srs.cards[id], c => (c.last || 0) * 1e4 + (c.reps || 0));
    if ((x.last || 0) >= srsCut) out.srs.cards[id] = x;
  }
  const ta = a.srs.today, tb = b.srs.today;
  out.srs.today = ta.day !== tb.day ? Object.assign({}, ta.day > tb.day ? ta : tb)
    : { day: ta.day, newDone: Math.max(ta.newDone, tb.newDone), revDone: Math.max(ta.revDone, tb.revDone), extraNew: Math.max(ta.extraNew, tb.extraNew) };
  const hist = new Map([...a.history, ...b.history].filter(x => x.ts >= cut).map(x => [`${x.ts}|${x.title}`, x]));
  out.history = [...hist.values()].sort((x, y) => x.ts - y.ts).slice(-30);
  out.badges = {};
  for (const s of [a, b]) {
    for (const [id, ts] of Object.entries(s.badges)) if (!(id in out.badges) || ts < out.badges[id]) out.badges[id] = ts;
  }
  out.battles = {
    wins: Math.max(a.battles.wins, b.battles.wins), losses: Math.max(a.battles.losses, b.battles.losses),
    streak: newer.battles.streak, bestStreak: Math.max(a.battles.bestStreak, b.battles.bestStreak),
  };
  const sa = a.streak, sb = b.streak, sl = sa.last >= sb.last ? sa : sb;
  out.streak = { last: sl.last, cur: sa.last === sb.last ? Math.max(sa.cur, sb.cur) : sl.cur, best: Math.max(sa.best, sb.best) };
  out.resetAt = cut;
  out.srs.resetAt = srsCut;
  out.savedAt = Math.max(a.savedAt || 0, b.savedAt || 0);
  return out;
}
/* what goes to the gist: everything but the on-screen parts */
const shareable = s => Object.assign({}, s, { session: null, battle: null, badgeNew: [], srs: Object.assign({}, s.srs, { cur: null, focus: null }) });

class SyncError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
async function ghApi(path, opts = {}) {
  let r;
  try {
    r = await fetch(GH_API + path, Object.assign({ cache: 'no-store' }, opts, {
      headers: { Authorization: `Bearer ${sync.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    }));
  } catch (e) { throw new SyncError(0, 'нет связи с GitHub'); }
  if (!r.ok) {
    throw new SyncError(r.status, r.status === 401 ? 'токен не подходит или истёк'
      : r.status === 403 ? 'у токена нет права на gist (нужна галочка «gist»)'
      : r.status === 404 ? 'gist не найден' : `GitHub ответил ${r.status}`);
  }
  return r.json();
}
async function findGist() {
  for (let page = 1; page <= 10; page++) {
    const list = await ghApi(`/gists?per_page=100&page=${page}`);
    const g = list.find(x => x.files && x.files[SYNC_FILE]);
    if (g) return ghApi(`/gists/${g.id}`);
    if (list.length < 100) return null;
  }
  return null;
}
async function gistState(g) {
  const f = g && g.files[SYNC_FILE];
  if (!f) return null;
  let text = f.content;
  if (f.truncated) {
    try { text = await (await fetch(f.raw_url, { cache: 'no-store' })).text(); } catch (e) { throw new SyncError(0, 'нет связи с GitHub'); }
  }
  try {
    const d = JSON.parse(text);
    return d && d.app === 'azmvd' && d.state ? { text, state: adopt(d.state) } : null;
  } catch (e) { return null; }
}

let syncTimer = null, syncBusy = null, syncAgain = false;
function syncSoon(ms = 4000) {
  if (!persist || !sync.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, ms);
}
function syncNow() {
  clearTimeout(syncTimer);
  if (!persist || !sync.token) return Promise.resolve();
  if (syncBusy) { syncAgain = true; return syncBusy; }
  syncBusy = (async () => {
    let changed = false;
    try {
      let g = null;
      if (sync.gist) g = await ghApi(`/gists/${sync.gist}`).catch(e => { if (e.status === 404) return null; throw e; });
      if (!g) g = await findGist();
      const remote = await gistState(g);
      if (remote) {
        const before = JSON.stringify(shareable(state));
        state = mergeStates(state, remote.state);
        changed = JSON.stringify(shareable(state)) !== before;
        if (changed) store();
      }
      const text = JSON.stringify({ app: 'azmvd', v: 1, state: shareable(state) });
      const files = { [SYNC_FILE]: { content: text } };
      if (!g) g = await ghApi('/gists', { method: 'POST', body: JSON.stringify({ description: 'AZ MVD trainer progress', public: false, files }) });
      else if (!remote || remote.text !== text) await ghApi(`/gists/${g.id}`, { method: 'PATCH', body: JSON.stringify({ files }) });
      Object.assign(sync, { gist: g.id, at: Date.now(), err: '' });
    } catch (e) {
      sync.err = e.message || String(e);
    }
    saveSync();
    syncBusy = null;
    if (syncAgain) { syncAgain = false; syncSoon(500); }
    syncRefresh(changed);
  })();
  return syncBusy;
}
/* the pages that only show progress are redrawn when the other device brought something; a question in progress is not */
function syncRefresh(changed) {
  const route = location.hash.replace(/^#\/?/, '').split('/')[0];
  const typing = document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (typing) return;   // a badge dialog sits on top of the page and may stay
  if ((changed && (route === '' || route === 'srs')) || route === 'stats') render({ keepScroll: true });
}
function syncConnect(token) {
  try {
    if (localStorage.getItem(SYNC_BACKUP_KEY) === null) localStorage.setItem(SYNC_BACKUP_KEY, JSON.stringify(state));
  } catch (e) { /* no storage */ }
  sync = Object.assign(freshSync(), { token: token.trim() });
  saveSync();
  return syncNow().then(() => {
    if (sync.err && !sync.at) { sync.token = ''; saveSync(); render({ keepScroll: true }); }   // never worked: back to the form
  });
}
function syncDisconnect() {
  sync = freshSync();
  saveSync();
  render({ keepScroll: true });
}
const fmtWhen = ts => new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
function syncCard() {
  if (!sync.token) {
    let input;
    return h('div', { class: 'card' },
      h('p', { style: 'margin:0 0 8px' }, 'Прогресс можно держать общим для телефона и компьютера: он хранится в секретном gist на вашем GitHub.'),
      h('ol', { class: 'muted small', style: 'margin:0 0 10px;padding-left:20px' },
        h('li', null, h('a', { href: SYNC_TOKEN_URL, target: '_blank', rel: 'noopener' }, 'Создайте токен'),
          ': галочка только «gist», срок — какой удобно (No expiration — навсегда).'),
        h('li', null, 'Вставьте его сюда. На другом устройстве — тот же токен.')),
      sync.err && h('p', { class: 'small', style: 'margin:0 0 8px;color:#c0392b' }, `Не получилось: ${sync.err}`),
      h('div', { class: 'row' },
        input = h('input', { type: 'password', placeholder: 'ghp_…', autocomplete: 'off', spellcheck: 'false', style: 'flex:1;min-width:0;padding:8px;font-size:16px', 'aria-label': 'Токен GitHub' }),
        h('button', {
          class: 'btn primary', type: 'button',
          onclick: e => {
            if (!input.value.trim()) return input.focus();
            e.target.disabled = true;
            e.target.textContent = 'Подключаю…';
            syncConnect(input.value);
          },
        }, 'Подключить')));
  }
  const status = sync.err ? `ошибка: ${sync.err}${sync.at ? ` · последний удачный обмен ${fmtWhen(sync.at)}` : ''}`
    : sync.at ? `включена · последний обмен ${fmtWhen(sync.at)}` : 'включена · обмениваюсь…';
  return h('div', { class: 'card' },
    h('p', { style: 'margin:0 0 10px' }, `Синхронизация ${status}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: e => { e.target.disabled = true; syncNow(); } }, 'Обменяться сейчас'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { if (window.confirm('Отключить синхронизацию на этом устройстве? Прогресс здесь останется.')) syncDisconnect(); } },
        'Отключить на этом устройстве')));
}

/* ---------- stats ---------- */
const st = id => state.stats[id];
function record(id, ok) {
  const s = state.stats[id] || (state.stats[id] = { n: 0, c: 0, last: null, ts: 0 });
  s.n++;
  if (ok) s.c++;
  s.last = ok ? 1 : 0;
  s.ts = Date.now();
  touchStreak(s.ts);
}

/* ---------- streak ----------
   A day counts as soon as one question is answered anywhere (tests, "Учить", the battle; an exam counts when it is
   finished). Days roll over at 4:00 like the schedule. The streak lives until the end of the day after the last
   counted one; one missed day starts it again from 1. */
function touchStreak(now) {
  const s = state.streak, d = R.dayOf(now);
  if (d <= s.last) return;
  s.cur = s.last === d - 1 ? s.cur + 1 : 1;
  s.best = Math.max(s.best, s.cur);
  s.last = d;
}
function streakNow(now = Date.now()) {
  const s = state.streak, d = R.dayOf(now);
  return { cur: s.last >= d - 1 ? s.cur : 0, done: s.last === d, best: s.best };
}

/* ---------- badges ----------
   The art, names and "how to get" are in badges.js (made by tools/badges.py, shared with the Android app). Whether a
   badge is earned is worked out from the saved state alone, so it is also handed out for what was done before it existed.
   A new one is queued in state.badgeNew and announced in a dialog until the player closes it. */
function badgesEarnedNow() {
  const got = new Set();
  for (const s of SECS) {
    if (SEC_Q.get(s.id).every(q => { const c = state.srs.cards[q.id]; return c && c.st === R.REVIEW; })) got.add(`sec-${s.id}`);
  }
  for (const n of [3, 7, 14, 30]) if (state.streak.best >= n) got.add(`streak-${n}`);
  const bt = state.battles, b = state.battle;
  if (bt.wins >= 1) got.add('win-first');
  if (bt.bestStreak >= 3) got.add('win-three');
  if (b && b.endedAt && b.cop <= 0 && !b.gaveUp) {
    if (b.me >= BATTLE_HP) got.add('win-flawless');
    if (b.me <= 2) got.add('win-close');
  }
  for (const x of state.history) {
    if (x.passed) got.add('exam-pass');
    if (x.total > 0 && x.correct === x.total) got.add('exam-perfect');
  }
  return got;
}
function awardCheck(now = Date.now()) {
  let n = 0;
  for (const id of badgesEarnedNow()) {
    if (id in state.badges) continue;
    state.badges[id] = now;
    state.badgeNew.push(id);
    n++;
  }
  return n;
}

/* the ghost rider's flame, by an equation: column i of the head's width rises as a parabola, times a wobble of two sines
   that run once and twice per loop (p is the loop phase, 0..1); colour by the share of the way up */
function drawFlame(g, f, p) {
  const w = f.x1 - f.x0 + 1, tau = 2 * Math.PI;
  for (let i = 0; i < w; i++) {
    const u = (i - (w - 1) / 2) / (w / 2);
    const h = f.h * (1 - u * u) * (0.75 + 0.25 * Math.sin(2.1 * i + tau * p) + 0.15 * Math.sin(3.7 * i - 2 * tau * p));
    const rows = Math.min(f.base + 1, Math.ceil(h));
    for (let r = 0; r < rows; r++) {
      g.fillStyle = BD.flameStops.find(s => r / h < s.t).c;
      g.fillRect(f.x0 + i, f.base - r, 1, 1);
    }
  }
}
function drawBadge(c, p) {
  const g = c.getContext && c.getContext('2d');
  if (!g) return;
  const b = c._badge, on = c._on;
  g.clearRect(0, 0, BD.size, BD.size);
  b.art.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    g.fillStyle = on ? b.pal[ch] : BD.dim;
    g.fillRect(x, y, 1, 1);
  }));
  if (on && b.flame) drawFlame(g, b.flame, p);
}
function badgeCanvas(b, on) {
  const c = h('canvas', { class: `badge-art ${on && b.flame ? 'flaming' : ''}`, width: BD.size, height: BD.size, 'aria-hidden': 'true' });
  c._badge = b;
  c._on = on;
  drawBadge(c, 0);
  return c;
}
const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
function flameTick() {
  if (document.hidden || reduceMotion()) return;
  const p = (Date.now() % 2400) / 2400;
  document.querySelectorAll('canvas.flaming').forEach(c => drawBadge(c, p));
}

function badgeBtn(b) {
  const on = b.id in state.badges;
  return h('button', {
    class: `badge ${on ? 'on' : 'off'}`, type: 'button', title: on ? b.title : `${b.title} (ещё не получена)`,
    'aria-label': `${b.title}: ${on ? 'получена' : 'ещё не получена'}`, onclick: () => showBadge(b),
  }, badgeCanvas(b, on));
}
const badgeCount = list => list.filter(b => b.id in state.badges).length;
/* wide screens: two columns in the empty space either side of the mode tiles */
function badgeRails() {
  const rail = (cls, label, list) => h('aside', { class: `rail ${cls}`, 'aria-label': label },
    h('div', { class: 'rail-title' }, `${label} ${badgeCount(list)}/${list.length}`),
    h('div', { class: 'rail-grid' }, list.map(badgeBtn)));
  return [rail('left', 'Разделы', BADGES.filter(b => b.group === 'sec')), rail('right', 'Награды', BADGES.filter(b => b.group !== 'sec'))];
}
/* narrow screens: the same badges in a folded card */
function badgeStrip() {
  return h('details', { class: 'card badges-inline' },
    h('summary', null, `Награды: ${badgeCount(BADGES)} из ${BADGES.length}`),
    h('div', { class: 'rail-grid wrap' }, BADGES.map(badgeBtn)));
}

let awardEl = null;
function closeAward() {
  if (!awardEl) return;
  const award = awardEl._award;
  awardEl.remove();
  awardEl = null;
  if (award) { state.badgeNew.shift(); save(); }
}
/* award: the announcement of a new badge (the queue moves on when it is closed); otherwise the details of one */
function openBadgeDialog(b, award) {
  const on = b.id in state.badges;
  const more = award ? state.badgeNew.length - 1 : 0;
  awardEl = h('div', { class: 'award', onclick: e => { if (e.target === awardEl) closeAward(); } },
    h('div', { class: `award-card ${award ? 'fresh' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': b.title },
      h('div', { class: 'award-kicker' }, award ? 'Получена награда!' : on ? 'Награда получена' : 'Ещё не получена'),
      h('div', { class: `badge big ${on ? 'on' : 'off'}` }, badgeCanvas(b, on)),
      h('h2', null, b.title),
      h('p', { class: 'muted' }, b.how),
      !award && on && h('p', { class: 'muted small' }, new Date(state.badges[b.id]).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })),
      more > 0 && h('p', { class: 'muted small' }, `Ещё ${more}`),
      h('button', { class: 'btn primary', type: 'button', onclick: closeAward }, award ? 'Класс!' : 'Закрыть')));
  awardEl._award = !!award;
  document.body.append(awardEl);
  const btn = awardEl.querySelector('button.btn');
  if (btn && btn.focus) btn.focus();
}
function showAward() {
  if (awardEl || !persist) return;
  const b = BADGE_BY_ID.get(state.badgeNew[0]);
  if (b) openBadgeDialog(b, true);
}
function showBadge(b) {
  if (awardEl) return;
  openBadgeDialog(b, false);
}

/* ---------- reminders ----------
   Up to three a day: one at a random time 10:00-12:00 and two 18:00-21:00 (at least 45 minutes apart). The times are a
   function of the date, so they are the same after a reload. A reminder is skipped once the day has counted for the
   streak. A web page cannot wake itself: these fire only while the tab is open (the Android app does it properly). */
const REMIND_AM = [10 * 60, 12 * 60], REMIND_PM = [18 * 60, 21 * 60], REMIND_GAP = 45, REMIND_LATE = 30 * 60e3;
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* minutes after local midnight of the date `day` (days since 1970, as a calendar date) */
function remindPlan(day) {
  const r = rng(day * 2654435761 + 12345);
  const am = REMIND_AM[0] + Math.floor(r() * (REMIND_AM[1] - REMIND_AM[0]));
  const a = REMIND_PM[0] + Math.floor(r() * ((REMIND_PM[1] - REMIND_PM[0]) / 2));
  const b = a + REMIND_GAP + Math.floor(r() * (REMIND_PM[1] - (a + REMIND_GAP)));
  return [am, a, b];
}
/* the next planned moment after `now`: { at: ms, slot: 0 morning | 1 evening | 2 late evening } */
function remindNext(now) {
  const base = new Date(now);
  for (let i = 0; i < 3; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const day = Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
    const plan = remindPlan(day);
    for (let slot = 0; slot < plan.length; slot++) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, plan[slot]).getTime();
      if (at > now) return { at, slot };
    }
  }
}
function remindText(slot, streak) {
  if (slot === 0) return 'Пара вопросов по мануалу, пока голова свежая?';
  if (slot === 1) return streak ? `Серия ${daysWord(streak)}. Не дай ей сгореть: хватит одного вопроса.` : 'Пара вопросов перед сном — и экзамен ближе.';
  return streak ? 'Последний шанс сегодня: один вопрос сохранит серию.' : 'Ещё не поздно: один вопрос — и день не пропал.';
}
function toast(text) {
  const el = h('div', { class: 'toast', role: 'status', onclick: () => el.remove() }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 15000);
}
let remindTimer = null;
function remindSchedule() {
  clearTimeout(remindTimer);
  remindTimer = null;
  if (!state.settings.remind) return;
  const next = remindNext(Date.now());
  if (!next) return;
  remindTimer = setTimeout(() => {
    const s = streakNow();
    /* a sleeping computer wakes the timer late: a reminder hours old is not worth showing */
    if (state.settings.remind && !s.done && Date.now() - next.at < REMIND_LATE) {
      const text = remindText(next.slot, s.cur);
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification('Тренажёр MVD', { body: text, tag: 'azmvd-remind' }); } catch (e) { toast(text); }
      } else toast(text);
    }
    remindSchedule();
  }, Math.min(next.at - Date.now(), 2 ** 31 - 1));
}
function setRemind(on) {
  state.settings.remind = on;
  save();
  if (on && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(remindSchedule, remindSchedule);
  }
  remindSchedule();
}

/* unseen first, then wrong, then correct ones (least-correct first); random inside each group */
function pick(pool, n) {
  const groups = new Map();
  for (const q of pool) {
    const s = st(q.id);
    const k = !s ? 0 : s.last === 0 ? 1 : 2 + Math.min(s.c, 5);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(q);
  }
  const out = [];
  for (const k of [...groups.keys()].sort((a, b) => a - b)) {
    for (const q of shuffled(groups.get(k))) if (out.length < n) out.push(q);
  }
  return out;
}

function buildExam() {
  const w = SECS.map(s => s.official + 2);
  const total = w.reduce((a, b) => a + b, 0);
  const quota = w.map(x => (EXAM_SIZE * x) / total);
  const base = quota.map(Math.floor);
  let left = EXAM_SIZE - base.reduce((a, b) => a + b, 0);
  quota.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
    if (left > 0) { base[i]++; left--; }
  });
  const chosen = [];
  SECS.forEach((s, i) => chosen.push(...pick(SEC_Q.get(s.id), base[i])));
  if (chosen.length < EXAM_SIZE) {
    const have = new Set(chosen.map(q => q.id));
    chosen.push(...pick(QS.filter(q => !have.has(q.id)), EXAM_SIZE - chosen.length));
  }
  return shuffled(chosen);
}

/* ---------- sessions ---------- */
function makeSession(mode, title, qs, opts = {}) {
  const ord = {};
  for (const q of qs) {
    const idx = [0, 1, 2];
    ord[q.id] = state.settings.shuffle && !q.fx && !opts.keepOrder ? shuffled(idx) : idx;
  }
  return Object.assign({
    mode, title, ids: qs.map(q => q.id), ord, ans: {}, idx: 0,
    startedAt: Date.now(), finished: false, deferred: false, passPct: PASS_PCT,
  }, opts);
}
function begin(S) {
  state.session = S;
  save();
  go('run');
}
const startSection = id => begin(makeSession('practice', `Тест: ${SEC.get(id).name}`, pick(SEC_Q.get(id), 20), { sec: id }));
const startExam = () => begin(makeSession('exam', `Экзамен, ${EXAM_SIZE} вопросов`, buildExam(), { deferred: true }));
function startOfficial(t) {
  const qs = QS.filter(q => q.src === 'o' && q.t === t).sort((a, b) => a.n - b.n);
  begin(makeSession('official', `Официальный тест ADOT №${t}`, qs, { deferred: true, keepOrder: true }));
}

function computeResult(S) {
  let correct = 0;
  for (const id of S.ids) if (S.ans[id] !== undefined && S.ans[id] === BY_ID.get(id).a) correct++;
  const total = S.ids.length;
  const need = Math.ceil((total * S.passPct) / 100);
  return { correct, total, need, passed: correct >= need, answered: Object.keys(S.ans).length };
}
function finish() {
  const S = state.session;
  if (!S || S.finished) return go('result');
  S.finished = true;
  S.endedAt = Date.now();
  if (S.deferred) {
    for (const id of S.ids) {
      if (S.ans[id] === undefined) continue;
      const ok = S.ans[id] === BY_ID.get(id).a;
      record(id, ok);
      srsSchedule(id, ok ? R.GOOD : R.AGAIN, true);
    }
  }
  S.result = computeResult(S);
  if (S.deferred) {
    state.history.push({ ts: Date.now(), title: S.title, correct: S.result.correct, total: S.result.total, passed: S.result.passed });
    state.history = state.history.slice(-30);
  }
  save();
  go('result');
}
function choose(q, orig) {
  const S = state.session;
  if (!S || S.finished) return;
  if (!S.deferred && S.ans[q.id] !== undefined) return;
  S.ans[q.id] = orig;
  if (!S.deferred) {
    record(q.id, orig === q.a);
    srsSchedule(q.id, orig === q.a ? R.GOOD : R.AGAIN, true);
  }
  save();
  render({ keepScroll: true });
}
function step(delta) {
  const S = state.session;
  const next = S.idx + delta;
  if (next < 0) return;
  if (next >= S.ids.length) return finish();
  S.idx = next;
  save();
  render();
}
function jump(i) {
  state.session.idx = i;
  save();
  render();
}

/* ---------- spaced repetition (FSRS, srs.js) ---------- */
function srsToday(now = Date.now()) {
  const T = state.srs.today, d = R.dayOf(now);
  if (T.day !== d) Object.assign(T, { day: d, newDone: 0, revDone: 0, extraNew: 0 });
  return T;
}
/* the section last opened in "Учить" goes first, the rest follow in manual order */
function newOrder() {
  const f = SEC_IDS.get(state.srs.focus);
  return f ? [...MANUAL_ORDER.filter(id => f.has(id)), ...MANUAL_ORDER.filter(id => !f.has(id))] : MANUAL_ORDER;
}
/* sec: study one section only (null = all) */
const srsQueue = (now = Date.now(), sec = null) =>
  R.queue(newOrder(), state.srs.cards, srsToday(now), now, state.srs.cfg, sec ? SEC_IDS.get(sec) : null);
const learnRoute = sec => (sec ? `learn/${sec}` : 'learn');
function openLearn(sec) {
  if (sec) { state.srs.focus = sec; save(); }
  go(learnRoute(sec));
}
function srsSetCur(id) {
  const q = BY_ID.get(id);
  state.srs.cur = { id, ord: state.settings.shuffle && !q.fx ? shuffled([0, 1, 2]) : [0, 1, 2] };
  save();
  return state.srs.cur;
}
function srsCurrent(now = Date.now(), sec = null) {
  const X = state.srs;
  if (X.cur && BY_ID.has(X.cur.id)) {
    const q = BY_ID.get(X.cur.id);
    if (!sec || q.s === sec) return X.cur;
    /* answered in another section but not graded yet: keep the answer */
    if (X.cur.ans !== undefined) srsSchedule(q.id, X.cur.ans === q.a ? R.GOOD : R.AGAIN);
  }
  const next = srsQueue(now, sec).next;
  X.cur = null;
  return next ? srsSetCur(next) : null;
}
function srsPick(q, orig) {
  const cur = state.srs.cur;
  if (!cur || cur.id !== q.id || cur.ans !== undefined) return;
  cur.ans = orig;
  record(q.id, orig === q.a);
  save();
  render({ keepScroll: true });
}
/* One schedule for everything. New questions come in through "Учить"; tests (exam, ADOT, section tests) only check:
   they move questions already being learned (right = Good, wrong = Again) and send a mistake on a new question
   straight to learning, outside the daily new limit. A right answer on a new question waits for its turn. */
function srsSchedule(id, g, test = false) {
  const X = state.srs;
  const card = X.cards[id];
  const T = srsToday();
  const isNew = !card || card.st === R.NEW;
  if (isNew && test && g !== R.AGAIN) return;
  if (isNew && !test) T.newDone++;
  else if (!isNew && card.st === R.REVIEW) T.revDone++;
  X.cards[id] = R.schedule(card || {}, g, Date.now(), X.cfg, id);
  if (X.cur && X.cur.id === id) X.cur = null;
}
function srsRate(g) {
  const cur = state.srs.cur;
  if (!cur || cur.ans === undefined) return;
  srsSchedule(cur.id, g);
  save();
  render();
}
function srsShowAhead(sec = null) {
  const id = srsQueue(Date.now(), sec).learnFirst;
  if (id) { srsSetCur(id); render(); }
}
function srsMoreNew(n, sec = null) {
  srsToday().extraNew += n;
  save();
  go(learnRoute(sec));
}
function srsDeckStats() {
  const c = { new: 0, learn: 0, young: 0, mature: 0 };
  for (const id of ALL_IDS) {
    const k = state.srs.cards[id];
    if (!k || k.st === R.NEW) c.new++;
    else if (k.st !== R.REVIEW) c.learn++;
    else if (k.ivl >= 21) c.mature++;
    else c.young++;
  }
  return c;
}
function fmtIvl(p) {
  const num = x => String(Math.round(x * 10) / 10).replace('.', ',');
  if (p.mins !== undefined) return p.mins < 1 ? '<1 мин' : p.mins < 60 ? `${p.mins} мин` : `${num(p.mins / 60)} ч`;
  const d = p.days;
  if (d < 31) return `${d} ${plural(d, ['день', 'дня', 'дней'])}`;
  if (d < 365) return `${num(d / 30)} мес.`;
  return `${num(d / 365)} г.`;
}
const fmtDay = day => new Date(day * 864e5).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const daysWord = n => `${n} ${plural(n, ['день', 'дня', 'дней'])}`;

/* ---------- card battle (same rules as the Android app, Battle.kt) ----------
   15 HP each, turns alternate, you start. Your cards are what "Учить" would show now (new, learning, due):
   right = the cop takes 1, wrong = a miss, and the question becomes a mistake, i.e. ammo in the cop's deck.
   The cop's cards are your old mistakes, the shakiest first: right = blocked, wrong = you take as many HP as you had
   mistakes on that question before (1 to COP_MAX_HIT).
   A card leaves his deck once its last answer is right and it is right at least 80% of the time.
   Answers go through the usual schedule: your cards are graded like "Учить", the cop's like a test. */
const BATTLE_HP = 15;
const COP_MAX_HIT = 3;
const COP_NAME = 'Офицер Кактус';

/* what a wrong answer on a cop card costs: the earlier mistakes on that question, at least 1 and at most COP_MAX_HIT */
const copHit = wrongBefore => Math.min(COP_MAX_HIT, Math.max(1, wrongBefore));
const wrongOf = id => { const x = st(id); return x ? x.n - x.c : 0; };

/* the cop's deck: questions you got wrong that are still shaky, the shakiest first */
function copDeck() {
  return QS.filter(q => { const x = st(q.id); return x && x.n > x.c && (x.last === 0 || x.c < 0.8 * x.n); })
    .sort((a, b) => {
      const x = st(a.id), y = st(b.id);
      return (x.last === 0 ? 0 : 1) - (y.last === 0 ? 0 : 1) || x.c / x.n - y.c / y.n;
    })
    .map(q => q.id);
}
/* 0 (sure to be remembered) .. 1 (likely wrong) */
function hardness(id, now) {
  const c = state.srs.cards[id], x = st(id);
  let v = 0.5;
  if (c && c.st !== R.NEW && c.s) v = 0.6 * (1 - R.retrievability(R.dayOf(now) - R.dayOf(c.last), c.s)) + 0.4 * (c.d - 1) / 9;
  else if (x && x.n) v = 1 - 0.8 * x.c / x.n;
  return Math.min(1, Math.max(0, v));
}
const hardestOf = (ids, now) => {
  const top = ids.slice().sort((a, b) => hardness(b, now) - hardness(a, now)).slice(0, 8);
  return top[Math.floor(Math.random() * top.length)];
};
const ordFor = id => (state.settings.shuffle && !BY_ID.get(id).fx ? shuffled([0, 1, 2]) : [0, 1, 2]);

function drawMine(played, now) {
  let left = ALL_IDS.filter(id => !played.has(id));
  if (!left.length) left = ALL_IDS.slice();
  const q = R.queue(newOrder(), state.srs.cards, srsToday(now), now, state.srs.cfg, new Set(left));
  const id = q.next || q.learnFirst;
  if (id) {
    const c = state.srs.cards[id];
    return { id, ord: ordFor(id), by: 'me', src: !c || c.st === R.NEW ? 'new' : c.st === R.REVIEW ? 'review' : 'learn' };
  }
  /* nothing to learn right now: the hardest of what you have studied (or anything) */
  const studied = left.filter(x => state.srs.cards[x] && state.srs.cards[x].st !== R.NEW);
  const pick = hardestOf(studied.length ? studied : left, now);
  return { id: pick, ord: ordFor(pick), by: 'me', src: 'extra' };
}
function drawCop(played, current, now) {
  const deck = copDeck().filter(id => !played.has(id));
  if (deck.length) {
    const top = deck.slice(0, 5), pick = top[Math.floor(Math.random() * top.length)];
    return { id: pick, ord: ordFor(pick), by: 'cop', src: 'deck' };
  }
  /* his deck is empty: he throws the hardest questions instead */
  let pool = ALL_IDS.filter(id => !played.has(id) && id !== current);
  if (!pool.length) pool = ALL_IDS.filter(id => id !== current);
  const pick = hardestOf(pool, now);
  return { id: pick, ord: ordFor(pick), by: 'cop', src: 'hard' };
}
function battleStart() {
  const now = Date.now();
  state.battle = { startedAt: now, me: BATTLE_HP, cop: BATTLE_HP, card: drawMine(new Set(), now), log: [], endedAt: null, gaveUp: false };
  save();
  go('battle');
}
function tally(won) {
  const s = state.battles;
  if (won) { s.wins++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak); } else { s.losses++; s.streak = 0; }
}
function battleAnswer(q, orig) {
  const b = state.battle, card = b && b.card;
  if (!card || b.endedAt || card.ans !== undefined || card.id !== q.id) return;
  const ok = orig === q.a;
  const dmg = card.by === 'cop' && !ok ? copHit(wrongOf(q.id)) : 1;   // before this answer is recorded
  record(q.id, ok);
  srsSchedule(q.id, ok ? R.GOOD : R.AGAIN, !(card.by === 'me' && card.src !== 'extra'));
  card.ans = orig;
  if (card.by === 'cop' && !ok) b.me = Math.max(0, b.me - dmg);
  if (card.by === 'me' && ok) b.cop--;
  b.log.push({ id: q.id, by: card.by, ok, dmg });
  if (b.me <= 0 || b.cop <= 0) { b.endedAt = Date.now(); tally(b.cop <= 0); }
  save();
  render({ keepScroll: true });
}
function battleNext() {
  const b = state.battle, card = b && b.card;
  if (!card || b.endedAt || card.ans === undefined) return;
  const played = new Set(b.log.map(t => t.id)), now = Date.now();
  b.card = card.by === 'me' ? drawCop(played, card.id, now) : drawMine(played, now);
  save();
  render();
}
function battleGiveUp() {
  const b = state.battle;
  if (!b || b.endedAt || !window.confirm('Сдаться? Бой засчитается как поражение.')) return;
  b.endedAt = Date.now();
  b.gaveUp = true;
  b.card = null;
  tally(false);
  save();
  render();
}

/* ---------- routing ---------- */
function go(route) {
  const target = `#/${route}`;
  if (location.hash === target) render();
  else location.hash = target;
}
let waitTimer = null;
function render(opts = {}) {
  const [route, arg] = location.hash.replace(/^#\/?/, '').split('/');
  clearTimeout(waitTimer);
  $app.replaceChildren();
  if (!opts.keepScroll) window.scrollTo(0, 0);
  if (route === 'run') $app.append(viewRun());
  else if (route === 'srs') $app.append(viewSrs());
  else if (route === 'learn') $app.append(viewLearn(SEC.has(arg) ? arg : null));
  else if (route === 'result') $app.append(viewResult());
  else if (route === 'stats') $app.append(viewStats());
  else if (route === 'battle') $app.append(viewBattle());
  else $app.append(viewHome());
}

/* ---------- views ---------- */
function topbar(title, extra) {
  return h('div', { class: 'top' },
    h('button', { class: 'btn ghost', type: 'button', onclick: () => go('') }, '← Главная'),
    h('div', { class: 'title' }, title),
    extra);
}

function streakText(s) {
  const rec = s.best > s.cur ? ` · рекорд ${daysWord(s.best)}` : '';
  if (s.done) return `сегодня уже засчитан${rec}`;
  if (s.cur) return `сегодня ещё не засчитан: ответь на любой вопрос, чтобы не потерять серию${rec}`;
  return (s.best ? 'ответь на любой вопрос, чтобы начать новую серию' : 'ответь на любой вопрос, чтобы начать серию') + rec;
}
function streakCard() {
  const s = streakNow();
  return h('div', { class: `card streak ${s.done ? '' : 'idle'}` },
    sprite(FLAME_SPRITE, FLAME_PAL, 'flame'),
    h('div', null,
      h('strong', null, `Серия: ${daysWord(s.cur)}`),
      h('div', { class: 'muted small' }, streakText(s))));
}

function viewHome() {
  const S = state.session;
  const sq = srsQueue();
  const ex = R.examInfo(state.srs.cfg, R.dayOf(Date.now()));
  const due = sq.counts.new + sq.counts.learn + sq.counts.review;
  const studied = QS.length - srsDeckStats().new;
  const nextSec = sq.firstNew && BY_ID.get(sq.firstNew).s;
  const root = h('div', null,
    h('header', { class: 'hero' },
      h('h1', null, 'Arizona MVD — тренажёр экзамена'),
      h('p', { class: 'muted' }, `${QS.length} ${plural(QS.length, ['вопрос', 'вопроса', 'вопросов'])}: официальные тесты ADOT + вопросы по мануалу (ред. 09/26). `
        + `На настоящем экзамене ${EXAM_SIZE} вопросов, нужно ${PASS_PCT}%.`)),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', null, `${studied}/${QS.length}`), h('span', null, 'изучено')),
      h('div', { class: 'stat' }, h('b', null, sq.counts.learn + sq.counts.review), h('span', null, 'повторить сегодня')),
      h('button', { class: 'stat', type: 'button', onclick: () => go('srs') },
        h('b', null, ex ? (ex.left ? daysWord(ex.left) : 'сегодня') : '—'), h('span', null, ex ? 'до экзамена' : 'нет даты экзамена'))),
    streakCard(),
    badgeStrip(),
    ...badgeRails());

  if (S && !S.finished) {
    root.append(h('div', { class: 'card banner' },
      h('strong', null, `Продолжить: ${S.title}`),
      h('p', { class: 'muted' }, `вопрос ${S.idx + 1} из ${S.ids.length}`),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => go('run') }, 'Продолжить'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.session = null; save(); render(); } }, 'Отменить'))));
  }

  root.append(h('div', { class: 'actions' },
    h('button', { class: 'action primary wide', type: 'button', onclick: () => go('learn') },
      h('strong', null, 'Учить'),
      h('span', null, due ? `новых ${sq.counts.new} · изучаются ${sq.counts.learn} · повторить ${sq.counts.review}` : 'на сегодня всё сделано'),
      sq.counts.new > 0 && h('span', { class: 'sub' }, `новые из раздела «${SEC.get(nextSec).name}»`)),
    h('button', { class: 'action wide', type: 'button', onclick: startExam },
      h('strong', null, `Пробный экзамен: ${EXAM_SIZE} вопросов`),
      h('span', null, `как настоящий: ответы и разбор только в конце, проходной балл ${PASS_PCT}% (${Math.ceil(EXAM_SIZE * PASS_PCT / 100)} из ${EXAM_SIZE})`)),
    h('button', { class: 'action wide', type: 'button', onclick: () => go('battle') },
      h('strong', null, 'Бой с копом'),
      h('span', null, battleTileSub()))),
    h('p', { class: 'muted small', style: 'margin-top:10px' },
      'Новые вопросы приходят только через «Учить»: по разделам, в порядке мануала. «Учить» у раздела берёт новые из него, '
      + 'и общая «Учить» дальше продолжает этот раздел. Экзамен и тесты — проверка: они двигают расписание того, что вы уже учите, '
      + 'а ошибки сразу отправляют в «Учить». ',
      h('a', { href: '#/srs' }, 'Дата экзамена и настройки')));

  const off = [1, 2, 3].map(t => {
    const n = QS.filter(q => q.src === 'o' && q.t === t).length;
    return h('button', { class: 'btn', type: 'button', onclick: () => startOfficial(t) }, `Тест ${t} (${n})`);
  });
  root.append(
    h('h2', null, 'Официальные тесты ADOT'),
    h('div', { class: 'row' }, off),
    h('p', { class: 'muted small', style: 'margin-top:8px' }, 'Те же вопросы и картинки, что на сайте ADOT, в исходном порядке.'),
    h('h2', null, 'Разделы'),
    ...SECS.map(s => viewSectionCard(s, s.id === nextSec)));

  root.append(h('div', { class: 'row', style: 'margin-top:22px' },
    h('button', { class: 'btn', type: 'button', onclick: () => go('stats') }, 'Статистика и настройки'),
    h('a', { class: 'btn', href: MANUAL, target: '_blank', rel: 'noopener' }, 'Открыть мануал (PDF)')));
  return root;
}

function viewSectionCard(s, isNext) {
  const qs = SEC_Q.get(s.id);
  const k = q => state.srs.cards[q.id];
  const learned = qs.filter(q => k(q) && k(q).st === R.REVIEW).length;
  const learning = qs.filter(q => k(q) && (k(q).st === R.LEARN || k(q).st === R.RELEARN)).length;
  const fresh = qs.length - learned - learning;
  const c = srsQueue(Date.now(), s.id).counts;
  return h('div', { class: 'sec' },
    h('div', { class: 'name' }, s.name, isNext && h('span', { class: 'chip' }, 'новые отсюда')),
    h('div', { class: 'meta' },
      `мануал, стр. ${s.pages[0]}${s.pages[1] !== s.pages[0] ? '–' + s.pages[1] : ''} · ${qs.length} ${plural(qs.length, ['вопрос', 'вопроса', 'вопросов'])}`
      + (s.official ? ` (официальных: ${s.official})` : '') + ` · новых ${fresh}` + (c.learn + c.review ? ` · повторить ${c.learn + c.review}` : '')),
    h('div', { class: 'bar', title: `выучено ${learned} · изучаются ${learning} · новых ${fresh}` },
      h('i', { class: 'g', style: `width:${pct(learned, qs.length)}%` }),
      h('i', { class: 'y', style: `width:${pct(learning, qs.length)}%` })),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => openLearn(s.id) }, 'Учить'),
      h('button', { class: 'btn', type: 'button', onclick: () => startSection(s.id) }, 'Тест')));
}

function questionBlock(q, S, showFb, onPick = choose) {
  const order = S.ord[q.id];
  const chosen = S.ans[q.id];
  const reveal = showFb && chosen !== undefined;
  const block = h('div', null,
    h('div', { class: 'chips' },
      S.mode !== 'exam' && S.mode !== 'practice' && h('span', { class: 'chip' }, SEC.get(q.s).name),
      h('span', { class: 'chip off' }, q.src === 'o' ? 'официальный ADOT' : 'по мануалу')),
    h('p', { class: 'stem' }, q.q),
    q.i && h('img', { class: 'qimg', src: q.i, alt: 'Иллюстрация к вопросу' }),
    order.map((orig, pos) => {
      const cls = ['opt'];
      if (S.deferred && chosen === orig) cls.push('picked');
      if (reveal) {
        cls.push('locked');
        if (orig === q.a) cls.push('right');
        else if (chosen === orig) cls.push('wrong');
      }
      return h('button', { class: cls.join(' '), type: 'button', disabled: reveal ? true : null, onclick: () => onPick(q, orig) },
        h('span', { class: 'ltr' }, LETTERS[pos]),
        h('span', { class: 'txt' }, q.o[orig]));
    }));
  if (reveal) {
    const ok = chosen === q.a;
    block.append(h('div', { class: `fb ${ok ? 'good' : 'bad'}`, 'aria-live': 'polite' },
      h('strong', null, ok ? 'Верно' : 'Неверно'),
      !ok && h('div', null, 'Правильный ответ: ', h('b', null, q.o[q.a])),
      q.x && h('p', { style: 'margin:6px 0 0' }, q.x),
      h('div', { class: 'src' }, srcLabel(q), ' · ', manualLink(q.p))));
  }
  return block;
}

function viewRun() {
  const S = state.session;
  if (!S) { location.replace('#/'); return h('div'); }
  if (S.finished) { location.replace('#/result'); return h('div'); }
  const q = BY_ID.get(S.ids[S.idx]);
  const answered = S.ans[q.id] !== undefined;
  const last = S.idx === S.ids.length - 1;
  const root = h('div', null,
    topbar(S.title, h('span', { class: 'muted small' }, `${S.idx + 1}/${S.ids.length}`)),
    h('div', { class: 'progress' }, h('i', { style: `width:${pct(S.idx + (answered && !S.deferred ? 1 : 0), S.ids.length)}%` })),
    h('div', { class: 'card' }, questionBlock(q, S, !S.deferred)));

  if (S.deferred) {
    root.append(
      h('div', { class: 'nav', 'aria-label': 'Навигация по вопросам' },
        S.ids.map((id, i) => h('button', {
          type: 'button', class: `${S.ans[id] !== undefined ? 'done' : ''} ${i === S.idx ? 'cur' : ''}`,
          'aria-label': `Вопрос ${i + 1}`, onclick: () => jump(i),
        }, i + 1))),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn', type: 'button', disabled: S.idx === 0 ? true : null, onclick: () => step(-1) }, '← Назад'),
        h('button', { class: 'btn', type: 'button', disabled: last ? true : null, onclick: () => step(1) }, 'Далее →'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn primary', type: 'button', onclick: confirmFinish }, 'Завершить')));
  } else {
    root.append(h('div', { class: 'row end', style: 'margin-top:14px' },
      h('button', { class: 'btn ghost', type: 'button', onclick: confirmFinish }, 'Завершить'),
      h('button', { class: 'btn primary', type: 'button', disabled: answered ? null : true, onclick: () => step(1) },
        last ? 'Результат' : 'Далее →')));
  }
  return root;
}

function confirmFinish() {
  const S = state.session;
  const left = S.ids.length - Object.keys(S.ans).length;
  if (S.deferred && left > 0 && !window.confirm(`Без ответа осталось: ${left}. Завершить?`)) return;
  finish();
}

function viewResult() {
  const S = state.session;
  if (!S || !S.finished) { location.replace('#/'); return h('div'); }
  const r = S.result || computeResult(S);
  const wrong = S.ids.map(id => BY_ID.get(id)).filter(q => S.ans[q.id] !== q.a);
  const mins = Math.max(1, Math.round(((S.endedAt || Date.now()) - S.startedAt) / 60000));
  const exam = S.deferred;
  const root = h('div', null,
    topbar(S.title),
    h('div', { class: 'card' },
      h('div', { class: 'score' }, `${r.correct} / ${r.total}`),
      h('p', { class: 'muted' }, `${pct(r.correct, r.total)}% · ${mins} мин`),
      exam && h('span', { class: `badge ${r.passed ? 'ok' : 'no'}` },
        r.passed ? 'Сдано' : `Не сдано: нужно ${r.need} из ${r.total} (${S.passPct}%)`),
      h('p', { style: 'margin-top:8px' }, wrong.length ? `Ошибок: ${wrong.length}. Они уже в «Учить» и вернутся через несколько минут.` : 'Без ошибок.')),
    h('div', { class: 'row', style: 'margin:14px 0' },
      wrong.length > 0 && h('button', { class: 'btn primary', type: 'button', onclick: () => go('learn') }, 'Учить'),
      S.mode === 'exam' && h('button', { class: 'btn', type: 'button', onclick: startExam }, 'Новый экзамен'),
      S.mode === 'practice' && S.sec && h('button', { class: 'btn', type: 'button', onclick: () => startSection(S.sec) }, 'Ещё вопросы раздела'),
      h('button', { class: 'btn', type: 'button', onclick: () => go('') }, 'На главную')));

  if (wrong.length) {
    root.append(h('h2', null, exam ? 'Разбор ошибок' : 'Ошибки'));
    const card = h('div', { class: 'card' });
    wrong.forEach((q, i) => {
      const mine = S.ans[q.id];
      card.append(h('div', { class: i ? 'miss' : '' },
        h('div', { class: 'chips' }, h('span', { class: 'chip' }, SEC.get(q.s).name)),
        h('p', { class: 'stem' }, q.q),
        q.i && h('img', { class: 'qimg', src: q.i, alt: 'Иллюстрация к вопросу' }),
        mine !== undefined ? h('div', { class: 'ans w' }, 'Ваш ответ: ', q.o[mine]) : h('div', { class: 'ans w' }, 'Без ответа'),
        h('div', { class: 'ans r' }, 'Правильно: ', h('b', null, q.o[q.a])),
        q.x && h('p', { class: 'small', style: 'margin:6px 0 0' }, q.x),
        h('div', { class: 'small muted' }, srcLabel(q), ' · ', manualLink(q.p))));
    });
    root.append(card);
  }
  return root;
}

function srsCounts(c, active) {
  return h('span', { class: 'srs-mini', 'aria-label': `новые ${c.new}, изучаются ${c.learn}, повторить ${c.review}` },
    h('b', { class: `cn ${active === 'new' ? 'on' : ''}` }, c.new),
    h('b', { class: `cl ${active === 'learn' ? 'on' : ''}` }, c.learn),
    h('b', { class: `cr ${active === 'review' ? 'on' : ''}` }, c.review));
}

function viewSrs() {
  const X = state.srs;
  const cfg = X.cfg;
  const now = Date.now();
  const today = R.dayOf(now);
  const sq = srsQueue(now);
  const ex = R.examInfo(cfg, today);
  const examPassed = cfg.examDate && !ex;
  const deck = srsDeckStats();
  const setCfg = (k, v) => { cfg[k] = v; X.cur = null; save(); render({ keepScroll: true }); };
  const due = sq.counts.new + sq.counts.learn + sq.counts.review;

  const big = (cls, n, label) => h('div', { class: `srs-big ${cls}` }, h('b', null, n), h('span', null, label));
  const root = h('div', null,
    topbar('Интервальные повторения'),
    h('div', { class: 'card' },
      h('div', { class: 'srs-counts' },
        big('cn', sq.counts.new, 'новые'), big('cl', sq.counts.learn, 'изучаются'), big('cr', sq.counts.review, 'повторить')),
      due
        ? h('button', { class: 'btn primary block', type: 'button', onclick: () => go('learn') }, 'Учить')
        : h('div', null,
          h('p', null, sq.learnLater
            ? `На сейчас всё. Следующий вопрос из изучаемых — через ${fmtIvl({ mins: Math.max(1, Math.round((sq.learnLater - now) / 60000)) })}.`
            : 'На сегодня всё сделано.'),
          h('div', { class: 'row' },
            sq.learnLater && h('button', { class: 'btn', type: 'button', onclick: () => { srsShowAhead(); go('learn'); } }, 'Показать сейчас'),
            sq.newTotalLeft > 0 && h('button', { class: 'btn', type: 'button', onclick: () => srsMoreNew(10) }, 'Ещё 10 новых сегодня')))));

  /* exam date */
  const examCard = h('div', { class: 'card' },
    h('label', { class: 'field' },
      h('span', null, 'Дата экзамена'),
      h('span', { class: 'row' },
        h('input', {
          type: 'date', value: cfg.examDate || '', min: R.dayToIso(today),
          onchange: e => setCfg('examDate', e.target.value),
        }),
        cfg.examDate && h('button', { class: 'btn ghost', type: 'button', onclick: () => setCfg('examDate', '') }, 'Убрать'))));
  if (ex) {
    const studied = ALL_IDS.map(id => R.recallOn(X.cards[id], ex.day)).filter(r => r !== null);
    const avg = studied.length ? studied.reduce((a, b) => a + b, 0) / studied.length : 0;
    const finishDay = today + Math.max(0, Math.ceil(sq.newTotalLeft / Math.max(1, sq.newLimit)) - 1);
    examCard.append(
      h('p', { class: 'exam-left' }, ex.left ? `До экзамена ${daysWord(ex.left)} (${fmtDay(ex.day)})` : 'Экзамен сегодня. Удачи!'),
      h('ul', { class: 'facts' },
        h('li', null, `Новых в день: `, h('b', null, sq.newLimit),
          sq.newTotalLeft ? ` — все ${sq.newTotalLeft} новых вопросов будут пройдены к ${fmtDay(finishDay)}` : ' — все вопросы уже начаты'),
        h('li', null, `Повторы ставятся так, чтобы к экзамену вероятность вспомнить каждый вопрос была не ниже `,
          h('b', null, `${Math.round(cfg.examRetention * 100)}%`)),
        studied.length > 0 && h('li', null, `Если больше не заниматься, на дату экзамена вы вспомните в среднем `,
          h('b', null, `${Math.round(avg * 100)}%`), ` из ${studied.length} изученных вопросов`)));
  } else {
    examCard.append(h('p', { class: 'muted small', style: 'margin-top:10px' }, examPassed
      ? 'Дата экзамена прошла — расписание снова обычное. Поставьте новую дату, если пересдаёте.'
      : 'С датой экзамена приложение само рассчитает, сколько новых вопросов давать в день, чтобы успеть всё, и не отложит повтор на после экзамена, если к нему вопрос успеет забыться.'));
  }
  root.append(h('h2', null, 'Экзамен'), examCard);

  /* forecast */
  const n = ex ? Math.min(30, Math.max(7, ex.left + 1)) : 14;
  const fc = R.forecast(ALL_IDS, X.cards, now, n);
  const top = Math.max(1, ...fc);
  root.append(h('h2', null, 'Прогноз повторов'),
    h('div', { class: 'card' },
      h('div', { class: 'fc', role: 'img', 'aria-label': `Повторов по дням: ${fc.join(', ')}` },
        fc.map((v, i) => h('div', { class: `fc-col ${ex && i === ex.left ? 'exam' : ''}`, title: `${fmtDay(today + i)}: ${v}` },
          h('span', { class: 'fc-v' }, v || ''),
          h('i', { style: `height:${Math.round((v / top) * 100)}%` }),
          h('span', { class: 'fc-d' }, i === 0 ? 'сег' : new Date((today + i) * 864e5).getUTCDate())))),
      h('p', { class: 'muted small', style: 'margin:10px 0 0' },
        `Новые: ${deck.new} · изучаются: ${deck.learn} · молодые: ${deck.young} · зрелые (интервал от 21 дня): ${deck.mature}`
        + (ex ? ' · рамкой отмечен день экзамена' : ''))));

  /* settings */
  const num = (k, label, min, max, hint, disabled) => h('label', { class: 'field' },
    h('span', null, label),
    h('input', {
      type: 'number', min, max, value: cfg[k], disabled: disabled ? true : null, inputmode: 'numeric',
      onchange: e => { const v = Math.round(Number(e.target.value)); if (v >= min && v <= max) setCfg(k, v); else render({ keepScroll: true }); },
    }),
    hint && h('small', { class: 'muted' }, hint));
  const sel = (k, label, values, hint) => h('label', { class: 'field' },
    h('span', null, label),
    h('select', { onchange: e => setCfg(k, Number(e.target.value)) },
      values.map(v => h('option', { value: v, selected: Math.abs(cfg[k] - v) < 1e-9 ? true : null }, `${Math.round(v * 100)}%`))),
    hint && h('small', { class: 'muted' }, hint));
  root.append(h('h2', null, 'Настройки'),
    h('div', { class: 'card fields' },
      num('newPerDay', 'Новых вопросов в день', 0, 999, ex ? 'Пока стоит дата экзамена, считается автоматически' : 'По умолчанию 50', !!ex),
      num('maxReviews', 'Максимум повторов в день', 1, 9999),
      sel('retention', 'Желаемая запоминаемость', [0.8, 0.85, 0.9, 0.93, 0.95, 0.97],
        'Вероятность вспомнить вопрос в момент повтора. Выше значит чаще повторы. В Anki по умолчанию 90%'),
      ex && sel('examRetention', 'Запоминаемость к экзамену', [0.9, 0.93, 0.95, 0.97, 0.99],
        'Какую вероятность вспомнить нужно удержать до дня экзамена')),
    h('details', { class: 'card how' },
      h('summary', null, 'Как работает алгоритм'),
      h('p', null, 'Это FSRS-6 — алгоритм, встроенный в Anki с версии 23.10. Для каждого вопроса хранятся две величины: ',
        h('b', null, 'стабильность S'), ' (через сколько дней вероятность вспомнить упадёт до 90%) и ',
        h('b', null, 'сложность D'), ' (от 1 до 10).'),
      h('p', null, 'Вероятность вспомнить через t дней: R = (1 + 0,98·t/S)^−0,154. Следующий повтор ставится на день, когда R упадёт до желаемой запоминаемости. При 90% интервал равен S.'),
      h('p', null, 'После верного ответа S растёт: тем сильнее, чем легче вопрос, чем меньше было S и чем сильнее вы успели забыть (то есть чем ниже было R). После ошибки S падает, а вопрос уходит на переучивание.'),
      h('p', null, 'Новые вопросы идут по разделам в порядке мануала, внутри раздела — по страницам. «Учить» у раздела берёт новые только из него и делает его текущим: общая «Учить» продолжит с него, а потом пойдёт по порядку. Лимит новых в день общий.'),
      h('p', null, 'Новый вопрос проходит шаги 1 мин → 10 мин внутри сессии, потом получает интервал в днях. После верного ответа можно выбрать «Снова» (если угадали), «Трудно», «Хорошо» (Enter) или «Легко» — с клавиатуры это 1, 2, 3, 4.'),
      h('p', null, 'Экзамен и тесты новые вопросы в расписание не добавляют. Ответ на уже изучаемый вопрос засчитывается как «Хорошо» или «Снова», а ошибка в новом вопросе сразу отправляет его на изучение (вне дневного лимита).'),
      h('p', null, 'Новый день начинается в 4:00, как в Anki. Интервалы от 3 дней слегка случайно сдвигаются (fuzz), чтобы повторы не скапливались в один день.')),
    h('div', { class: 'row', style: 'margin-top:16px' },
      h('button', {
        class: 'btn danger', type: 'button',
        onclick: () => { if (window.confirm('Сбросить расписание повторений? Статистика ответов останется.')) { const c = cfg; state.srs = freshSrs(); state.srs.cfg = c; state.srs.resetAt = Date.now(); save(); render(); } },
      }, 'Сбросить расписание')));
  return root;
}

/* sec: learn one section (its due cards and its new questions), null = everything */
function viewLearn(sec = null) {
  const now = Date.now();
  const cur = srsCurrent(now, sec);
  const sq = srsQueue(now, sec);
  const title = sec ? SEC.get(sec).name : 'Повторение';
  if (!cur) {
    if (sq.learnLater) waitTimer = setTimeout(() => render(), Math.max(1000, sq.learnLater - R.LEARN_AHEAD - now + 500));
    const limitHit = sq.newHere > 0 && sq.counts.new === 0;
    return h('div', null,
      topbar(title, srsCounts(sq.counts)),
      h('div', { class: 'card' },
        h('div', { class: 'score' }, sq.learnLater ? 'Пауза' : 'Готово'),
        h('p', null, sq.learnLater
          ? `Следующий вопрос из изучаемых будет через ${fmtIvl({ mins: Math.max(1, Math.round((sq.learnLater - now) / 60000)) })}. Экран обновится сам.`
          : limitHit ? `Лимит новых на сегодня (${sq.newLimit}) пройден, повторов больше нет.`
            : sec ? 'В этом разделе на сегодня всё: новых вопросов не осталось, повторы сделаны.'
              : 'На сегодня всё. Возвращайтесь завтра.'),
        h('div', { class: 'row' },
          sq.learnLater && h('button', { class: 'btn primary', type: 'button', onclick: () => srsShowAhead(sec) }, 'Показать сейчас'),
          sq.newHere > 0 && h('button', { class: 'btn', type: 'button', onclick: () => srsMoreNew(10, sec) }, 'Ещё 10 новых'),
          sec && h('button', { class: 'btn', type: 'button', onclick: () => startSection(sec) }, 'Тест по разделу'),
          h('button', { class: 'btn', type: 'button', onclick: () => go('srs') }, 'К расписанию'))));
  }
  const q = BY_ID.get(cur.id);
  const card = state.srs.cards[q.id];
  const kind = !card || card.st === R.NEW ? 'new' : card.st === R.REVIEW ? 'review' : 'learn';
  const answered = cur.ans !== undefined;
  const S = { mode: 'srs', deferred: false, ord: { [q.id]: cur.ord }, ans: answered ? { [q.id]: cur.ans } : {} };
  const root = h('div', null,
    topbar(title, srsCounts(sq.counts, kind)),
    h('div', { class: 'card' }, questionBlock(q, S, true, srsPick)));
  if (answered) {
    const ok = cur.ans === q.a;
    const pv = R.preview(card || {}, now, state.srs.cfg, q.id);
    if (!ok) {
      root.append(h('div', { class: 'row end', style: 'margin-top:14px' },
        h('span', { class: 'muted small grow' }, `Вопрос вернётся через ${fmtIvl(pv[R.AGAIN])}`),
        h('button', { class: 'btn primary', type: 'button', onclick: () => srsRate(R.AGAIN) }, 'Далее →')));
    } else {
      const g = (grade, key, label, cls) => h('button', { class: `grade ${cls}`, type: 'button', onclick: () => srsRate(grade) },
        h('small', null, fmtIvl(pv[grade])), h('span', null, label), h('kbd', null, key));
      root.append(
        h('p', { class: 'muted small', style: 'margin:14px 0 8px' }, 'Насколько уверенно ответили?'),
        h('div', { class: 'grades' },
          g(R.AGAIN, '1', 'Угадал', 'again'), g(R.HARD, '2', 'Трудно', 'hard'), g(R.GOOD, '3', 'Хорошо', 'good'), g(R.EASY, '4', 'Легко', 'easy')));
    }
  }
  return root;
}

/* ---------- card battle views ---------- */
const COP_SPRITE = [
  '....KKKKKKKK....', '...KHHHHHHHHK...', '..KHHHHBBHHHHK..', '.KKKKKKKKKKKKKK.', '...KSSSSSSSSK...', '...KGGGSSGGGK...',
  '...KSSSSSSSSK...', '...KSSSKKSSSK...', '....KSSSSSSK....', '...KKKKSSKKKK...', '..KUUUUKKUUUUK..', '.KUUBUUKKUUUUUK.',
  '.KUUUUUKKUUUUUK.', '.KSKUUUUUUUUKSK.', '..KKKKKKKKKKKK..', '...KDDDKKDDDK...', '...KDDDK.KDDDK..', '..KKKKKK.KKKKKK.',
];
const ME_SPRITE = [
  '................', '.....KKKKKK.....', '....KRRRRRRK....', '...KRRRRRRRRRRK.', '....KSSSSSSK....', '....KSKSSKSK....',
  '....KSSSSSSK....', '....KSSKKSSK....', '.....KSSSSK.....', '....KKKKKKKK....', '...KBBBBBBBBK...', '..KBBBWWWWBBBK..',
  '..KBBBWLLWBBBK..', '..KSBBWWWWBBSK..', '...KKKKKKKKKK...', '....KDDKKDDK....', '....KDDK.KDDK...', '...KKKKK.KKKKK..',
];
const COP_PAL = { K: '#1b1b1b', H: '#23324f', B: '#e0b23a', S: '#e7b48a', G: '#101010', U: '#c9a66b', D: '#4a3a28' };
const ME_PAL = { K: '#1b1b1b', R: '#d9443b', S: '#e7b48a', B: '#3a6fd9', W: '#ffffff', L: '#d9443b', D: '#2d3f66' };
const FLAME_SPRITE = [
  '...R....', '...RR...', '..RRR..R', '..RROR.R', '.RRROORR', '.RROOORR',
  'RROOYOOR', 'RROYYYOR', 'RROYYYOR', '.RROYORR', '..RRRRR.',
];
const FLAME_PAL = { R: '#d9443b', O: '#f08a24', Y: '#ffd23f' };

function sprite(rows, pal, cls = '') {
  const c = h('canvas', { class: `sprite ${cls}`, width: rows[0].length, height: rows.length, 'aria-hidden': 'true' });
  const g = c.getContext && c.getContext('2d');
  if (g) rows.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1); } }));
  return c;
}
const deckWord = n => `${n} ${plural(n, ['карта', 'карты', 'карт'])}`;
function battleTileSub() {
  const b = state.battle, s = state.battles;
  if (b && !b.endedAt) return `идёт бой: ты ${b.me} HP · коп ${b.cop} HP`;
  return `коп кидается твоими ошибками (в колоде ${deckWord(copDeck().length)}), ты — тем, что учишь`
    + (s.wins + s.losses ? ` · побед ${s.wins}, поражений ${s.losses}` : '');
}
function hpBar(hp, cls) {
  return h('div', { class: 'hp', role: 'img', 'aria-label': `${Math.max(0, hp)} из ${BATTLE_HP} HP` },
    h('div', { class: `pips ${cls}` }, Array.from({ length: BATTLE_HP }, (_, i) => h('i', { class: i < hp ? 'on' : '' }))),
    h('small', { class: 'muted' }, `${Math.max(0, hp)} / ${BATTLE_HP} HP`));
}

/* the last turn is animated once, when its answer is given (not when the screen is reopened) */
let battleSeen = { startedAt: null, n: 0 };
function arena(b) {
  const fresh = battleSeen.startedAt !== b.startedAt;
  const animate = !fresh && b.log.length > battleSeen.n;
  battleSeen = { startedAt: b.startedAt, n: b.log.length };
  const copTurn = b.card && b.card.by === 'cop' && b.card.ans === undefined;
  const meSprite = sprite(ME_SPRITE, ME_PAL, 'bob');
  const copSprite = sprite(COP_SPRITE, COP_PAL, copTurn ? 'bob big' : 'bob');
  const box = h('div', { class: 'card arena' },
    h('div', { class: 'fighter' }, meSprite, h('b', null, 'Ты'), hpBar(b.me, 'me')),
    h('div', { class: 'fighter' }, copSprite, h('b', null, COP_NAME), hpBar(b.cop, 'cop')));
  if (animate) {
    const t = b.log[b.log.length - 1];
    const hit = (t.by === 'me' && t.ok) || (t.by === 'cop' && !t.ok);
    const from = t.by === 'me' ? 25 : 75, to = 100 - from, reach = hit ? to : from + (to - from) * 0.55;
    const fly = h('div', { class: `fly ${t.by}` });
    const pop = h('div', { class: `pop ${hit ? 'hit' : ''}`, style: `left:${hit ? to : 50}%` }, hit ? `−${t.dmg || 1}` : t.by === 'me' ? 'мимо' : 'блок');
    box.append(fly, pop);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      if (!fly.animate || reduce) { fly.remove(); pop.classList.add('show'); return; }
      const spin = t.by === 'me' ? 1 : -1;
      const anim = fly.animate([
        { left: `${from}%`, top: '34%', transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
        { left: `${(from + reach) / 2}%`, top: '8%', transform: `translate(-50%,-50%) rotate(${270 * spin}deg)`, opacity: 1 },
        { left: `${reach}%`, top: '34%', transform: `translate(-50%,-50%) rotate(${540 * spin}deg)`, opacity: hit ? 1 : 0 },
      ], { duration: 560, easing: 'ease-out', fill: 'forwards' });
      anim.onfinish = () => {
        fly.remove();
        pop.classList.add('show');
        if (hit) (t.by === 'me' ? copSprite : meSprite).classList.add('shake');
      };
    });
  }
  return box;
}

function cardLabel(c) {
  if (c.by === 'cop') {
    const x = st(c.id);
    return c.src === 'deck' && x ? `Карта копа · ты ошибался здесь ${x.n - x.c} из ${x.n}` : 'Карта копа · трудный вопрос';
  }
  return 'Твоя карта · ' + ({ new: 'новая', review: 'повторение', learn: 'изучается' }[c.src] || 'трудная из изученных');
}

function viewBattle() {
  const b = state.battle;
  const root = h('div', null, topbar('Бой с копом',
    b && !b.endedAt && h('button', { class: 'btn ghost', type: 'button', onclick: battleGiveUp }, 'Сдаться')));
  if (!b) root.append(battleIntro());
  else if (b.endedAt) root.append(battleResult(b));
  else root.append(battleTurn(b));
  return root;
}

function battleIntro() {
  const rules = [
    `У тебя и у копа по ${BATTLE_HP} HP, ходите по очереди, начинаешь ты.`,
    'Твои карты — то, что сейчас в «Учить»: новые и повторения. Ответил верно — коп −1. Ошибся — промах, и этот вопрос уходит в колоду копа.',
    `Карты копа — твои старые ошибки, самые шаткие первыми. Ответил верно — отбил. Ошибся — теряешь столько HP, сколько раз уже ошибался в этом вопросе, но не больше ${COP_MAX_HIT}: первая ошибка в прошлом — −1, вторая — −2, третья и дальше — −${COP_MAX_HIT}.`,
    'Карта уходит из колоды копа, когда последний ответ верный и ты отвечаешь на неё правильно хотя бы в 80% случаев.',
    'Все ответы идут в обычное расписание повторений, как в «Учить» и тестах.',
  ];
  const sq = srsQueue();
  return h('div', { class: 'card' },
    h('div', { class: 'duo' }, sprite(ME_SPRITE, ME_PAL), sprite(COP_SPRITE, COP_PAL)),
    h('h2', { style: 'margin-top:14px' }, `${COP_NAME} вызывает тебя на бой`),
    h('ul', { class: 'rules' }, rules.map(r => h('li', null, r))),
    h('p', { class: 'muted small' }, `Твоих карт на сегодня: ${sq.counts.new + sq.counts.learn + sq.counts.review} · в колоде копа: ${deckWord(copDeck().length)}`),
    h('button', { class: 'btn primary block', type: 'button', onclick: battleStart }, 'В бой'));
}

function battleTurn(b) {
  const card = b.card;
  const q = BY_ID.get(card.id);
  const answered = card.ans !== undefined;
  const t = b.log[b.log.length - 1];
  let text, cls;
  if (!answered) [text, cls] = card.by === 'me' ? ['Твой ход: атакуй! Верный ответ — коп −1', 'me']
    : [`Коп кидает в тебя карточку — отбивай! Ошибёшься — минус ${copHit(wrongOf(card.id))} HP`, 'bad'];
  else if (t.by === 'me') [text, cls] = t.ok ? ['Попал! Коп −1', 'good'] : ['Промах. Этот вопрос ушёл в колоду копа', 'bad'];
  else [text, cls] = t.ok ? ['Отбил!', 'good'] : [`Пробил! Ты −${t.dmg || 1}`, 'bad'];
  const S = { mode: 'battle', deferred: false, ord: { [q.id]: card.ord }, ans: answered ? { [q.id]: card.ans } : {} };
  /* the result and the next-turn button sit above the question: no scrolling past the explanation */
  return h('div', null,
    arena(b),
    h('div', { class: `turn ${cls}`, 'aria-live': 'polite' },
      h('strong', null, text),
      answered && h('button', { class: 'btn primary', type: 'button', onclick: battleNext }, card.by === 'me' ? 'Ход копа →' : 'Мой ход →')),
    h('div', { class: `card ${card.by === 'cop' ? 'cop-card' : 'my-card'}` },
      h('div', { class: 'chips' }, h('span', { class: 'chip' }, cardLabel(card))),
      questionBlock(q, S, true, battleAnswer)));
}

function battleResult(b) {
  const log = b.log;
  const n = f => log.filter(f).length;
  const mins = Math.max(1, Math.round((b.endedAt - b.startedAt) / 60000));
  const s = state.battles;
  const wrong = [...new Set(log.filter(t => !t.ok).map(t => t.id))].map(id => BY_ID.get(id));
  const won = b.cop <= 0;
  const root = h('div', null,
    h('div', { class: 'card' },
      h('div', { class: 'duo' }, won ? sprite(ME_SPRITE, ME_PAL) : sprite(COP_SPRITE, COP_PAL)),
      h('div', { class: `score ${won ? 'win' : 'lose'}` }, won ? 'Победа!' : b.gaveUp ? 'Ты сдался' : 'Поражение'),
      h('p', { class: 'muted' }, `Ты ${Math.max(0, b.me)} HP · коп ${Math.max(0, b.cop)} HP · ${deckWord(log.length)} · ${mins} мин`),
      h('p', null, `Попаданий ${n(t => t.by === 'me' && t.ok)} · промахов ${n(t => t.by === 'me' && !t.ok)} · `
        + `отбито ${n(t => t.by === 'cop' && t.ok)} · пропущено ${n(t => t.by === 'cop' && !t.ok)}`),
      h('p', { class: 'muted small' }, `Побед ${s.wins} · поражений ${s.losses}`
        + (s.streak > 1 ? ` · серия побед ${s.streak}` : '') + (s.bestStreak > 1 ? ` · лучшая серия ${s.bestStreak}` : ''))),
    h('div', { class: 'row', style: 'margin:14px 0' },
      h('button', { class: 'btn primary', type: 'button', onclick: battleStart }, 'Реванш'),
      h('button', { class: 'btn', type: 'button', onclick: () => go('learn') }, 'Учить'),
      h('button', { class: 'btn', type: 'button', onclick: () => go('') }, 'На главную')));
  if (wrong.length) {
    const card = h('div', { class: 'card' });
    wrong.forEach((q, i) => card.append(h('div', { class: i ? 'miss' : '' },
      h('p', { class: 'stem' }, q.q),
      q.i && h('img', { class: 'qimg', src: q.i, alt: 'Иллюстрация к вопросу' }),
      h('div', { class: 'ans r' }, 'Правильно: ', h('b', null, q.o[q.a])),
      q.x && h('p', { class: 'small', style: 'margin:6px 0 0' }, q.x),
      h('div', { class: 'small muted' }, srcLabel(q), ' · ', manualLink(q.p)))));
    root.append(h('h2', null, 'Карты, на которых ты ошибся'), card);
  }
  return root;
}

function viewStats() {
  const rows = SECS.map(s => {
    const qs = SEC_Q.get(s.id);
    const seen = qs.filter(q => st(q.id));
    const good = qs.filter(q => st(q.id) && st(q.id).last === 1).length;
    const tries = seen.reduce((a, q) => a + st(q.id).n, 0);
    const right = seen.reduce((a, q) => a + st(q.id).c, 0);
    return h('tr', null,
      h('td', null, s.name),
      h('td', { class: 'num' }, `${good}/${qs.length}`),
      h('td', { class: 'num' }, tries ? `${pct(right, tries)}%` : '—'));
  });
  const sk = streakNow();
  const root = h('div', null,
    topbar('Статистика и настройки'),
    h('p', { class: 'muted', style: 'margin:0 0 12px' }, `Серия: ${daysWord(sk.cur)} · рекорд ${daysWord(Math.max(sk.best, sk.cur))}`),
    h('div', { class: 'card' },
      h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Раздел'), h('th', { class: 'num' }, 'Освоено'), h('th', { class: 'num' }, 'Точность'))),
        h('tbody', null, rows))),
    h('h2', null, 'Настройки'),
    h('div', { class: 'card' },
      h('label', { class: 'switch' },
        h('input', {
          type: 'checkbox', checked: state.settings.shuffle ? true : null,
          onchange: e => { state.settings.shuffle = e.target.checked; save(); },
        }),
        h('span', null, 'Перемешивать варианты ответов (в официальных тестах порядок всегда исходный)')),
      h('label', { class: 'switch', style: 'margin-top:12px' },
        h('input', {
          type: 'checkbox', checked: state.settings.remind ? true : null,
          onchange: e => { setRemind(e.target.checked); render({ keepScroll: true }); },
        }),
        h('span', null, 'Напоминания: до трёх в день, в случайное время с 10 до 12 и с 18 до 21. В браузере работают только пока открыта вкладка, в приложении для Android — всегда')),
      state.settings.remind && 'Notification' in window && Notification.permission === 'denied'
        && h('p', { class: 'muted small', style: 'margin:8px 0 0' }, 'Браузер запретил уведомления для этой страницы: напоминание появится плашкой внутри страницы.')));

  if (state.history.length) {
    root.append(h('h2', null, 'Последние экзамены'),
      h('div', { class: 'card' },
        h('table', null, h('tbody', null, state.history.slice().reverse().slice(0, 10).map(x =>
          h('tr', null,
            h('td', null, new Date(x.ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })),
            h('td', null, x.title),
            h('td', { class: 'num' }, `${x.correct}/${x.total}`),
            h('td', { class: 'num' }, x.passed ? 'сдано' : 'нет')))))));
  }
  root.append(h('h2', null, 'Синхронизация между устройствами'), syncCard());
  root.append(h('h2', null, 'Данные'),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn danger', type: 'button',
        onclick: () => {
          if (!window.confirm(sync.token ? 'Сбросить весь прогресс? На других устройствах с синхронизацией он тоже сбросится.' : 'Сбросить весь прогресс?')) return;
          state = fresh();
          state.resetAt = Date.now();
          save();
          render();
        },
      }, 'Сбросить прогресс')));
  return root;
}

/* ---------- keyboard ---------- */
function onKey(e) {
  if (awardEl) {   // the badge dialog is on top: it takes the keys
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); closeAward(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^#\/learn/.test(location.hash)) return onLearnKey(e);
  if (/^#\/battle/.test(location.hash)) return onBattleKey(e);
  if (!/^#\/run/.test(location.hash)) return;
  const S = state.session;
  if (!S || S.finished) return;
  const q = BY_ID.get(S.ids[S.idx]);
  const k = e.key.toLowerCase();
  const pos = '123'.includes(k) && k ? Number(k) - 1 : ['a', 'b', 'c'].indexOf(k);
  if (pos >= 0 && pos < 3 && k.length === 1) { choose(q, S.ord[q.id][pos]); return; }
  const answered = S.ans[q.id] !== undefined;
  if ((k === 'enter' || k === 'arrowright') && (S.deferred || answered)) { e.preventDefault(); step(1); }
  else if (k === 'arrowleft' && S.deferred) { e.preventDefault(); step(-1); }
}

function onLearnKey(e) {
  const cur = state.srs.cur;
  if (!cur || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const q = BY_ID.get(cur.id);
  const k = e.key.toLowerCase();
  if (cur.ans === undefined) {
    const pos = '123'.includes(k) && k ? Number(k) - 1 : ['a', 'b', 'c'].indexOf(k);
    if (pos >= 0 && pos < 3 && k.length === 1) srsPick(q, cur.ord[pos]);
  } else if (k === 'enter' || k === ' ' || k === 'arrowright') {
    e.preventDefault();
    srsRate(cur.ans === q.a ? R.GOOD : R.AGAIN);
  } else if (cur.ans === q.a && !e.repeat && '1234'.includes(k) && k.length === 1) {
    srsRate([R.AGAIN, R.HARD, R.GOOD, R.EASY][Number(k) - 1]);
  }
}

function onBattleKey(e) {
  const b = state.battle, card = b && b.card;
  if (!card || b.endedAt) return;
  const k = e.key.toLowerCase();
  if (card.ans === undefined) {
    const pos = '123'.includes(k) && k ? Number(k) - 1 : ['a', 'b', 'c'].indexOf(k);
    if (pos >= 0 && pos < 3 && k.length === 1) battleAnswer(BY_ID.get(card.id), card.ord[pos]);
  } else if (k === 'enter' || k === ' ' || k === 'arrowright') {
    e.preventDefault();
    battleNext();
  }
}

/* ---------- self-test (open index.html?selftest=1) ---------- */
function runSelfTest() {
  const out = [];
  const t = (name, ok, extra) => out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' - ' + extra : ''}`);
  const savedState = state;
  persist = false;
  state = fresh();
  try {
    t('bank loaded', QS.length === B.meta.official_total + B.meta.synth_total, `${QS.length} questions`);
    t('ids are unique', new Set(QS.map(q => q.id)).size === QS.length);
    t('3 distinct options and a valid answer index everywhere', QS.every(q => q.o.length === 3 && new Set(q.o).size === 3 && q.a >= 0 && q.a < 3));
    t('every question belongs to a known section', QS.every(q => SEC.has(q.s)));
    t('every section has at least 15 questions', SECS.every(s => SEC_Q.get(s.id).length >= 15),
      SECS.map(s => `${s.id}:${SEC_Q.get(s.id).length}`).join(' '));
    t('every question has a manual page in 1..74', QS.every(q => q.p >= 1 && q.p <= 74));
    t('30 official questions carry an image path', QS.filter(q => q.i && q.src === 'o').length === 30);
    t('sign questions written from the manual carry its sign pictures', QS.filter(q => q.i && q.src === 's').length >= 12,
      `${QS.filter(q => q.i && q.src === 's').length} with images`);
    t('official tests have 35/30/30 questions', [1, 2, 3].map(n => QS.filter(q => q.t === n).length).join('/') === '35/30/30');
    t('synthesized answer positions are balanced', (() => {
      const c = [0, 0, 0];
      QS.filter(q => q.src === 's').forEach(q => c[q.a]++);
      return Math.max(...c) - Math.min(...c) <= 12;
    })());

    const ex = buildExam();
    t('exam has 30 unique questions', ex.length === EXAM_SIZE && new Set(ex.map(q => q.id)).size === EXAM_SIZE);
    t('exam spans many sections', new Set(ex.map(q => q.s)).size >= 10, `${new Set(ex.map(q => q.s)).size} sections`);

    const S1 = makeSession('exam', 'x', ex, { deferred: true });
    ex.forEach(q => { S1.ans[q.id] = q.a; });
    const r1 = computeResult(S1);
    t('all-correct exam scores 30/30 and passes', r1.correct === 30 && r1.passed && r1.need === 24, JSON.stringify(r1));
    const S2 = makeSession('exam', 'x', ex, { deferred: true });
    ex.forEach(q => { S2.ans[q.id] = (q.a + 1) % 3; });
    t('all-wrong exam scores 0/30 and fails', computeResult(S2).correct === 0 && !computeResult(S2).passed);
    const S3 = makeSession('exam', 'x', ex, { deferred: true });
    ex.forEach((q, i) => { S3.ans[q.id] = i < 24 ? q.a : (q.a + 1) % 3; });
    t('24/30 is exactly a pass, 23/30 is not', computeResult(S3).passed && !(S3.ans[ex[0].id] = (ex[0].a + 1) % 3, computeResult(S3).passed));

    const o1 = QS.filter(q => q.src === 'o' && q.t === 1).sort((a, b) => a.n - b.n);
    const SO = makeSession('official', 'x', o1, { deferred: true, keepOrder: true });
    t('official sessions keep ADOT option order', o1.every(q => SO.ord[q.id].join() === '0,1,2'));
    t('35-question test needs 28 to pass', computeResult(SO).need === 28);

    const fixedQ = QS.filter(q => q.fx);
    t('fixed-order questions are never shuffled', fixedQ.length === 0 || fixedQ.every(q => makeSession('practice', 'x', [q]).ord[q.id].join() === '0,1,2'), `${fixedQ.length} fixed`);

    record(QS[0].id, true); record(QS[1].id, false);
    t('stats work', st(QS[0].id).last === 1 && st(QS[1].id).last === 0);
    t('pick() puts unseen questions first', pick(QS.slice(0, 5), 2).every(q => !st(q.id)));

    const SP = makeSession('practice', 'x', QS.slice(0, 5));
    const sample = QS.filter((q, i) => i % 7 === 0);
    let renderOk = true;
    for (const q of sample) {
      SP.ord[q.id] = SP.ord[q.id] || [0, 1, 2];
      for (const ans of [undefined, q.a, (q.a + 1) % 3]) {
        if (ans === undefined) delete SP.ans[q.id]; else SP.ans[q.id] = ans;
        const node = questionBlock(q, SP, true);
        if (node.querySelectorAll('button.opt').length !== 3) renderOk = false;
        if (ans !== undefined && !node.querySelector('.fb')) renderOk = false;
      }
    }
    t('question view renders in every state', renderOk, `${sample.length} questions x 3 states`);
    /* spaced repetition */
    const cfg = Object.assign({}, R.DEFAULTS);
    const T0 = Date.parse('2026-10-08T10:00:00');
    const D0 = R.dayOf(T0);
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    t('FSRS: R(S) = 90%, so at 90% retention the interval equals S', near(R.retrievability(10, 10), 0.9) && near(R.ivlFor(7.5, 0.9), 7.5));
    let c1 = R.schedule({}, R.GOOD, T0, cfg, 'a');
    t('FSRS: new card + Good -> S = w2, learning step 2 in 10 min', near(c1.s, R.W[2]) && c1.st === R.LEARN && c1.step === 1 && c1.due - T0 === 600000);
    c1 = R.schedule(c1, R.GOOD, T0 + 600000, cfg, 'a');
    t('FSRS: last learning step + Good graduates to review', c1.st === R.REVIEW && c1.ivl >= 1 && c1.day === D0 + c1.ivl, `ivl ${c1.ivl}`);
    t('FSRS: new card + Easy skips learning', R.schedule({}, R.EASY, T0, cfg, 'a').st === R.REVIEW);
    const TR = (c1.day * 864e5) + 15 * 3600e3;
    const pv = R.preview(c1, TR, cfg, 'a');
    t('FSRS: review intervals Hard < Good < Easy, Again -> minutes', pv[R.AGAIN].mins === 10 && pv[R.HARD].days < pv[R.GOOD].days && pv[R.GOOD].days < pv[R.EASY].days,
      JSON.stringify(pv));
    const c2 = R.schedule(c1, R.GOOD, TR, cfg, 'a');
    t('FSRS: successful review grows stability', c2.s > c1.s * 2 && c2.day - R.dayOf(TR) === pv[R.GOOD].days, `${c1.s.toFixed(2)} -> ${c2.s.toFixed(2)}`);
    const c3 = R.schedule(c2, R.AGAIN, (c2.day * 864e5) + 15 * 3600e3, cfg, 'a');
    t('FSRS: lapse -> relearning, lower stability, lapses+1', c3.st === R.RELEARN && c3.s < c2.s && c3.lapses === 1);
    t('FSRS: difficulty stays in 1..10', [1, 2, 3, 4].every(g => { const d = R.nextD(R.initD(g), g); return d >= 1 && d <= 10; }));

    const exCfg = Object.assign({}, cfg, { examDate: R.dayToIso(D0 + 14) });
    t('exam: 603 new over 14 days (3 spare) -> 55 a day', R.newLimit(exCfg, D0, 603, 0) === 55, String(R.newLimit(exCfg, D0, 603, 0)));
    const ex10 = Object.assign({}, cfg, { examDate: R.dayToIso(D0 + 10) });
    const shaky = { st: R.REVIEW, s: 5, d: 8, last: T0 - 864e5 * 5, day: D0, ivl: 5, reps: 3, lapses: 0 };
    const capped = R.schedule(shaky, R.GOOD, T0, ex10, 'b');
    const free = R.schedule(shaky, R.GOOD, T0, cfg, 'b');
    t('exam: a review that would fall after the exam with low recall is pulled before it',
      free.day >= D0 + 10 && R.retrievability(10, free.s) < 0.95 && capped.day < D0 + 10
      && R.retrievability(capped.ivl, capped.s) >= 0.95, `free ${free.ivl}, capped ${capped.ivl}`);
    const solid = { st: R.REVIEW, s: 400, d: 3, last: T0 - 864e5 * 300, day: D0, ivl: 300, reps: 6, lapses: 0 };
    t('exam: a card that will surely be remembered is not pulled in', R.schedule(solid, R.GOOD, T0, exCfg, 'c').day > D0 + 14);
    t('exam: a past exam date is ignored', R.examInfo({ examDate: R.dayToIso(D0 - 1) }, D0) === null);

    const today = { day: D0, newDone: 0, revDone: 0, extraNew: 0 };
    const q0 = R.queue(ALL_IDS, {}, today, T0, cfg);
    t('queue: fresh deck offers 50 new cards (the default daily limit) and nothing else', q0.next && cfg.newPerDay === 50 && q0.counts.new === 50 && q0.counts.review === 0 && q0.counts.learn === 0);
    t('queue: daily new limit stops new cards', R.queue(ALL_IDS, {}, Object.assign({}, today, { newDone: cfg.newPerDay }), T0, cfg).next === null);
    const lc = { [ALL_IDS[5]]: R.schedule({}, R.AGAIN, T0, cfg, ALL_IDS[5]) };
    t('queue: due learning card comes first', R.queue(ALL_IDS, lc, today, T0 + 61000, cfg).next === ALL_IDS[5]);
    t('queue: learning card shown early when nothing else is left',
      R.queue(ALL_IDS, lc, Object.assign({}, today, { newDone: cfg.newPerDay }), T0 + 1000, cfg).next === ALL_IDS[5]);
    t('queue: new cards come in the order given', R.queue(MANUAL_ORDER, {}, today, T0, cfg).next === MANUAL_ORDER[0]
      && R.queue(MANUAL_ORDER, { [MANUAL_ORDER[0]]: lc[ALL_IDS[5]] }, today, T0, cfg).firstNew === MANUAL_ORDER[1]);
    t('manual order: sections in manual order, pages ascending inside each',
      MANUAL_ORDER.length === QS.length && BY_ID.get(MANUAL_ORDER[0]).s === SECS[0].id
      && MANUAL_ORDER.every((id, i) => {
        if (!i) return true;
        const a = BY_ID.get(MANUAL_ORDER[i - 1]), b = BY_ID.get(id);
        const ia = SECS.findIndex(x => x.id === a.s), ib = SECS.findIndex(x => x.id === b.s);
        return ia < ib || (ia === ib && a.p <= b.p);
      }));
    const signs = SEC_IDS.get('signs');
    const qs1 = R.queue(MANUAL_ORDER, lc, today, T0 + 61000, cfg, signs);
    t('queue: a section scope shows only that section', signs.has(qs1.next) && qs1.newHere === SEC_Q.get('signs').length
      && qs1.counts.learn === 0 && qs1.newTotalLeft === QS.length - 1);
    t('queue: ...and shares the daily new limit', R.queue(MANUAL_ORDER, {}, Object.assign({}, today, { newDone: cfg.newPerDay }), T0, cfg, signs).next === null);

    state.srs = freshSrs();
    state.srs.cards[QS[2].id] = R.schedule({}, R.GOOD, Date.now() - 864e5, cfg, QS[2].id);
    state.session = makeSession('practice', 'x', QS.slice(0, 3));
    choose(QS[0], QS[0].a);
    choose(QS[1], (QS[1].a + 1) % 3);
    choose(QS[2], QS[2].a);
    t('tests: a right answer does not add a new question', !state.srs.cards[QS[0].id]);
    t('tests: a mistake on a new question goes to learning, outside the new limit', state.srs.cards[QS[1].id].st === R.LEARN
      && state.srs.cards[QS[1].id].due - state.srs.cards[QS[1].id].last === 60000 && state.srs.today.newDone === 0);
    t('tests: a question already being learned moves on', state.srs.cards[QS[2].id].reps === 2);
    const exQs = QS.slice(10, 13);
    state.srs.cards[exQs[2].id] = R.schedule({}, R.GOOD, Date.now() - 864e5, cfg, exQs[2].id);
    state.session = makeSession('exam', 'x', exQs, { deferred: true });
    state.session.ans[exQs[0].id] = (exQs[0].a + 1) % 3;
    state.session.ans[exQs[2].id] = exQs[2].a;
    t('exam answers are scheduled only when it is finished', !state.srs.cards[exQs[0].id] && state.srs.cards[exQs[2].id].reps === 1);
    finish();
    t('...then mistakes and studied questions are scheduled, unanswered are not', state.srs.cards[exQs[0].id].st === R.LEARN
      && state.srs.cards[exQs[2].id].reps === 2 && !state.srs.cards[exQs[1].id]);

    const v1 = fresh();
    v1.stats = { [QS[0].id]: { n: 3, c: 2, last: 1, ts: T0 - 864e5 * 4 }, [QS[1].id]: { n: 1, c: 0, last: 0, ts: T0 - 864e5 },
      [QS[2].id]: { n: 1, c: 1, last: 1, ts: T0 } };
    v1.srs.cards[QS[2].id] = R.schedule({}, R.AGAIN, T0, cfg, QS[2].id);
    importStats(v1);
    const imp = v1.srs.cards;
    t('import: last answer right -> learned, due for review', imp[QS[0].id].st === R.REVIEW && imp[QS[0].id].day <= R.dayOf(T0)
      && R.queue(ALL_IDS, imp, today, T0, cfg).reviewDueTotal === 1);
    t('import: last answer wrong -> learning', imp[QS[1].id].st === R.LEARN);
    t('import: existing cards and unanswered questions untouched', imp[QS[2].id].st === R.LEARN && imp[QS[2].id].reps === 1
      && !imp[QS[3].id]);

    state.srs = freshSrs();
    t('«Учить» starts with the first section of the manual', BY_ID.get(srsQueue().next).s === SECS[0].id);
    state.srs.focus = 'dui';
    t('the section opened last goes first', BY_ID.get(srsQueue().next).s === 'dui' && BY_ID.get(srsQueue().firstNew).s === 'dui');
    viewLearn('signs');
    t('section learn picks a question from that section', BY_ID.get(state.srs.cur.id).s === 'signs');
    viewLearn('park');
    t('switching sections replaces an unanswered current question', BY_ID.get(state.srs.cur.id).s === 'park');
    state.srs.cur.ans = BY_ID.get(state.srs.cur.id).a;
    const answeredId = state.srs.cur.id;
    viewLearn('signs');
    t('...and grades one that was already answered', state.srs.cards[answeredId] && state.srs.cards[answeredId].st === R.LEARN
      && BY_ID.get(state.srs.cur.id).s === 'signs');
    t('section card has «Учить» and «Тест»', viewSectionCard(SECS[0], true).querySelectorAll('button.btn').length === 2);
    state.srs = freshSrs();
    state.session = null;
    const vl = viewLearn();
    const cur = state.srs.cur;
    t('learn view shows a question with 3 options', vl.querySelectorAll('button.opt').length === 3 && !!cur);
    const qq = BY_ID.get(cur.id);
    cur.ans = qq.a;
    t('correct answer shows 4 grade buttons', viewLearn().querySelectorAll('button.grade').length === 4);
    cur.ans = (qq.a + 1) % 3;
    t('wrong answer shows only "next"', viewLearn().querySelectorAll('button.grade').length === 0);
    const keyGrade = (key, ok) => {
      state.srs = freshSrs();
      viewLearn();
      const c = state.srs.cur, cq = BY_ID.get(c.id);
      c.ans = ok ? cq.a : (cq.a + 1) % 3;
      onLearnKey({ key, target: document.body, preventDefault() {} });
      return state.srs.cards[cq.id];
    };
    t('keys 1-4 grade a correct answer', keyGrade('2', true).st === R.LEARN && keyGrade('4', true).st === R.REVIEW);
    t('...but do nothing after a wrong answer', !keyGrade('4', false));
    t('srs dashboard renders', viewSrs().querySelectorAll('.srs-big').length === 3);
    t('images resolve to a relative path', QS.filter(q => q.i).every(q => /^images\/[\w.-]+\.jpg$/.test(q.i)));

    /* card battle */
    state = fresh();
    record(QS[5].id, false);
    record(QS[6].id, false); record(QS[6].id, true);
    for (let i = 0; i < 5; i++) record(QS[7].id, i !== 2);
    t('battle: the cop deck holds shaky mistakes, the currently wrong first', copDeck().join() === [QS[5].id, QS[6].id].join(), copDeck().join());
    t('battle: intro renders with a start button', /В бой/.test(viewBattle().textContent));
    battleStart();
    let b = state.battle;
    t('battle: you start, 15 HP each, with a new card from «Учить»', b.card.by === 'me' && b.card.src === 'new' && b.me === 15 && b.cop === 15);
    const mq = BY_ID.get(b.card.id);
    battleAnswer(mq, mq.a);
    t('battle: a right answer on your card hits the cop and counts as learning', b.cop === 14 && b.me === 15 && state.srs.today.newDone === 1);
    battleAnswer(mq, (mq.a + 1) % 3);
    t('battle: one answer per card', b.log.length === 1 && b.cop === 14);
    const tv = viewBattle();
    t('battle: turn view has two fighters, 15 pips each, the question and a next button',
      tv.querySelectorAll('canvas.sprite').length === 2 && tv.querySelectorAll('.pips i').length === 30
      && tv.querySelectorAll('button.opt').length === 3 && /Ход копа/.test(tv.textContent));
    battleNext();
    t('battle: then the cop throws an old mistake', b.card.by === 'cop' && [QS[5].id, QS[6].id].includes(b.card.id), b.card.id);
    const cq = BY_ID.get(b.card.id);
    battleAnswer(cq, (cq.a + 1) % 3);
    t('battle: a failed block costs you 1 HP', b.me === 14 && b.cop === 14);
    battleNext();
    t('battle: your turn again, never a card twice in one battle', b.card.by === 'me' && !b.log.some(x => x.id === b.card.id));
    state = fresh();
    battleStart();
    b = state.battle;
    let guard = 0;
    while (!b.endedAt && guard++ < 200) {
      const c = b.card, q = BY_ID.get(c.id);
      battleAnswer(q, c.by === 'me' ? q.a : (q.a + 1) % 3);   // always hit, never block
      battleNext();
    }
    t('battle: you strike first, so your 15th hit lands before his 15th', b.endedAt && b.cop === 0 && b.me === 1 && b.log.length === 29
      && state.battles.wins === 1 && state.battles.streak === 1, `${b.me}:${b.cop} after ${b.log.length}`);
    t('battle: result view renders', /Победа/.test(viewBattle().textContent));
    t('battle: home tile is there', /Бой с копом/.test(viewHome().textContent));
    t('sprites are 16 px wide', COP_SPRITE.concat(ME_SPRITE).every(r => r.length === 16) && COP_SPRITE.length === ME_SPRITE.length);
    t('the flame sprite is a clean 8 px wide rectangle', FLAME_SPRITE.every(r => r.length === 8) && [...FLAME_SPRITE.join('')].every(c => c === '.' || FLAME_PAL[c]));

    /* 1.3: the cop hits harder the more often you got that question wrong before */
    t('battle: a hit is the number of earlier mistakes, from 1 to 3', [0, 1, 2, 3, 4, 9].map(copHit).join() === '1,1,2,3,3,3');
    const hitFor = (k, me = 15) => {
      const q = QS[20 + k];
      state = fresh();
      for (let i = 0; i < k; i++) record(q.id, false);
      state.battle = { startedAt: 1, me, cop: 15, card: { id: q.id, ord: [0, 1, 2], by: 'cop', src: 'deck' }, log: [], endedAt: null, gaveUp: false };
      battleAnswer(q, (q.a + 1) % 3);
      return [me - state.battle.me, state.battle.log[0].dmg];
    };
    t('battle: wrong on a card missed 1 / 2 / 5 times before costs 1 / 2 / 3 HP', [1, 2, 5].map(k => hitFor(k).join('=')).join() === '1=1,2=2,3=3');
    t('battle: a card the cop throws that you never missed still costs 1', hitFor(0).join('=') === '1=1');
    state = fresh();
    for (let i = 0; i < 4; i++) record(QS[30].id, false);
    state.battle = { startedAt: 1, me: 15, cop: 15, card: { id: QS[30].id, ord: [0, 1, 2], by: 'cop', src: 'deck' }, log: [], endedAt: null, gaveUp: false };
    t('battle: the stake is announced before the answer', /минус 3 HP/.test(viewBattle().textContent));
    battleAnswer(QS[30], QS[30].a);
    t('battle: a right answer blocks and costs nothing', state.battle.me === 15 && state.battle.log[0].dmg === 1 && /Отбил/.test(viewBattle().textContent));
    hitFor(5, 2);
    t('battle: HP stops at 0 and the fight is lost', state.battle.me === 0 && !!state.battle.endedAt && state.battles.losses === 1);
    state.battle = { startedAt: 1, me: 14, cop: 15, card: { id: QS[5].id, ord: [0, 1, 2], by: 'cop', src: 'deck', ans: 0 }, log: [{ id: QS[5].id, by: 'cop', ok: false }], endedAt: null };
    t('battle: a log from before 1.3 (no dmg) is read as −1', /Ты −1/.test(viewBattle().textContent));

    /* 1.3: streak */
    state = fresh();
    const day = k => new Date(2026, 9, 10 + k, 12).getTime();   // local noon, k days after 10 Oct 2026
    touchStreak(day(0)); touchStreak(day(0) + 3600e3);
    t('streak: starts at 1 and counts a day once', state.streak.cur === 1 && state.streak.best === 1);
    touchStreak(day(1)); touchStreak(day(2));
    t('streak: consecutive days add up', state.streak.cur === 3 && state.streak.best === 3);
    t('streak: still alive the day after, today not counted yet', streakNow(day(3)).cur === 3 && !streakNow(day(3)).done);
    t('streak: gone after a missed day, the record stays', streakNow(day(4)).cur === 0 && streakNow(day(4)).best === 3);
    touchStreak(day(4));
    t('streak: a missed day starts over from 1', state.streak.cur === 1 && state.streak.best === 3);
    touchStreak(day(2));
    t('streak: a clock that went back changes nothing', state.streak.cur === 1 && state.streak.last === R.dayOf(day(4)));
    state = fresh();
    touchStreak(new Date(2026, 9, 11, 23, 0).getTime()); touchStreak(new Date(2026, 9, 12, 3, 30).getTime());
    t('streak: 3:30 at night still belongs to the previous day (days turn at 4:00)', state.streak.cur === 1);
    touchStreak(new Date(2026, 9, 12, 5, 0).getTime());
    t('streak: ...and 5:00 is the next day', state.streak.cur === 2);
    state = fresh();
    record(QS[0].id, true);
    t('streak: any answer counts (record)', state.streak.cur === 1 && streakNow().done);
    state = fresh();
    state.streak = { last: R.dayOf(Date.now()) - 1, cur: 4, best: 6 };
    t('streak: home card shows the running streak and the missing day', /Серия: 4 дня/.test(viewHome().textContent)
      && /ещё не засчитан/.test(viewHome().textContent) && viewHome().querySelector('.streak.idle'));
    record(QS[0].id, true);
    t('streak: ...and lights up after an answer', /Серия: 5 дней/.test(viewHome().textContent) && !viewHome().querySelector('.streak.idle'));
    t('streak: stats show it as well', /Серия: 5 дней · рекорд 6 дней/.test(viewStats().textContent));

    /* 1.3: reminders */
    const plans = Array.from({ length: 400 }, (_, i) => remindPlan(20000 + i));
    t('reminders: three a day: 10:00-12:00, then two in 18:00-21:00 at least 45 min apart',
      plans.every(([a, b, c]) => a >= 600 && a < 720 && b >= 1080 && b < 1170 && c - b >= REMIND_GAP && c < 1260));
    t('reminders: times differ from day to day and are the same on every call',
      new Set(plans.map(p => p.join())).size > 300 && remindPlan(20007).join() === remindPlan(20007).join());
    const n0 = remindNext(new Date(2026, 9, 18, 9, 0).getTime()), d0 = new Date(n0.at);
    t('reminders: at 9:00 the next one is that morning', n0.slot === 0 && d0.getDate() === 18 && d0.getHours() >= 10 && d0.getHours() < 12);
    const n1 = remindNext(new Date(2026, 9, 18, 22, 0).getTime());
    t('reminders: after the last one of the day comes tomorrow morning', n1.slot === 0 && new Date(n1.at).getDate() === 19);
    const n2 = remindNext(new Date(2026, 9, 18, 12, 30).getTime()), d2 = new Date(n2.at);
    t('reminders: after the morning one comes the evening', n2.slot === 1 && d2.getDate() === 18 && d2.getHours() >= 18);
    t('reminders: only the streak texts mention a streak, and only when there is one',
      /Серия/.test(remindText(1, 3)) && !/ерия|ерию/.test(remindText(1, 0) + remindText(2, 0) + remindText(0, 5)));
    t('reminders: off by default, the switch is in the settings', !state.settings.remind && /Напоминания/.test(viewStats().textContent));

    /* saves from every earlier version load with the new parts at their defaults */
    const old1 = adopt({ v: 1, stats: { [QS[0].id]: { n: 3, c: 1, last: 0, ts: 1 } }, settings: { shuffle: false }, session: null, history: [] });
    const old2 = adopt({ v: 2, stats: {}, settings: { shuffle: true }, session: null, history: [], srs: { cards: {} }, battle: null,
      battles: { wins: 2, losses: 1, streak: 1, bestStreak: 2 } });
    t('old saves: 1.0 (stats only) keeps its answers and gets an empty streak',
      old1.streak.cur === 0 && old1.streak.last === 0 && old1.stats[QS[0].id].n === 3 && old1.settings.shuffle === false && !old1.settings.remind);
    t('old saves: 1.2 (with battles) keeps them and gets an empty streak',
      old2.streak.best === 0 && old2.battles.wins === 2 && old2.battles.bestStreak === 2 && !old2.settings.remind);
    const lim = (v, n) => adopt({ v: 2, stats: {}, srs: { cards: {}, cfg: n === undefined ? undefined : { newPerDay: n } }, limit50: v }).srs.cfg.newPerDay;
    t('daily limit: a fresh start is 50, and an old save at 20 (or 30) is raised to 50 once', fresh().srs.cfg.newPerDay === 50 && lim(undefined, 20) === 50 && lim(undefined, 30) === 50);
    t('daily limit: a higher one stays, and after the one-time raise the player\'s own choice stands', lim(undefined, 80) === 80 && lim(true, 20) === 20 && lim(true, 35) === 35);
    t('daily limit: an old save with no config at all gets 50', lim(undefined, undefined) === 50);
    t('old saves: a streak already saved survives a reload', adopt(JSON.parse(JSON.stringify({ ...old2, streak: { last: 5, cur: 2, best: 7 } }))).streak.best === 7);

    /* badges */
    const grp = g => BADGES.filter(b => b.group === g).length;
    t('badges: 20 for sections, 4 streak, 4 fights, 2 exams, unique ids', BADGES.length === 30 && new Set(BADGES.map(b => b.id)).size === 30
      && grp('sec') === 20 && grp('streak') === 4 && grp('fight') === 4 && grp('exam') === 2);
    t('badges: every section has one, and only the freeway one is the ghost rider with a flame',
      SECS.every(sc => BADGE_BY_ID.has(`sec-${sc.id}`)) && BADGES.filter(b => b.flame).map(b => b.id).join() === 'sec-fwy'
      && BADGE_BY_ID.get('sec-fwy').title === 'Призрачный гонщик');
    t('badges: each is 16x16 and uses only colours of its palette', BADGES.every(b => b.art.length === 16
      && b.art.every(r => r.length === 16 && [...r].every(c => c === '.' || b.pal[c]))));
    t('badges: all have a name and a way to get them', BADGES.every(b => b.title && b.how.length > 10));

    state = fresh();
    t('badges: a fresh start earns nothing', badgesEarnedNow().size === 0 && awardCheck() === 0 && state.badgeNew.length === 0);
    const cardReview = () => ({ st: R.REVIEW, step: 0, s: 5, d: 5, due: 0, ivl: 5, day: 0, last: 1, reps: 3, lapses: 0 });
    SEC_Q.get('fwy').forEach(q => { state.srs.cards[q.id] = cardReview(); });
    t('badges: every question of a section learned earns that section badge, once',
      awardCheck() === 1 && state.badgeNew.join() === 'sec-fwy' && 'sec-fwy' in state.badges && awardCheck() === 0 && state.badgeNew.length === 1);
    delete state.srs.cards[SEC_Q.get('park')[0].id];
    SEC_Q.get('park').slice(1).forEach(q => { state.srs.cards[q.id] = cardReview(); });
    SEC_Q.get('turn').forEach(q => { state.srs.cards[q.id] = Object.assign(cardReview(), { st: R.LEARN }); });
    t('badges: one question missing, or still being learned, is not enough', !badgesEarnedNow().has('sec-park') && !badgesEarnedNow().has('sec-turn'));

    state = fresh();
    state.streak = { last: 5, cur: 2, best: 7 };
    t('badges: streak tiers follow the best streak', [...badgesEarnedNow()].sort().join() === 'streak-3,streak-7');
    state = fresh();
    state.battles.wins = 1;
    t('badges: the first win', [...badgesEarnedNow()].join() === 'win-first');
    state.battles.bestStreak = 3;
    t('badges: three wins in a row', badgesEarnedNow().has('win-three'));
    const won = me => ({ startedAt: 1, me, cop: 0, card: null, log: [], endedAt: 5, gaveUp: false });
    state = fresh(); state.battle = won(15);
    t('badges: a win without losing a single HP', badgesEarnedNow().has('win-flawless') && !badgesEarnedNow().has('win-close'));
    state.battle = won(2);
    t('badges: a win on 2 HP or less', badgesEarnedNow().has('win-close') && !badgesEarnedNow().has('win-flawless'));
    state.battle = won(7);
    t('badges: a middling win earns neither', !badgesEarnedNow().has('win-close') && !badgesEarnedNow().has('win-flawless'));
    state.battle = Object.assign(won(15), { cop: 4 });
    t('badges: a lost fight earns nothing', badgesEarnedNow().size === 0);
    state.battle = Object.assign(won(15), { gaveUp: true });
    t('badges: giving up earns nothing', badgesEarnedNow().size === 0);

    state = fresh();
    state.history = [{ ts: 1, title: 'x', correct: 20, total: 30, passed: false }];
    t('badges: a failed exam earns nothing', badgesEarnedNow().size === 0);
    state.history.push({ ts: 2, title: 'x', correct: 25, total: 30, passed: true });
    t('badges: passing an exam', [...badgesEarnedNow()].join() === 'exam-pass');
    state.history.push({ ts: 3, title: 'x', correct: 30, total: 30, passed: true });
    t('badges: a perfect exam', badgesEarnedNow().has('exam-perfect'));

    state = fresh();
    state.history = [{ ts: 2, title: 'x', correct: 25, total: 30, passed: true }];
    state.battles.wins = 2;
    t('badges: what was done before the badges existed is handed out too', awardCheck() === 2 && state.badgeNew.slice().sort().join() === 'exam-pass,win-first');
    t('old saves: no badges yet, and an unknown badge in the queue is dropped',
      Object.keys(old1.badges).length === 0 && old1.badgeNew.length === 0 && adopt({ v: 2, badgeNew: ['nope', 'win-first'] }).badgeNew.join() === 'win-first');

    /* badges on screen */
    state = fresh();
    state.badges['streak-3'] = Date.now();
    const home = viewHome();
    t('badges: home has two rails (20 + 10 of them) and a folded card with all 30',
      home.querySelectorAll('.rail').length === 2 && home.querySelectorAll('.rail.left .badge').length === 20
      && home.querySelectorAll('.rail.right .badge').length === 10 && home.querySelectorAll('details.badges-inline .badge').length === 30);
    t('badges: earned ones are marked, the rest are dim, the counts show', home.querySelectorAll('.rail .badge.on').length === 1
      && /Награды 1\/10/.test(home.querySelector('.rail.right').textContent) && /Награды: 1 из 30/.test(home.querySelector('details').textContent));
    t('badges: a flame animates only on the earned ghost rider', home.querySelectorAll('canvas.flaming').length === 0);
    state.badges['sec-fwy'] = Date.now();
    t('badges: ...and then it does', viewHome().querySelectorAll('canvas.flaming').length === 2);
    state.badgeNew = ['win-first', 'exam-pass'];
    openBadgeDialog(BADGE_BY_ID.get('win-first'), true);
    t('badges: the award dialog announces the badge, says how many are waiting and has a button',
      !!awardEl && /Получена награда/.test(awardEl.textContent) && /Первая победа/.test(awardEl.textContent)
      && /Ещё 1/.test(awardEl.textContent) && !!awardEl.querySelector('button.btn.primary'));
    onKey({ key: 'a', preventDefault() {} });
    t('badges: while it is open the keys do not reach the question underneath', !!awardEl && state.badgeNew.length === 2);
    onKey({ key: 'Enter', preventDefault() {} });
    t('badges: closing it moves the queue on', !awardEl && state.badgeNew.join() === 'exam-pass');
    state.badgeNew = [];
    showBadge(BADGE_BY_ID.get('sec-park'));
    t('badges: tapping a badge not yet earned says so and how to get it', /Ещё не получена/.test(awardEl.textContent) && /Освоить все вопросы/.test(awardEl.textContent));
    awardEl.querySelector('button.btn').click();
    t('badges: details close without touching the queue', !awardEl && state.badgeNew.length === 0);

    const drawn = [];
    const fakeG = { set fillStyle(v) { this.c = v; }, fillRect(x, y) { drawn.push([x, y, this.c]); } };
    const fl = BADGE_BY_ID.get('sec-fwy').flame;
    for (let k = 0; k < 24; k++) drawFlame(fakeG, fl, k / 24);
    t('flame: stays above the skull inside the tile and uses the flame colours',
      drawn.length > 200 && drawn.every(([x, y, c]) => x >= fl.x0 && x <= fl.x1 && y >= 0 && y <= fl.base && BD.flameStops.some(s => s.c === c)));
    const a = [], b2 = [];
    drawFlame({ set fillStyle(v) {}, fillRect(x, y) { a.push(x + ',' + y); } }, fl, 0);
    drawFlame({ set fillStyle(v) {}, fillRect(x, y) { b2.push(x + ',' + y); } }, fl, 0.37);
    t('flame: it moves from one phase to the next and loops',
      a.join() !== b2.join() && (() => { const p0 = [], p1 = []; drawFlame({ set fillStyle(v) {}, fillRect(x, y) { p0.push(x + ',' + y); } }, fl, 0);
        drawFlame({ set fillStyle(v) {}, fillRect(x, y) { p1.push(x + ',' + y); } }, fl, 1); return p0.join() === p1.join(); })());

    /* sync: merging two devices */
    {
      const [q0, q1, q2] = [QS[0].id, QS[1].id, QS[2].id];
      const dev = (savedAt, extra) => adopt(Object.assign(JSON.parse(JSON.stringify(fresh())), { savedAt }, extra));
      const card = (last, reps, st = R.REVIEW) => ({ st, step: 0, s: 3, d: 5, due: 0, ivl: 3, day: 1, last, reps, lapses: 0 });
      const mac = dev(100, {
        stats: { [q0]: { n: 2, c: 2, last: 1, ts: 50 }, [q1]: { n: 1, c: 0, last: 0, ts: 90 } },
        srs: { cards: { [q0]: card(50, 2), [q1]: card(90, 1, R.LEARN) }, cfg: Object.assign({}, R.DEFAULTS, { newPerDay: 70 }), today: { day: 9, newDone: 5, revDone: 2, extraNew: 0 } },
        history: [{ ts: 10, title: 'Экзамен', correct: 20, total: 30, passed: false }],
        badges: { 'win-first': 40 }, battles: { wins: 3, losses: 1, streak: 2, bestStreak: 2 }, streak: { last: 9, cur: 4, best: 4 },
        session: { mine: 'mac' }, settings: { shuffle: false },
      });
      const phone = dev(200, {
        stats: { [q0]: { n: 3, c: 2, last: 0, ts: 150 }, [q2]: { n: 1, c: 1, last: 1, ts: 160 } },
        srs: { cards: { [q0]: card(150, 3, R.LEARN), [q2]: card(160, 1) }, cfg: Object.assign({}, R.DEFAULTS, { newPerDay: 60 }), today: { day: 9, newDone: 8, revDone: 1, extraNew: 0 } },
        history: [{ ts: 10, title: 'Экзамен', correct: 20, total: 30, passed: false }, { ts: 170, title: 'Экзамен', correct: 27, total: 30, passed: true }],
        badges: { 'win-first': 30, 'exam-pass': 170 }, battles: { wins: 2, losses: 4, streak: 0, bestStreak: 3 }, streak: { last: 9, cur: 5, best: 6 },
        session: { mine: 'phone' }, settings: { shuffle: true },
      });
      const m = mergeStates(mac, phone);
      t('sync: per question the later answer and the later review win, nothing is lost',
        m.stats[q0].ts === 150 && m.stats[q1].ts === 90 && m.stats[q2].ts === 160
        && m.srs.cards[q0].last === 150 && m.srs.cards[q1].last === 90 && m.srs.cards[q2].last === 160);
      t('sync: exams are joined without doubles, badges keep the first date',
        m.history.length === 2 && m.history[1].ts === 170 && m.badges['win-first'] === 30 && m.badges['exam-pass'] === 170);
      t('sync: counters take the larger, settings of the later save win, the screen stays this device\'s',
        m.battles.wins === 3 && m.battles.losses === 4 && m.battles.bestStreak === 3 && m.battles.streak === 0
        && m.streak.cur === 5 && m.streak.best === 6 && m.srs.today.newDone === 8 && m.srs.today.revDone === 2
        && m.srs.cfg.newPerDay === 60 && m.session.mine === 'mac' && m.settings.shuffle === false && m.savedAt === 200);
      const m2 = mergeStates(phone, mac);
      const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
      t('sync: the same result from either side', canon(shareable(m2)) === canon(Object.assign(shareable(m), { settings: m2.settings })));
      t('sync: merging again changes nothing', JSON.stringify(shareable(mergeStates(m, phone))) === JSON.stringify(shareable(m)));
      const empty = dev(0, {});
      t('sync: a new empty device takes everything', JSON.stringify(mergeStates(empty, mac).srs.cards) === JSON.stringify(mac.srs.cards)
        && mergeStates(empty, mac).battles.wins === 3);
      const wiped = dev(300, { resetAt: 250 });
      const r1 = mergeStates(mac, wiped), r2 = mergeStates(phone, wiped);
      t('sync: a reset on one device wipes the older progress on the others',
        !Object.keys(r1.stats).length && !Object.keys(r1.srs.cards).length && !r1.history.length && !Object.keys(r1.badges).length
        && r1.battles.wins === 0 && r2.streak.best === 0 && r1.resetAt === 250);
      const after = dev(400, { stats: { [q1]: { n: 1, c: 1, last: 1, ts: 350 } }, srs: { cards: { [q1]: card(350, 1) } } });
      t('sync: ...but what was done after the reset stays', mergeStates(after, wiped).stats[q1].ts === 350 && mergeStates(wiped, after).srs.cards[q1].last === 350);
      const srsWiped = dev(300, { stats: phone.stats, srs: { cards: {}, resetAt: 250 } });
      const r3 = mergeStates(phone, srsWiped);
      t('sync: resetting the schedule drops older cards and keeps the answers', !Object.keys(r3.srs.cards).length && r3.stats[q2].ts === 160);
      const sh = shareable(Object.assign({}, mac, { battle: { x: 1 }, badgeNew: ['exam-pass'] }));
      t('sync: what is on screen is not sent', sh.session === null && sh.battle === null && sh.badgeNew.length === 0 && sh.srs.cur === null && !!mac.session);
      t('sync: the settings page offers it', /Синхронизация между устройствами/.test(viewStats().textContent) && !!viewStats().querySelector('input[type=password]'));
    }
  } catch (err) {
    t('no exceptions', false, String(err && err.stack || err));
  } finally {
    state = savedState;
    persist = true;
  }
  const failed = out.filter(l => l.startsWith('FAIL')).length;
  out.push('', failed ? `RESULT: ${failed} FAILED` : 'RESULT: ALL PASSED');
  document.title = failed ? 'SELFTEST FAIL' : 'SELFTEST PASS';
  return h('pre', { id: 'selftest' }, out.join('\n'));
}

/* ---------- boot ---------- */
function boot() {
  const qp = new URLSearchParams(location.search);
  if (qp.has('selftest')) { $app.append(runSelfTest()); return; }
  window.addEventListener('hashchange', () => render());
  document.addEventListener('keydown', onKey);
  remindSchedule();
  setInterval(flameTick, 110);
  awardCheck();                       // badges for what was done before they existed
  if (state.badgeNew.length) save();
  syncNow();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncSoon(300); else if (syncTimer) syncNow(); });
  const start = qp.get('start');
  if (start) {
    history.replaceState(null, '', location.pathname);
    const [kind, arg] = start.split(':');
    if (kind === 'exam') startExam();
    else if (kind === 'learn' || kind === 'srs') { go(kind); return; }
    else if (kind === 'section' && SEC.has(arg)) startSection(arg);
    else if (kind === 'official') startOfficial(Number(arg));
    else if (kind === 'battle') {
      battleStart();
      const k = Number(qp.get('ans')), c = state.battle.card;
      if (k >= 1 && k <= 3) battleAnswer(BY_ID.get(c.id), c.ord[k - 1]);
      return;
    }
    else if (kind === 'demo-result') {
      const S = makeSession('exam', `Экзамен, ${EXAM_SIZE} вопросов`, buildExam(), { deferred: true });
      S.ids.forEach((id, i) => { if (i % 5 !== 4) S.ans[id] = i % 4 === 3 ? (BY_ID.get(id).a + 1) % 3 : BY_ID.get(id).a; });
      state.session = S;
      finish();
    }
    /* test hooks: &q=N jumps to question N, &ans=K picks the K-th displayed option */
    const S = state.session;
    if (S && !S.finished) {
      if (Number(qp.get('q')) > 0) S.idx = Math.min(Number(qp.get('q')), S.ids.length) - 1;
      const k = Number(qp.get('ans'));
      if (k >= 1 && k <= 3) choose(BY_ID.get(S.ids[S.idx]), S.ord[S.ids[S.idx]][k - 1]);
      save();
    }
    return;
  }
  render();
}
boot();
})();
