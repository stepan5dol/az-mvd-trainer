(() => {
'use strict';

/* Spaced repetition: FSRS-6, the scheduler built into Anki since 23.10.
   Formulas and default weights follow the reference implementation (open-spaced-repetition/py-fsrs);
   day boundaries, learning steps, fuzz and the hard<good<easy ordering follow Anki.
   On top of that: an exam date (new-card pacing + "remember it on exam day" interval cap).
   Pure functions only, no DOM: app.js owns state and UI. */

const W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
  1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const DECAY = -W[20];
const FACTOR = 0.9 ** (1 / DECAY) - 1;   // makes R(t = S) = 0.9
const MIN_S = 0.001;
const MAX_IVL = 36500;
const MIN = 60 * 1000;
const ROLLOVER_H = 4;                    // Anki's "next day starts at" 4:00
const LEARN_AHEAD = 20 * MIN;            // learning cards may be shown up to 20 min early

const NEW = 0, LEARN = 1, REVIEW = 2, RELEARN = 3;
const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

const DEFAULTS = {
  learnSteps: [1, 10],     // minutes
  relearnSteps: [10],      // minutes
  retention: 0.9,          // desired retention for everyday scheduling
  examRetention: 0.95,     // target recall probability on exam day
  newPerDay: 50,
  maxReviews: 200,
  examDate: '',            // 'YYYY-MM-DD' or ''
};

/* ---------- days ---------- */
function dayOf(ts) {
  const d = new Date(ts - ROLLOVER_H * 3600e3);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
}
function parseDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null;
}
function dayToIso(day) { return new Date(day * 864e5).toISOString().slice(0, 10); }

/* ---------- FSRS-6 memory model ---------- */
const clampD = d => Math.min(10, Math.max(1, d));
const clampS = s => Math.max(MIN_S, s);
const retrievability = (t, s) => (1 + (FACTOR * Math.max(0, t)) / s) ** DECAY;
const initS = g => clampS(W[g - 1]);
const initDRaw = g => W[4] - Math.exp(W[5] * (g - 1)) + 1;
const initD = g => clampD(initDRaw(g));
function nextD(d, g) {
  const delta = -W[6] * (g - 3);
  const damped = d + ((10 - d) * delta) / 9;              // linear damping (new in FSRS-6)
  return clampD(W[7] * initDRaw(EASY) + (1 - W[7]) * damped); // mean reversion
}
function shortTermS(s, g) {
  let inc = Math.exp(W[17] * (g - 3 + W[18])) * s ** -W[19];
  if (g >= HARD) inc = Math.max(inc, 1);
  return clampS(s * inc);
}
function recallS(d, s, r, g) {
  const hard = g === HARD ? W[15] : 1;
  const easy = g === EASY ? W[16] : 1;
  return clampS(s * (1 + Math.exp(W[8]) * (11 - d) * s ** -W[9] * (Math.exp((1 - r) * W[10]) - 1) * hard * easy));
}
function forgetS(d, s, r) {
  const longTerm = W[11] * d ** -W[12] * ((s + 1) ** W[13] - 1) * Math.exp((1 - r) * W[14]);
  const shortTerm = s / Math.exp(W[17] * W[18]);
  return clampS(Math.min(longTerm, shortTerm));
}
/* interval (days, unrounded) after which recall probability drops to `ret` */
const ivlFor = (s, ret) => (s / FACTOR) * (ret ** (1 / DECAY) - 1);

/* ---------- fuzz (Anki ranges), seeded so the button preview equals the real result ---------- */
const FUZZ = [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]];
function hash01(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
  return ((x >>> 0) % 100000) / 100000;
}
function fuzzRange(ivl) {
  if (ivl < 2.5) return [ivl, ivl];
  let delta = 1;
  for (const [a, b, f] of FUZZ) delta += f * Math.max(0, Math.min(ivl, b) - a);
  const hi = Math.min(Math.round(ivl + delta), MAX_IVL);
  return [Math.min(Math.max(2, Math.round(ivl - delta)), hi), hi];
}

/* ---------- exam date ---------- */
function examInfo(cfg, today) {
  const day = parseDay(cfg.examDate);
  if (day == null || day < today) return null;
  return { day, left: day - today };   // left = 0 on exam day itself
}
/* Cap a review interval so the card is seen again before the exam whenever waiting until the exam
   would let its recall probability on exam day fall below examRetention. The review then lands at the
   moment R reaches that target, which spreads the extra load instead of piling it on the eve. */
function capForExam(ivl, s, cfg, today) {
  const ex = examInfo(cfg, today);
  if (!ex || ex.left <= 1 || today + ivl < ex.day) return ivl;
  if (retrievability(ex.left, s) >= cfg.examRetention) return ivl;
  return Math.max(1, Math.min(ivl, Math.floor(ivlFor(s, cfg.examRetention)), ex.left - 1));
}

/* ---------- scheduling one answer ---------- */
function reviewIntervals(s3, cfg, today) {
  const raw = [HARD, GOOD, EASY].map(g => Math.min(MAX_IVL, Math.max(1, Math.round(ivlFor(s3[g], cfg.retention)))));
  let [h, g, e] = raw;
  h = Math.min(h, g);          // Anki keeps hard <= good < easy
  g = Math.max(g, h + 1);
  e = Math.max(e, g + 1);
  return { [HARD]: h, [GOOD]: g, [EASY]: e };
}

/* returns the new card object; `id` seeds the fuzz */
function schedule(card, g, now, cfg, id) {
  const c = Object.assign({ st: NEW, step: 0, s: 0, d: 0, due: 0, day: 0, last: 0, reps: 0, lapses: 0 }, card);
  const today = dayOf(now);
  const elapsed = c.last ? today - dayOf(c.last) : null;

  /* 1. memory state */
  if (c.st === NEW || !c.s) {
    c.s = initS(g);
    c.d = initD(g);
  } else if (elapsed !== null && elapsed < 1) {
    c.s = shortTermS(c.s, g);
    c.d = nextD(c.d, g);
  } else {
    const r = retrievability(elapsed, c.s);
    c.s = g === AGAIN ? forgetS(c.d, c.s, r) : recallS(c.d, c.s, r, g);
    c.d = nextD(c.d, g);
  }

  /* 2. next due */
  const toReview = (ivl) => {
    c.st = REVIEW;
    c.step = 0;
    const [lo, hi] = fuzzRange(ivl);
    const days = capForExam(lo + Math.floor(hash01(`${id}:${c.reps}`) * (hi - lo + 1)), c.s, cfg, today);
    c.ivl = days;
    c.day = today + days;
    c.due = 0;
  };
  const toStep = (st, steps, i, minutes) => {
    c.st = st;
    c.step = i;
    c.due = now + Math.round((minutes ?? steps[i]) * MIN);
    c.day = 0;
  };
  const ownIvl = () => Math.min(MAX_IVL, Math.max(1, Math.round(ivlFor(c.s, cfg.retention))));

  if (c.st === NEW || c.st === LEARN || c.st === RELEARN) {
    const steps = c.st === RELEARN ? cfg.relearnSteps : cfg.learnSteps;
    const st = c.st === RELEARN ? RELEARN : LEARN;
    const step = c.st === NEW ? 0 : c.step;
    if (!steps.length || g === EASY) toReview(ownIvl());
    else if (g === AGAIN) toStep(st, steps, 0);
    else if (g === HARD) {
      const m = step === 0 ? (steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[0] * 1.5) : steps[step];
      toStep(st, steps, step, m);
    } else if (step + 1 >= steps.length) toReview(ownIvl());
    else toStep(st, steps, step + 1);
  } else { /* REVIEW */
    if (g === AGAIN) {
      c.lapses++;
      if (cfg.relearnSteps.length) toStep(RELEARN, cfg.relearnSteps, 0);
      else toReview(ownIvl());
    } else {
      toReview(reviewIntervals(previewS(card, now), cfg, today)[g]);
    }
  }
  c.reps++;
  c.last = now;
  return c;
}

/* stability after each grade, without touching the card (used for review-interval ordering) */
function previewS(card, now) {
  const today = dayOf(now);
  const elapsed = card.last ? today - dayOf(card.last) : 0;
  const out = {};
  for (const g of [AGAIN, HARD, GOOD, EASY]) {
    if (elapsed < 1) out[g] = shortTermS(card.s, g);
    else {
      const r = retrievability(elapsed, card.s);
      out[g] = g === AGAIN ? forgetS(card.d, card.s, r) : recallS(card.d, card.s, r, g);
    }
  }
  return out;
}

/* what each button would do: { [grade]: {due ms | day, label minutes/days} } */
function preview(card, now, cfg, id) {
  const out = {};
  const today = dayOf(now);
  for (const g of [AGAIN, HARD, GOOD, EASY]) {
    const c = schedule(card, g, now, cfg, id);
    out[g] = c.st === REVIEW ? { days: c.day - today } : { mins: Math.round((c.due - now) / MIN) };
  }
  return out;
}

/* ---------- daily queue ---------- */
function newLimit(cfg, today, newLeft, newDoneToday) {
  const ex = examInfo(cfg, today);
  if (!ex) return cfg.newPerDay;
  /* finish all new questions a little before the exam, leaving the last days for reviews only */
  const buffer = ex.left > 10 ? 3 : ex.left > 4 ? 1 : 0;
  const days = Math.max(1, ex.left - buffer);
  return Math.ceil((newLeft + newDoneToday) / days);
}

/* ids: all question ids, in the order new ones are introduced; cards: {id: card};
   today: {day,newDone,revDone,extraNew}; only: optional Set of ids to study (one section),
   the daily limits stay shared with the whole deck. Returns counts and the next id to show (or null) */
function queue(ids, cards, today, now, cfg, only) {
  const day = dayOf(now);
  const learn = [], review = [], fresh = [];
  let newAll = 0;
  for (const id of ids) {
    const c = cards[id];
    const isNew = !c || c.st === NEW;
    if (isNew) newAll++;
    if (only && !only.has(id)) continue;
    if (isNew) fresh.push(id);
    else if (c.st === REVIEW) { if (c.day <= day) review.push(id); }
    else learn.push(id);
  }
  learn.sort((a, b) => cards[a].due - cards[b].due);
  /* most-forgotten first, so a review cap cuts the safest cards */
  const rOf = id => retrievability(day - dayOf(cards[id].last), cards[id].s);
  review.sort((a, b) => rOf(a) - rOf(b));

  const nLimit = newLimit(cfg, day, newAll, today.newDone) + (today.extraNew || 0);
  const newLeft = Math.max(0, Math.min(fresh.length, nLimit - today.newDone));
  const revLeft = Math.max(0, Math.min(review.length, cfg.maxReviews - today.revDone));
  const learnNow = learn.filter(id => cards[id].due <= now);
  const learnSoon = learn.filter(id => cards[id].due <= now + LEARN_AHEAD);

  let next = null;
  if (learnNow.length) next = learnNow[0];
  else if (newLeft || revLeft) {
    /* spread new cards evenly through the reviews */
    const newTotal = today.newDone + newLeft, revTotal = today.revDone + revLeft;
    const pickNew = !revLeft || (newLeft && today.newDone * revTotal <= today.revDone * newTotal);
    next = pickNew ? fresh[0] : review[0];
  } else if (learnSoon.length) next = learnSoon[0];

  return {
    next,
    counts: { new: newLeft, learn: learn.filter(id => cards[id].due <= now + LEARN_AHEAD).length, review: revLeft },
    newLimit: nLimit,
    newTotalLeft: newAll,
    newHere: fresh.length,
    firstNew: fresh.length ? fresh[0] : null,
    reviewDueTotal: review.length,
    learnFirst: learn.length ? learn[0] : null,
    learnLater: learn.length ? cards[learn[0]].due : null,
  };
}

/* reviews due on each of the next `n` days (index 0 = today, includes overdue) */
function forecast(ids, cards, now, n) {
  const day = dayOf(now);
  const out = new Array(n).fill(0);
  for (const id of ids) {
    const c = cards[id];
    if (!c || c.st === NEW) continue;
    const k = c.st === REVIEW ? Math.max(0, c.day - day) : Math.max(0, dayOf(c.due) - day);
    if (k < n) out[k]++;
  }
  return out;
}

/* recall probability of a studied card on a given day (new cards -> null) */
function recallOn(card, day) {
  if (!card || card.st === NEW || !card.s) return null;
  return retrievability(day - dayOf(card.last), card.s);
}

window.SRS = {
  W, DEFAULTS, NEW, LEARN, REVIEW, RELEARN, AGAIN, HARD, GOOD, EASY, LEARN_AHEAD,
  dayOf, parseDay, dayToIso, retrievability, ivlFor, initS, initD, nextD, recallS, forgetS, shortTermS,
  fuzzRange, examInfo, capForExam, schedule, preview, newLimit, queue, forecast, recallOn,
};
})();
