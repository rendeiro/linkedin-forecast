/**
 * Model glue: on new snapshot or daily reading, recompute, log forecasts, learn from actuals,
 * fill open forecasts with actuals, and keep accuracy stats. No alarms or tabs here.
 */
import type {
  Daily, DailyReading, DayForecastView, GoalView, ForecastRecord, Horizon, ModelState, Post, PostForecastView, PostSeen, PostType, Regime, Snapshot, Settings,
} from '../shared/types';
import {
  addDailyReading, addForecast, addSnapshot, allDaily, allForecasts, allPosts, allSnapshots, forecastsFor, getDaily, getPost,
  putDaily, putForecast, putPost, readingsFor, snapshotsFor, putFollower, clearForecasts,
} from './store';
import { getModel, getOnboarding, getSettings, setModel, setOnboarding, timezone } from './state';
import {
  dailyEod, dayAhead, evalTail, interp, learnDay, learnDow, learnPost, median, mean, postByHoursBeforeMidnight, postEod, initialModel, secondPostAdd as secondPostAddFn, postTimingScenario, measuredDaySd, priorDaySd, shareAt,
  recentTotalsOrLifetime, regimeOf, shiftSDay, typeFactor, MODEL_VERSION, pace as paceOf,
} from '../model/simple';
import { resolvePublishedAt } from '../model/urn';
import { addDaysUtc, daysInMonthUtc, hoursBetween, localHour, tzOffsetMinutes, utcDateOf, utcHourOf, weekdayOfUtcDate, HOUR, fmtLocalTime } from '../shared/time';

export type NewPostHook = (post: Post) => Promise<void> | void;
let newPostHook: NewPostHook | null = null;
export function onNewPost(fn: NewPostHook) { newPostHook = fn; }

// ---------- posts and snapshots ----------

export async function ensurePost(seen: PostSeen, now = new Date()): Promise<{ post: Post; created: boolean }> {
  const existing = await getPost(seen.urn);
  const tz = await timezone();
  if (existing) {
    let changed = false;
    if (seen.type && seen.type !== 'unknown' && existing.type === 'unknown') { existing.type = seen.type; changed = true; }
    if (seen.textPreview && !existing.textPreview) { existing.textPreview = seen.textPreview; changed = true; }
    if (seen.ageHintHours !== undefined && seen.ageHintHours !== null) {
      // The page's relative label always wins over the URN decode: URNs are minted at draft or
      // schedule time. "2h" means an age in [2h, 3h); accept the stored time inside that window.
      const hint = seen.ageHintHours;
      const unit = hint < 1 ? 1 / 60 : hint < 24 ? 1 : hint < 168 ? 24 : 168;
      const age = hoursBetween(existing.publishedAt, now);
      if (!existing.timeTrusted && age >= hint - 0.2 && age <= hint + unit + 0.2) { existing.timeTrusted = true; changed = true; }
      if (age < hint - 0.2 || age > hint + unit + 0.2) {
        existing.publishedAt = new Date(now.getTime() - (hint + unit / 2) * HOUR).toISOString();
        existing.publishedApprox = true;
        existing.timeTrusted = true;
        changed = true;
        if (existing.actual24h !== undefined && hoursBetween(existing.publishedAt, now) < 23.5) await undoActual(existing);
      }
    }
    if (changed) await putPost(existing);
    return { post: existing, created: false };
  }
  const r = resolvePublishedAt(seen.urn, now, { ageHintHours: seen.ageHintHours, localHourOf: d => localHour(d, tz) });
  const post: Post = {
    urn: seen.urn, publishedAt: r.publishedAt.toISOString(), publishedApprox: r.approx,
    timeTrusted: seen.ageHintHours !== undefined && seen.ageHintHours !== null,
    type: seen.type ?? 'unknown', textPreview: seen.textPreview, firstSeenAt: now.toISOString(),
  };
  await putPost(post);
  return { post, created: true };
}

/** §4.5 precedence: within 10 minutes, post_summary beats feed/post_page. */
export function latestSnapshot(snaps: Snapshot[]): Snapshot | undefined {
  if (!snaps.length) return undefined;
  const last = snaps[snaps.length - 1];
  const window = snaps.filter(s => hoursBetween(s.observedAt, last.observedAt) <= 10 / 60);
  return window.find(s => s.source === 'post_summary') ?? last;
}

export async function ingestSnapshot(snap: Snapshot & { post?: PostSeen }): Promise<PostForecastView | null> {
  const now = new Date(snap.observedAt);
  const { post, created } = await ensurePost(snap.post ?? { urn: snap.urn }, now);
  const snaps = await snapshotsFor(snap.urn);
  const minute = snap.observedAt.slice(0, 16);
  const dup = snaps.find(s => s.observedAt.slice(0, 16) === minute && s.source === snap.source);
  const recent = snaps.filter(s => Math.abs(hoursBetween(s.observedAt, snap.observedAt)) <= 10 / 60);
  const outranked = snap.source !== 'post_summary' && recent.some(s => s.source === 'post_summary');
  if (!dup && !outranked) {
    const { post: _p, ...clean } = snap; void _p;
    await addSnapshot(clean);
    snaps.push(clean);
  }
  // A post cannot have impressions before it is live.
  if (new Date(post.publishedAt).getTime() > now.getTime()) {
    post.publishedAt = new Date(now.getTime() - 60_000).toISOString();
    post.publishedApprox = true;
    await putPost(post);
  }
  const ageH = hoursBetween(post.publishedAt, now);
  if (!post.timeTrusted && snaps.length && hoursBetween(post.publishedAt, snaps[0].observedAt) <= 3) { post.timeTrusted = true; await putPost(post); }
  if (created && ageH < 3 && newPostHook) await newPostHook(post);
  await checkPostActual(post, snaps);
  return computePostView(post.urn, snaps);
}

/** A frozen 24h actual turned out to come from a wrong publish time: drop it and its learning. */
async function undoActual(post: Post) {
  const model = await getModel();
  const v = post.actual24h!;
  const drop = (xs: number[]) => { const i = xs.indexOf(v); return i >= 0 ? [...xs.slice(0, i), ...xs.slice(i + 1)] : xs; };
  const typeActuals = { ...model.typeActuals, [post.type]: drop(model.typeActuals[post.type] ?? []) };
  await setModel({ ...model, recentTotals: drop(model.recentTotals), typeActuals, nPostActuals: Math.max(0, model.nPostActuals - 1) });
  for (const f of await forecastsFor(post.urn)) {
    if (f.actual !== undefined) { delete f.actual; delete f.errorPct; delete f.inBand; await putForecast(f); }
  }
  delete post.actual24h;
  delete post.actual24hApprox;
}

async function checkPostActual(post: Post, snaps: Snapshot[]) {
  if (post.actual24h) return;
  // Learn only from posts with a trustworthy publish time and at least one reading before hour 20.
  if (!post.timeTrusted) return;
  const hs = snaps.map(s => hoursBetween(post.publishedAt, s.observedAt));
  if (!hs.some(h => h > 0 && h < 20)) return;
  const withH = snaps.map(s => ({ s, h: hoursBetween(post.publishedAt, s.observedAt) })).filter(x => x.h >= 23.5);
  if (!withH.length) return;
  const first = withH.sort((a, b) => a.h - b.h)[0];
  const model = await getModel();
  let actual: number;
  if (first.h < 24) actual = first.s.impressions / Math.max(interp(model.sPost, first.h), 0.02);
  else actual = first.s.impressions;
  post.actual24h = Math.round(actual);
  post.actual24hApprox = first.h > 30;
  await putPost(post);
  const readings: [number, number][] = snaps
    .map(s => [hoursBetween(post.publishedAt, s.observedAt), s.impressions] as [number, number])
    .filter(([h]) => h > 0 && h < 23.5);
  const next = learnPost(model, readings, post.actual24h, post.type);
  await setModel(next);
  await fillForecasts('post', post.urn, post.actual24h, ['24h']);
}

// ---------- daily ----------

export async function ingestDaily(points: { utcDate: string; impressions: number; engagements?: number }[], observedAt: string, timezoneStr?: string, profileId?: string) {
  const today = utcDateOf(observedAt);
  const ob = await getOnboarding();
  let obChanged = false;
  if (timezoneStr && ob.timezone !== timezoneStr) { ob.timezone = timezoneStr; obChanged = true; }
  if (profileId && ob.profileId !== profileId) { ob.profileId = profileId; obChanged = true; }
  if (!ob.done && ob.step < 2) { ob.step = 2; obChanged = true; }
  if (obChanged) await setOnboarding(ob);

  for (const p of points) {
    const prev = await getDaily(p.utcDate);
    const isFinal = p.utcDate < today;
    const rec: Daily = {
      utcDate: p.utcDate, impressions: p.impressions, engagements: p.engagements ?? prev?.engagements,
      final: isFinal, source: 'analytics', updatedAt: observedAt,
    };
    await putDaily(rec);
    if (p.utcDate === today) {
      await addDailyReading({ utcDate: today, observedAt, value: p.impressions, source: 'analytics' });
    } else if (isFinal && (!prev || !prev.final || prev.source !== 'analytics')) {
      await dayClosed(p.utcDate, p.impressions);
    }
  }
  await logDayForecasts();
}

export async function ingestTotal7(value: number, observedAt: string) {
  const today = utcDateOf(observedAt);
  const daily = await allDaily();
  const prev6: number[] = [];
  for (let i = 1; i <= 6; i++) {
    const d = daily.find(x => x.utcDate === addDaysUtc(today, -i));
    if (!d) return; // cannot derive without six completed days
    prev6.push(d.impressions);
  }
  const derived = Math.max(value - prev6.reduce((a, b) => a + b, 0), 0);
  await addDailyReading({ utcDate: today, observedAt, value: derived, source: 'derived' });
  const cur = await getDaily(today);
  const fresh = cur && cur.source === 'analytics' && hoursBetween(cur.updatedAt, observedAt) < 3;
  if (!fresh) await putDaily({ utcDate: today, impressions: derived, final: false, source: 'derived', updatedAt: observedAt });
  await logDayForecasts();
}

async function dayClosed(utcDate: string, actual: number) {
  const model = await getModel();
  const readings: [number, number][] = (await readingsFor(utcDate))
    .filter(r => r.source !== 'partial' && utcDateOf(r.observedAt) === utcDate)
    .map(r => [utcHourOf(r.observedAt), r.value]);
  let next = learnDay(model, readings, actual);
  const finals = (await allDaily()).filter(d => d.final);
  if (finals.length >= 28) {
    next = { ...next, dow: learnDow(next.dow, finals.slice(-56).map(d => ({ weekday: weekdayOfUtcDate(d.utcDate), value: d.impressions }))) };
  }
  await setModel(next);
  await fillForecasts('day', utcDate, actual, ['eod', 'dayahead']);
}

export async function ingestPosts(posts: PostSeen[], topPosts?: { urn: string; impressions: number }[]) {
  const now = new Date();
  for (const p of posts) await ensurePost(p, now);
  for (const t of topPosts ?? []) {
    const post = await getPost(t.urn);
    if (post && (!post.lifetime || t.impressions > post.lifetime)) { post.lifetime = t.impressions; await putPost(post); }
  }
  const ob = await getOnboarding();
  if (!ob.done) {
    const all = await allPosts();
    const snaps = await allSnapshots();
    const withSnap = new Set(snaps.map(s => s.urn));
    const youngest = all.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)).slice(0, 15);
    ob.postsToRead = youngest.map(p => p.urn);
    ob.postsRead = youngest.filter(p => withSnap.has(p.urn)).map(p => p.urn);
    if (ob.step < 3) ob.step = 3;
    await setOnboarding(ob);
  }
}

export async function ingestFollowers(points: { utcDate: string; count: number }[]) {
  for (const p of points) await putFollower(p);
}

// ---------- forecasts ----------

async function logForecast(rec: Omit<ForecastRecord, 'createdAt' | 'modelVersion'>) {
  const existing = await forecastsFor(rec.key);
  const last = existing.filter(f => f.target === rec.target && f.horizon === rec.horizon).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (last && hoursBetween(last.createdAt, new Date()) < 0.25) return;
  await addForecast({ ...rec, createdAt: new Date().toISOString(), modelVersion: MODEL_VERSION });
}

async function fillForecasts(target: 'post' | 'day', key: string, actual: number, horizons: Horizon[]) {
  if (!(actual > 0)) return;
  const fs = await forecastsFor(key);
  let touched = false;
  for (const f of fs) {
    if (f.target !== target || !horizons.includes(f.horizon) || f.actual !== undefined) continue;
    f.actual = actual;
    f.errorPct = (f.point - actual) / actual;
    f.inBand = f.low <= actual && actual <= f.high;
    await putForecast(f);
    touched = true;
  }
}

export async function recentTotalsFor(model: ModelState): Promise<number[]> {
  if (model.recentTotals.length >= 3) return model.recentTotals;
  const posts = await allPosts();
  const lifetimes = posts.filter(p => p.lifetime).sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1)).map(p => p.lifetime!);
  return recentTotalsOrLifetime(model.recentTotals, lifetimes);
}

export async function computePostView(urn: string, snaps?: Snapshot[], now = new Date()): Promise<PostForecastView | null> {
  const post = await getPost(urn);
  if (!post) return null;
  const ss = snaps ?? (await snapshotsFor(urn));
  const latest = latestSnapshot(ss);
  if (!latest) return null;
  const model = await getModel();
  const h = Math.max(hoursBetween(post.publishedAt, now), 0.05);
  const hToMidnight = 24 - utcHourOf(now);
  const recent = await recentTotalsFor(model);
  const tf = model.recentTotals.length >= 3 ? typeFactor(model, post.type) : 1;
  const f = postEod(h, hToMidnight, latest.impressions, recent, { sPost: model.sPost, typeFactor: tf, inNetworkShare: latest.inNetworkShare });
  const points: [number, number][] = ss.map(s => [hoursBetween(post.publishedAt, s.observedAt), s.impressions]);
  let gainPerHour: number | undefined;
  const earlier = [...ss].reverse().find(s => hoursBetween(s.observedAt, latest.observedAt) >= 20 / 60);
  if (earlier) gainPerHour = (latest.impressions - earlier.impressions) / hoursBetween(earlier.observedAt, latest.observedAt);
  const tail = evalTail(points, h);
  const regime: Regime = regimeOf(model.nPostActuals);
  const ratio = tail.firstHourGain > 0 ? tail.lastHourGain / tail.firstHourGain : 1;
  const status: PostForecastView['status'] = h < 1.5 || points.length < 2 ? 'starting' : ratio >= 0.5 ? 'rising' : ratio >= 0.2 ? 'slowing' : 'tail';
  const step = Math.max(1, Math.ceil(points.length / 40));
  const series = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const view: PostForecastView = {
    urn, publishedAt: post.publishedAt, hours: h, impressions: latest.impressions,
    point: f.point, low: f.low, high: f.high, total24: f.total24, gainPerHour, tailMode: tail.tailMode, status, series, textPreview: post.textPreview,
    regime, type: post.type, observedAt: latest.observedAt,
  };
  if (h < 24 && !post.actual24h && hoursBetween(latest.observedAt, now) < 6) {
    const sd = 0.08 + 0.45 * (1 - Math.min(f.share, 1));
    await logForecast({ target: 'post', key: urn, horizon: '24h', point: f.total24, low: f.total24 * Math.exp(-1.28 * sd), high: f.total24 * Math.exp(1.28 * sd), shareObserved: f.share, regime, postType: post.type });
  }
  return view;
}

/**
 * Discard the derived model and rebuild it from stored readings under the trust rules.
 * Raw snapshots and daily values are kept. Runs once per model version and on demand.
 */
export async function rebuildModel(): Promise<{ posts: number; trusted: number; actuals: number }> {
  await setModel(initialModel());
  await clearForecasts();
  const posts = (await allPosts()).sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1));
  let trusted = 0, actuals = 0;
  for (const p of posts) {
    const ss = await snapshotsFor(p.urn);
    if (p.timeTrusted === undefined) p.timeTrusted = ss.length > 0 && hoursBetween(p.publishedAt, ss[0].observedAt) <= 3;
    delete p.actual24h; delete p.actual24hApprox;
    await putPost(p);
    if (p.timeTrusted) trusted++;
  }
  for (const p of posts) {
    const fresh = (await getPost(p.urn))!;
    await checkPostActual(fresh, await snapshotsFor(p.urn));
    if ((await getPost(p.urn))!.actual24h) actuals++;
  }
  const model = await getModel();
  const finals = (await allDaily()).filter(d => d.final).slice(-14).map(d => d.impressions);
  await setModel({ ...model, recentDaily: finals });
  return { posts: posts.length, trusted, actuals };
}

export interface DailyNow { value: number; source: 'analytics' | 'derived' | 'partial' | 'none'; }

export async function dailyNowFor(today: string, now: Date): Promise<DailyNow> {
  const d = await getDaily(today);
  if (d && d.source === 'analytics' && hoursBetween(d.updatedAt, now) < 6) return { value: d.impressions, source: 'analytics' };
  const readings = (await readingsFor(today)).sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1));
  const derived = readings.find(r => r.source === 'derived');
  const analytics = readings.find(r => r.source === 'analytics');
  const best = [analytics, derived].filter(Boolean).sort((a, b) => (a!.observedAt < b!.observedAt ? 1 : -1))[0];
  if (best) return { value: best.value, source: best.source as 'analytics' | 'derived' };
  if (d) return { value: d.impressions, source: d.source === 'export' ? 'analytics' : d.source };
  // Lower bound: today's gains across live posts.
  const partial = await gainsToday(today);
  return partial > 0 ? { value: partial, source: 'partial' } : { value: 0, source: 'none' };
}

async function gainsToday(today: string): Promise<number> {
  const start = new Date(today + 'T00:00:00Z').getTime();
  const posts = await allPosts();
  let sum = 0;
  for (const p of posts) {
    if (hoursBetween(p.publishedAt, new Date()) > 72) continue;
    const ss = await snapshotsFor(p.urn);
    if (!ss.length) continue;
    const latest = latestSnapshot(ss)!;
    const before = [...ss].reverse().find(s => new Date(s.observedAt).getTime() < start);
    const publishedToday = new Date(p.publishedAt).getTime() >= start;
    if (!before && !publishedToday) continue; // no baseline: the whole count is not today's gain
    sum += Math.max(latest.impressions - (before?.impressions ?? 0), 0);
  }
  return sum;
}

export async function paceFor(settings: Settings, model: ModelState, today: string): Promise<number> {
  const daily = await allDaily();
  const month = today.slice(0, 7);
  const recorded = daily.filter(d => d.utcDate.startsWith(month) && d.utcDate < today).reduce((a, d) => a + d.impressions, 0);
  const remainingDays = daysInMonthUtc(today) - Number(today.slice(8, 10)) + 1;
  const last3 = daily.filter(d => d.utcDate < today).slice(-3).map(d => d.impressions);
  return paceOf(settings.goal, recorded, remainingDays, last3, weekdayOfUtcDate(today), model.dow);
}

/** Readings from closed days in the last 21 days, paired with the day's final value. */
async function dayReadingPairs(now: Date): Promise<{ u: number; value: number; actual: number }[]> {
  const today = utcDateOf(now);
  const from = addDaysUtc(today, -21);
  const finals = (await allDaily()).filter(d => d.final && d.utcDate >= from && d.utcDate < today);
  const pairs: { u: number; value: number; actual: number }[] = [];
  for (const d of finals) {
    for (const r of await readingsFor(d.utcDate)) {
      if (r.source === 'partial' || utcDateOf(r.observedAt) !== d.utcDate) continue;
      pairs.push({ u: utcHourOf(r.observedAt), value: r.value, actual: d.impressions });
    }
  }
  return pairs;
}

export async function computeDayView(now = new Date()): Promise<DayForecastView> {
  const today = utcDateOf(now);
  const model = await getModel();
  const settings = await getSettings();
  const tz = await timezone();
  const dn = await dailyNowFor(today, now);
  const u = utcHourOf(now);
  const pairs = await dayReadingPairs(now);
  const sdFor = (uu: number) => {
    const m = measuredDaySd(pairs, uu, model.sDay);
    return m ? { sd: m.sd, measured: true } : { sd: priorDaySd(Math.max(interp(model.sDay, uu), 0.02)), measured: false };
  };
  const here = sdFor(u);
  const start0 = new Date(today + 'T00:00:00Z').getTime();
  const todaysPosts = (await allPosts()).filter(p => { const t = new Date(p.publishedAt).getTime(); return t >= start0 && t <= now.getTime(); });
  // Top-down: the day curve, shifted to when today's first post actually went out (the prior
  // assumes 07:30 UTC; a 13:00 post makes the same count mean a much younger day).
  let sDayToday = model.sDay;
  if (todaysPosts.length) {
    const firstHour = Math.min(...todaysPosts.map(p => utcHourOf(p.publishedAt)));
    const usual = Math.min(...Object.keys(model.sDay).map(Number)) + 1.5; // first key + 1.5h ≈ the curve's implied post hour
    if (firstHour - usual > 1) sDayToday = shiftSDay(model.sDay, 7.5 + (firstHour - usual));
  }
  const curveShare = Math.max(interp(sDayToday, u), 0.02);
  const curve = dailyEod(u, dn.value, { sDay: sDayToday, sd: here.sd });
  // Bottom-up: today's count plus what each live post still earns before UTC midnight, anchored
  // on each post's own count (no pull toward the account median once 3h of data exist).
  let remaining = 0, liveN = 0;
  const breakdown: DayForecastView['breakdown'] = [];
  const hToMid = 24 - u;
  for (const p of (await allPosts()).filter(p => hoursBetween(p.publishedAt, now) < 48 && hoursBetween(p.publishedAt, now) >= 0)) {
    const v = await computePostView(p.urn, undefined, now);
    if (!v) continue;
    liveN++;
    let r: number;
    let capped = false;
    if (v.hours > 24) {
      r = Math.max(v.point - v.impressions, 0);
      if (v.gainPerHour !== undefined) { const byRate = Math.max(v.gainPerHour, 0) * hToMid; if (byRate < r) { r = byRate; capped = true; } }
    } else {
      const sNow = shareAt(model.sPost, v.hours);
      const scale = v.hours >= 3 ? v.impressions / sNow : (v.total24 ?? v.impressions / sNow);
      r = Math.max(0, (shareAt(model.sPost, v.hours + hToMid) - sNow) * scale);
    }
    remaining += r;
    breakdown.push({ urn: p.urn, label: (p.textPreview ?? `Post from ${fmtLocalTime(p.publishedAt, tz)}`).replace(/\s+/g, ' ').slice(0, 40), hours: v.hours, remaining: r, capped });
  }
  breakdown.sort((a, b) => b.remaining - a.remaining);
  const usePosts = liveN > 0 && dn.source !== 'none';
  // Blend in log space. The more of the day the curve has seen, the more it counts.
  const wc = usePosts ? Math.min(0.9, Math.max(0.35, curveShare)) : 1;
  const postsPoint = dn.value + remaining;
  const point = usePosts && postsPoint > 0 ? Math.exp(wc * Math.log(Math.max(curve.point, 1)) + (1 - wc) * Math.log(postsPoint)) : curve.point;
  const f = { point, low: point * Math.exp(-1.28 * here.sd), high: point * Math.exp(1.28 * here.sd), share: curve.share };
  breakdown.unshift({ urn: '', label: `Day curve${sDayToday !== model.sDay ? ', shifted to today\'s first post' : ''}`, hours: -1, remaining: curve.point, capped: false });
  breakdown.push({ urn: '', label: 'Posts method total', hours: -2, remaining: postsPoint, capped: false });
  const offsetH = tzOffsetMinutes(now, tz) / 60;
  const rangeByHour = [8, 10, 12, 14, 16, 18, 20, 22].map(localH => ({ localHour: localH, pct: Math.exp(1.28 * sdFor(((localH - offsetH) % 24 + 24) % 24).sd) - 1 }));
  const rangeDays = new Set(pairs.map(p => Math.round(p.actual))).size;
  const pace = await paceFor(settings, model, today);
  const start = new Date(today + 'T00:00:00Z').getTime();
  const posts = (await allPosts()).filter(p => new Date(p.publishedAt).getTime() >= start && new Date(p.publishedAt).getTime() <= now.getTime());
  let fromTodayPosts = 0;
  for (const p of posts) {
    const l = latestSnapshot(await snapshotsFor(p.urn));
    if (l) fromTodayPosts += l.impressions;
  }
  const regime = regimeOf(model.nPostActuals);
  const hoursBefore = postByHoursBeforeMidnight(model.sPost);
  const postByUtc = new Date(start + (24 - hoursBefore) * HOUR);
  const firstKey = Math.min(...Object.keys(model.sDay).map(Number));
  const early = u < firstKey;
  const view: DayForecastView = {
    utcDate: today, u, dailyNow: dn.value, dailyNowSource: dn.source, early,
    point: dn.source === 'none' || early ? NaN : f.point, low: f.low, high: f.high, pace,
    fromTodayPosts, fromTails: Math.max(dn.value - fromTodayPosts, 0), regime,
    postByLocal: fmtLocalTime(postByUtc, tz),
    rangePct: Math.exp(1.28 * here.sd) - 1, rangeByHour, rangeSource: here.measured ? 'measured' : 'prior', rangeDays,
    method: usePosts ? 'posts' : 'curve', breakdown,
  };
  return view;
}

/** Last 7 completed days plus today, for the analytics-card chart. */
export async function dayHistory(now = new Date(), days = 7): Promise<{ utcDate: string; impressions: number; today: boolean }[]> {
  const today = utcDateOf(now);
  const n = Math.max(2, Math.min(days, 366));
  const daily = (await allDaily()).filter(d => d.utcDate < today).slice(-(n - 1));
  const dn = await dailyNowFor(today, now);
  return [...daily.map(d => ({ utcDate: d.utcDate, impressions: d.impressions, today: false })), { utcDate: today, impressions: dn.value, today: true }];
}

export async function logDayForecasts(now = new Date()) {
  const today = utcDateOf(now);
  const model = await getModel();
  const settings = await getSettings();
  const v = await computeDayView(now);
  const regime = regimeOf(model.nPostActuals);
  if (v.dailyNowSource !== 'none' && v.dailyNowSource !== 'partial' && !v.early) {
    const s = Math.max(interp(model.sDay, v.u), 0.02);
    await logForecast({ target: 'day', key: today, horizon: 'eod', point: v.point, low: v.low, high: v.high, shareObserved: s, regime });
  }
  const daily = await allDaily();
  const rd = model.recentDaily.length >= 3 ? model.recentDaily : daily.filter(d => d.final).slice(-7).map(d => d.impressions);
  if (rd.length >= 3) {
    const tomorrow = addDaysUtc(today, 1);
    const noPost = settings.noPostToday === tomorrow;
    const p = dayAhead(rd, weekdayOfUtcDate(tomorrow), model.dow, noPost);
    const sd = 0.30;
    await logForecast({ target: 'day', key: tomorrow, horizon: 'dayahead', point: p, low: p * Math.exp(-1.28 * sd), high: p * Math.exp(1.28 * sd), shareObserved: 0, regime });
  }
}

export async function livePosts(now = new Date()): Promise<PostForecastView[]> {
  const posts = (await allPosts()).filter(p => hoursBetween(p.publishedAt, now) < 48);
  const out: PostForecastView[] = [];
  for (const p of posts) {
    const v = await computePostView(p.urn, undefined, now);
    if (v) out.push(v);
  }
  return out.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
}

// ---------- goal decision ----------

export async function goalView(now = new Date()): Promise<GoalView> {
  const settings = await getSettings();
  const model = await getModel();
  const tz = await timezone();
  const today = utcDateOf(now);
  const day = await computeDayView(now);
  const daily = await allDaily();
  const month = today.slice(0, 7);
  const recordedMonth = daily.filter(d => d.utcDate.startsWith(month) && d.utcDate < today).reduce((a, d) => a + d.impressions, 0);
  const dim = daysInMonthUtc(today);
  const dom = Number(today.slice(8, 10));
  const daysLeft = dim - dom + 1;
  const target = settings.goal.kind === 'monthly' ? settings.goal.value : settings.goal.kind === 'daily' ? settings.goal.value * dim : 0;
  const todayEod = Number.isFinite(day.point) ? day.point : day.dailyNow;
  const paceNeeded = target > 0 ? Math.max(target - recordedMonth, 0) / daysLeft : 0;
  const expectedByNow = target > 0 ? target * (dom - 1 + Math.min(day.u / 24, 1)) / dim : 0;
  const start = new Date(today + 'T00:00:00Z').getTime();
  const postedToday = (await allPosts()).filter(p => new Date(p.publishedAt).getTime() >= start && new Date(p.publishedAt).getTime() <= now.getTime()).length;
  const recent = await recentTotalsFor(model);
  const slot = await bestSlot(now);
  const lh = localHour(now, tz);
  const slotUtcOffsetH = (lh - utcHourOf(now) + 48) % 24;
  const hRemaining = 24 - ((slot - slotUtcOffsetH + 24) % 24);
  const secondPostAdd = recent.length ? secondPostAddFn(median(recent), hRemaining, model.sPost) : 0;
  // One post in hand: today at 18:00 (or the next whole hour) versus tomorrow at the usual hour.
  let scenario: GoalView['scenario'];
  if (recent.length && lh < 22) {
    const slotToday = lh < 18 ? 18 : Math.ceil(lh + 0.01);
    const hWaitToday = slotToday - lh;
    const all = await allPosts();
    const usual = all.filter(p => p.timeTrusted).slice(-10).map(p => localHour(p.publishedAt, tz));
    const tomorrowHour = usual.length >= 3 ? Math.round(median(usual)) : 9;
    const hWaitTomorrow = 24 - lh + tomorrowHour;
    const hToMidnight = 24 - utcHourOf(now);
    const earlier: [number, number][] = [];
    for (const p of all) {
      const t = new Date(p.publishedAt).getTime();
      if (t < start || t > now.getTime()) continue;
      const v = await computePostView(p.urn, undefined, now);
      if (v?.total24) earlier.push([v.hours, v.total24]);
    }
    const sc = postTimingScenario(median(recent), hWaitToday, hToMidnight, hWaitTomorrow, earlier, model.sPost);
    const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
    scenario = { slotLocal: hh(slotToday), tomorrowLocal: hh(tomorrowHour), second: earlier.length > 0, ...sc };
  }
  let verdict: GoalView['verdict'];
  if (target <= 0) verdict = 'set-target';
  else if (postedToday === 0) verdict = 'post-first';
  else if (todayEod >= paceNeeded) verdict = 'on-pace';
  else if (lh >= 19) verdict = 'too-late';
  else verdict = 'post-again';
  return {
    target, recordedMonth, todayEod, monthEod: recordedMonth + todayEod, daysLeft, paceNeeded, expectedByNow, postedToday,
    verdict, secondPostAdd, bestSlot: slot, postByLocal: day.postByLocal, suggestion: await goalSuggestion(), scenario,
  };
}

// ---------- accuracy (§7) ----------

export interface AccuracyStats {
  byHorizon: Record<string, { n: number; mape: number; coverage: number }>;
  byShare: Record<string, { n: number; mape: number }>;
  byType: Record<string, { n: number; mape: number }>;
  eodErrors: { utcDate: string; errorPct: number }[];
  sdScale: { post: number; day: number };
}

export async function accuracyStats(now = new Date()): Promise<AccuracyStats> {
  const cutoff = new Date(now.getTime() - 14 * 24 * HOUR).toISOString();
  const fs = (await allForecasts()).filter(f => f.actual !== undefined && f.createdAt >= cutoff);
  const model = await getModel();
  const agg = (xs: ForecastRecord[]) => ({
    n: xs.length,
    mape: xs.length ? mean(xs.map(f => Math.abs(f.errorPct!))) : NaN,
    coverage: xs.length ? xs.filter(f => f.inBand).length / xs.length : NaN,
  });
  const byHorizon: AccuracyStats['byHorizon'] = {};
  for (const h of ['24h', 'eod', 'dayahead']) byHorizon[h] = agg(fs.filter(f => f.horizon === h));
  const buckets: [string, (s: number) => boolean][] = [
    ['<0.25', s => s < 0.25], ['0.25-0.5', s => s >= 0.25 && s < 0.5], ['0.5-0.8', s => s >= 0.5 && s < 0.8], ['>0.8', s => s >= 0.8],
  ];
  const byShare: AccuracyStats['byShare'] = {};
  for (const [k, fn] of buckets) { const a = agg(fs.filter(f => f.horizon !== 'dayahead' && fn(f.shareObserved))); byShare[k] = { n: a.n, mape: a.mape }; }
  const byType: AccuracyStats['byType'] = {};
  for (const t of ['video', 'image', 'text', 'document', 'unknown'] as PostType[]) {
    const a = agg(fs.filter(f => f.target === 'post' && f.postType === t));
    if (a.n) byType[t] = { n: a.n, mape: a.mape };
  }
  const eod = new Map<string, ForecastRecord>();
  for (const f of fs.filter(f => f.horizon === 'eod')) {
    const cur = eod.get(f.key);
    // Keep the mid-afternoon forecast (share closest to 0.66) per day.
    if (!cur || Math.abs(f.shareObserved - 0.66) < Math.abs(cur.shareObserved - 0.66)) eod.set(f.key, f);
  }
  const eodErrors = Array.from(eod.values()).sort((a, b) => (a.key < b.key ? -1 : 1)).map(f => ({ utcDate: f.key, errorPct: f.errorPct! }));
  return { byHorizon, byShare, byType, eodErrors, sdScale: model.sdScale };
}

// ---------- onboarding model init (§3.1 step 6) ----------

export async function initModelFromData(): Promise<{ baseline: number; bestHours: number[]; regime: Regime }> {
  const model = await getModel();
  const posts = (await allPosts()).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const tz = await timezone();
  const utcHours = posts.filter(p => !p.publishedApprox).slice(0, 10).map(p => utcHourOf(p.publishedAt));
  let next: ModelState = { ...model };
  if (utcHours.length >= 3 && model.recentDaily.length === 0) next.sDay = shiftSDay(model.sDay, median(utcHours));
  const daily = (await allDaily()).filter(d => d.final).slice(-14);
  if (next.recentDaily.length === 0 && daily.length) next.recentDaily = daily.map(d => d.impressions);
  await setModel(next);
  const recent = await recentTotalsFor(next);
  const baseline = recent.length ? median(recent) : NaN;
  // Best hours: local publish hours ranked by first-hour reading, or by lifetime when no early reading.
  const byHour = new Map<number, number[]>();
  for (const p of posts) {
    const ss = await snapshotsFor(p.urn);
    const pts: [number, number][] = ss.map(s => [hoursBetween(p.publishedAt, s.observedAt), s.impressions]);
    const score = pts.some(([h]) => h <= 3) ? interpAtHour(pts, 1) : (p.lifetime ?? p.actual24h ?? 0);
    if (!score) continue;
    const lh = Math.floor(localHour(p.publishedAt, tz));
    byHour.set(lh, [...(byHour.get(lh) ?? []), score]);
  }
  const bestHours = Array.from(byHour).map(([h, xs]) => [h, mean(xs)] as const).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
  return { baseline, bestHours, regime: regimeOf(next.nPostActuals) };
}

function interpAtHour(pts: [number, number][], h: number): number {
  const sorted = pts.sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return 0;
  if (h <= sorted[0][0]) return sorted[0][1] * Math.max(interp({ '1': 0.18, '2': 0.30, '3': 0.40 }, h) / Math.max(interp({ '1': 0.18, '2': 0.30, '3': 0.40 }, sorted[0][0]), 0.02), 0);
  for (let i = 1; i < sorted.length; i++) if (h <= sorted[i][0]) {
    const [a, va] = sorted[i - 1], [b, vb] = sorted[i];
    return va + (vb - va) * (h - a) / (b - a);
  }
  return sorted[sorted.length - 1][1];
}

/** Median first-hour reading across stored posts (for nudge #1 labels). */
export async function medianFirstHour(): Promise<number | null> {
  const posts = await allPosts();
  const xs: number[] = [];
  for (const p of posts) {
    const ss = await snapshotsFor(p.urn);
    const pts: [number, number][] = ss.map(s => [hoursBetween(p.publishedAt, s.observedAt), s.impressions]);
    if (pts.some(([h]) => h >= 0.5 && h <= 3)) xs.push(interpAtHour(pts, 1));
  }
  return xs.length ? median(xs) : null;
}

/** Best posting slot (§8): next whole local hour in 07..18 with the highest historical first-hour reading. */
export async function bestSlot(now = new Date()): Promise<number> {
  const tz = await timezone();
  const posts = await allPosts();
  const byHour = new Map<number, number[]>();
  for (const p of posts) {
    const ss = await snapshotsFor(p.urn);
    const pts: [number, number][] = ss.map(s => [hoursBetween(p.publishedAt, s.observedAt), s.impressions]);
    if (!pts.some(([h]) => h >= 0.5 && h <= 3)) continue;
    const lh = Math.floor(localHour(p.publishedAt, tz));
    byHour.set(lh, [...(byHour.get(lh) ?? []), interpAtHour(pts, 1)]);
  }
  const total = Array.from(byHour.values()).reduce((a, xs) => a + xs.length, 0);
  const nowH = Math.ceil(localHour(now, tz));
  if (total < 5) return Math.max(nowH, 17) <= 18 ? Math.max(nowH, 17) : 17;
  let best = -1, bv = -Infinity;
  for (let h = Math.max(nowH, 7); h <= 18; h++) {
    const v = byHour.has(h) ? mean(byHour.get(h)!) : -1;
    if (v > bv) { bv = v; best = h; }
  }
  return best >= 0 ? best : 17;
}

export async function goalSuggestion(): Promise<number> {
  const daily = (await allDaily()).filter(d => d.final).slice(-7);
  return daily.length ? Math.round(mean(daily.map(d => d.impressions)) * 30) : 0;
}

export { tzOffsetMinutes, utcDateOf };
export type { DailyReading };
