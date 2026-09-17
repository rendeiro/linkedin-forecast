/**
 * Forecast model (SPEC §5). Pure functions, no browser APIs.
 * Tables are {key(hours as string): share}. Reference vectors in tests/model.test.ts.
 */
import type { ModelState, PostType, Regime, Table } from '../shared/types';

export const MODEL_VERSION = 2;

export const S_POST_PRIOR: Table = {
  '0.5': 0.10, '1': 0.18, '2': 0.30, '3': 0.40, '4': 0.48, '5': 0.56, '6': 0.63, '8': 0.74,
  '10': 0.82, '12': 0.87, '15': 0.92, '18': 0.95, '21': 0.98, '24': 1.00,
};

export const S_DAY_PRIOR: Table = {
  '6': 0.05, '8': 0.12, '10': 0.30, '11': 0.40, '12': 0.50, '13': 0.58, '14': 0.66, '15': 0.73,
  '16': 0.79, '17': 0.85, '18': 0.90, '19': 0.94, '20': 0.96, '21': 0.98, '22': 0.99, '24': 1.00,
};

export const DOW_PRIOR = [1.05, 1.10, 1.10, 1.05, 0.90, 0.70, 0.75]; // Mon..Sun
export const ALPHA = 0.30;
export const PRIOR_WEIGHT = 0.35;
export const TAIL_MODE_RATIO = 0.20;
export const SECOND_POST_RETENTION = 0.70;
export const TYPE_PRIOR: Record<PostType, number> = { video: 1.5, image: 1.0, text: 1.0, document: 1.1, unknown: 1.0 };
export const DAY_CAPTURE_TARGET = 0.90;
export const Z80 = 1.28;
const MIN_SHARE = 0.02;

export function initialModel(): ModelState {
  return {
    version: MODEL_VERSION,
    sPost: { ...S_POST_PRIOR },
    sDay: { ...S_DAY_PRIOR },
    dow: [...DOW_PRIOR],
    recentTotals: [],
    recentDaily: [],
    nPostActuals: 0,
    typeActuals: {},
    sdScale: { post: 1, day: 1 },
  };
}

// ---------- helpers ----------

export function sortedKeys(t: Table): number[] {
  return Object.keys(t).map(Number).sort((a, b) => a - b);
}

/** Linear interpolation with the boundary rules of §5.1. */
export function interp(t: Table, x: number): number {
  const keys = sortedKeys(t);
  if (keys.length === 0) return 1;
  const k0 = keys[0];
  if (x <= k0) return t[String(k0)] * Math.max(x / k0, MIN_SHARE);
  const kn = keys[keys.length - 1];
  if (x >= kn) return t[String(kn)];
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i]) {
      const a = keys[i - 1], b = keys[i];
      const va = t[String(a)], vb = t[String(b)];
      return va + (vb - va) * (x - a) / (b - a);
    }
  }
  return t[String(kn)];
}

/** Inverse: smallest x such that interp(t, x) >= target. */
export function inverseInterp(t: Table, target: number): number {
  const keys = sortedKeys(t);
  if (target <= t[String(keys[0])]) return keys[0] * Math.max(target / t[String(keys[0])], MIN_SHARE);
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    const va = t[String(a)], vb = t[String(b)];
    if (target <= vb) return vb === va ? b : a + (b - a) * (target - va) / (vb - va);
  }
  return keys[keys.length - 1];
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function monotone(t: Table): Table {
  const out: Table = {};
  let prev = 0;
  for (const k of sortedKeys(t)) {
    const v = Math.max(t[String(k)], prev);
    out[String(k)] = v;
    prev = v;
  }
  return out;
}

function nearestKey(t: Table, x: number): number {
  let best = NaN, bd = Infinity;
  for (const k of sortedKeys(t)) {
    const d = Math.abs(k - x);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

export function regimeOf(nPostActuals: number): Regime {
  return nPostActuals < 10 ? 'priors' : nPostActuals < 30 ? 'calibrating' : 'fitted';
}

export function typeFactor(model: ModelState, type: PostType): number {
  const xs = model.typeActuals[type] ?? [];
  if (xs.length >= 5 && model.recentTotals.length >= 3) {
    const r = median(xs) / median(model.recentTotals);
    if (Number.isFinite(r) && r > 0) return r;
  }
  return TYPE_PRIOR[type] ?? 1;
}

// ---------- §5.2 post 24h ----------

export interface PostForecast { point: number; low: number; high: number; share: number; sd: number; }

export function postForecast(
  h: number,
  impressions: number,
  recentTotals: number[],
  opts: { sPost?: Table; typeFactor?: number; inNetworkShare?: number; sdScale?: number } = {},
): PostForecast {
  const sPost = opts.sPost ?? S_POST_PRIOR;
  const s = Math.max(interp(sPost, h), MIN_SHARE);
  const implied = Math.max(impressions, 1) / s;
  let total: number;
  if (recentTotals.length > 0) {
    const med = median(recentTotals) * (opts.typeFactor ?? 1);
    const w = Math.min(s, 1);
    const denom = w + (1 - w) * PRIOR_WEIGHT;
    total = Math.exp((w * Math.log(implied) + (1 - w) * PRIOR_WEIGHT * Math.log(Math.max(med, 1))) / denom);
  } else {
    total = implied;
  }
  if (opts.inNetworkShare !== undefined && Number.isFinite(opts.inNetworkShare)) {
    const adj = Math.exp(1.0 * (0.55 - opts.inNetworkShare));
    total *= Math.min(1.25, Math.max(0.75, adj));
  }
  const sd = (0.08 + 0.45 * (1 - Math.min(s, 1))) * (opts.sdScale ?? 1);
  return { point: total, low: total * Math.exp(-Z80 * sd), high: total * Math.exp(Z80 * sd), share: s, sd };
}

/**
 * Share curve extended past 24h: posts keep earning for days, lifetime about 1.6x the 24h mark.
 * S(h) = 1 + 0.6 * (1 - exp(-(h - 24) / 36)) for h > 24.
 */
export function shareAt(sPost: Table, h: number): number {
  if (h <= 24) return Math.max(interp(sPost, h), MIN_SHARE);
  return 1 + 0.6 * (1 - Math.exp(-(h - 24) / 36));
}

export interface PostEod { point: number; low: number; high: number; total24: number; share: number; gain: number; }

/**
 * A post's count at the end of the current UTC day: current impressions plus the expected gain
 * between now (h hours after publish) and midnight (hToMidnight hours ahead). The account prior
 * only scales the remaining gain, so point and both bounds are never below the current count.
 */
export function postEod(
  h: number,
  hToMidnight: number,
  impressions: number,
  recentTotals: number[],
  opts: { sPost?: Table; typeFactor?: number; inNetworkShare?: number; sdScale?: number } = {},
): PostEod {
  const sPost = opts.sPost ?? S_POST_PRIOR;
  const f = postForecast(h, impressions, recentTotals, opts);
  const sNow = shareAt(sPost, h);
  const sMid = shareAt(sPost, h + Math.max(hToMidnight, 0));
  const gain = Math.max(0, (sMid - sNow) * f.point);
  const sd = f.sd;
  return {
    point: impressions + gain,
    low: impressions + gain * Math.exp(-Z80 * sd),
    high: impressions + gain * Math.exp(Z80 * sd),
    total24: f.point, share: f.share, gain,
  };
}

/** Fallback for recentTotals when fewer than 3 actuals exist: lifetime totals / 1.6. */
export function recentTotalsOrLifetime(recentTotals: number[], lifetimes: number[]): number[] {
  if (recentTotals.length >= 3) return recentTotals;
  const lt = lifetimes.filter(x => x > 0).map(x => x / 1.6);
  return lt.length ? lt.slice(-10) : recentTotals;
}

// ---------- §5.3 daily EOD ----------

export interface DayForecast { point: number; low: number; high: number; share: number; sd: number; }

export function dailyEod(u: number, dailyNow: number, opts: { sDay?: Table; sdScale?: number } = {}): DayForecast {
  const sDay = opts.sDay ?? S_DAY_PRIOR;
  const s = Math.max(interp(sDay, u), MIN_SHARE);
  const total = dailyNow / s;
  const sd = (0.06 + 0.35 * (1 - Math.min(s, 1))) * (opts.sdScale ?? 1);
  return { point: total, low: total * Math.exp(-Z80 * sd), high: total * Math.exp(Z80 * sd), share: s, sd };
}

// ---------- §5.4 day ahead ----------

export function dayAhead(recentDaily: number[], weekday: number, dow: number[] = DOW_PRIOR, noPost = false): number {
  const base = mean(recentDaily.slice(-7));
  if (!Number.isFinite(base)) return NaN;
  if (noPost) return 0.30 * base;
  return base * dow[weekday] / mean(dow);
}

// ---------- §5.5 learning ----------

export function learnTable(t: Table, readings: [number, number][], actual: number, alpha = ALPHA): Table {
  if (!(actual > 0)) return t;
  const out: Table = { ...t };
  for (const [h, v] of readings) {
    const k = nearestKey(out, h);
    if (!Number.isFinite(k)) continue;
    const ratio = Math.min(v / actual, 1);
    out[String(k)] = (1 - alpha) * out[String(k)] + alpha * ratio;
  }
  const m = monotone(out);
  const keys = sortedKeys(m);
  if (keys.length) m[String(keys[keys.length - 1])] = Math.max(m[String(keys[keys.length - 1])], 1);
  return m;
}

export function learnPost(model: ModelState, readings: [number, number][], actual: number, type: PostType = 'unknown'): ModelState {
  const sPost = learnTable(model.sPost, readings.filter(([h]) => h < 24), actual);
  const recentTotals = [...model.recentTotals, actual].slice(-10);
  const typeActuals = { ...model.typeActuals, [type]: [...(model.typeActuals[type] ?? []), actual].slice(-10) };
  return { ...model, sPost, recentTotals, typeActuals, nPostActuals: model.nPostActuals + 1 };
}

export function learnDay(model: ModelState, readings: [number, number][], actual: number): ModelState {
  const sDay = learnTable(model.sDay, readings, actual);
  const recentDaily = [...model.recentDaily, actual].slice(-14);
  return { ...model, sDay, recentDaily };
}

/** DOW update after 4+ weeks of data; days = [{weekday, value}]. Renormalised to mean 1. */
export function learnDow(dow: number[], days: { weekday: number; value: number }[], alpha = ALPHA): number[] {
  if (days.length < 28) return dow;
  const all = mean(days.map(d => d.value));
  const next = dow.map((cur, i) => {
    const xs = days.filter(d => d.weekday === i).map(d => d.value);
    if (!xs.length) return cur;
    return (1 - alpha) * cur + alpha * (mean(xs) / all);
  });
  const m = mean(next);
  return next.map(x => x / m);
}

/** Onboarding shift of S_DAY by the account's median publish UTC hour. */
export function shiftSDay(sDay: Table, medianPublishUtcHour: number): Table {
  const delta = Math.round(medianPublishUtcHour - 7.5);
  if (delta === 0) return { ...sDay };
  const out: Table = {};
  for (const k of sortedKeys(sDay)) {
    const nk = k + delta;
    if (nk > 0 && nk < 24) out[String(nk)] = sDay[String(k)];
  }
  out['24'] = 1;
  return monotone(out);
}

// ---------- §5.6 second post ----------

export function secondPostAdd(medianRecent: number, hRemaining: number, sPost: Table = S_POST_PRIOR): number {
  return SECOND_POST_RETENTION * medianRecent * interp(sPost, Math.min(Math.max(hRemaining, 0), 24));
}

export interface PostTimingScenario {
  addToday: number;          // what the new post itself earns before UTC midnight
  lossToday: number;         // what today's earlier posts lose before UTC midnight
  netToday: number;
  reach48Today: number;      // 48h from now: the new post, minus the cannibalised part of earlier posts
  reach48Tomorrow: number;   // 48h from now: the same post held for tomorrow's slot, at full strength
  sacrifice: number;         // reach48Tomorrow - reach48Today. Positive: posting today costs this much
}

/**
 * One post in hand: use it today at a slot `hWaitToday` hours away, or hold it `hWaitTomorrow` hours.
 * A same-day second post keeps SECOND_POST_RETENTION of a normal post and takes 30% of what the
 * earlier posts would still have earned. `earlier` lists today's posts as [hours since publish, 24h scale].
 */
export function postTimingScenario(
  medianRecent: number, hWaitToday: number, hToMidnight: number, hWaitTomorrow: number,
  earlier: [number, number][], sPost: Table = S_POST_PRIOR,
): PostTimingScenario {
  const second = earlier.length > 0;
  const keep = second ? SECOND_POST_RETENTION : 1;
  const take = second ? 1 - SECOND_POST_RETENTION : 0;
  const share = (h: number) => (h <= 0 ? 0 : shareAt(sPost, h));
  const addToday = keep * medianRecent * share(hToMidnight - hWaitToday);
  const remain = (from: number, to: number) => earlier.reduce((a, [h, scale]) => a + Math.max(0, share(h + to) - share(h + from)) * scale, 0);
  const lossToday = take * remain(hWaitToday, Math.max(hToMidnight, hWaitToday));
  const reach48Today = keep * medianRecent * share(48 - hWaitToday) - take * remain(hWaitToday, 48);
  const reach48Tomorrow = medianRecent * share(48 - hWaitTomorrow);
  return { addToday, lossToday, netToday: addToday - lossToday, reach48Today, reach48Tomorrow, sacrifice: reach48Tomorrow - reach48Today };
}

/** Linear interpolation of impressions over snapshots [(hoursSincePublish, impressions)], sorted by time. */
export function impressionsAt(points: [number, number][], h: number): number {
  if (points.length === 0) return 0;
  if (h <= 0) return 0;
  const ps = [...points].sort((a, b) => a[0] - b[0]);
  if (h <= ps[0][0]) {
    // Before the first reading: scale by the S_POST shape from zero.
    const s0 = interp(S_POST_PRIOR, ps[0][0]);
    return ps[0][1] * interp(S_POST_PRIOR, h) / Math.max(s0, MIN_SHARE);
  }
  for (let i = 1; i < ps.length; i++) {
    if (h <= ps[i][0]) {
      const [a, va] = ps[i - 1], [b, vb] = ps[i];
      return b === a ? vb : va + (vb - va) * (h - a) / (b - a);
    }
  }
  return ps[ps.length - 1][1];
}

export interface TailEval { firstHourGain: number; lastHourGain: number; tailMode: boolean; }

export function evalTail(points: [number, number][], hNow: number): TailEval {
  const firstHourGain = impressionsAt(points, 1);
  const lastHourGain = impressionsAt(points, hNow) - impressionsAt(points, Math.max(hNow - 1, 0));
  return { firstHourGain, lastHourGain, tailMode: hNow >= 2 && lastHourGain < TAIL_MODE_RATIO * firstHourGain };
}

export function secondPostVerdict(tailMode: boolean, localHour: number): 'wait' | 'post' | 'weak slot: tomorrow morning' {
  if (!tailMode) return 'wait';
  return localHour >= 7 && localHour <= 18 ? 'post' : 'weak slot: tomorrow morning';
}

// ---------- §5.7 goal and pace ----------

export function pace(
  goal: { kind: 'daily' | 'monthly' | null; value: number },
  recordedThisMonth: number,
  remainingDays: number,
  last3: number[],
  weekday: number,
  dow: number[] = DOW_PRIOR,
): number {
  const dowFactor = dow[weekday] / mean(dow);
  if (goal.kind === 'daily' && goal.value > 0) return goal.value;
  if (goal.kind === 'monthly' && goal.value > 0) {
    const remaining = Math.max(goal.value - recordedThisMonth, 0);
    return (remaining / Math.max(remainingDays, 1)) * dowFactor;
  }
  const m = mean(last3);
  return Number.isFinite(m) ? m * dowFactor : 0;
}

/** Hours before UTC midnight by which a post must go out to land DAY_CAPTURE_TARGET of its 24h. */
export function postByHoursBeforeMidnight(sPost: Table = S_POST_PRIOR): number {
  return inverseInterp(sPost, DAY_CAPTURE_TARGET);
}
