/** §8 nudges: quiet hours, daily cap, dedupe per (type, key, day). */
import { addNudge, allNudges, allDaily, forecastsFor, getPost, snapshotsFor, allPosts, putNudge } from './store';
import { getSettings, getModel, getLocal, setLocal, timezone } from './state';
import { accuracyStats, bestSlot, computeDayView, computePostView, medianFirstHour, latestSnapshot, paceFor, recentTotalsFor } from './engine';
import { evalTail, median, secondPostAdd, secondPostVerdict, interp } from '../model/simple';
import { fmt } from '../shared/numbers';
import { addDaysUtc, hoursBetween, inQuietHours, localHour, localWeekday, utcDateOf, utcHourOf } from '../shared/time';

const POST_URL = (urn: string) => `https://www.linkedin.com/feed/update/urn:li:activity:${urn}/`;
const FEED_URL = 'https://www.linkedin.com/feed/';
const COMPOSE_URL = 'https://www.linkedin.com/feed/?shareActive=true';

async function canFire(type: string, key: string, now: Date): Promise<boolean> {
  const settings = await getSettings();
  const tz = await timezone();
  const lh = localHour(now, tz);
  if (inQuietHours(lh, settings.quietHours.start, settings.quietHours.end)) return false;
  const nudges = await allNudges();
  const dayKey = localDayKey(now, tz);
  const today = nudges.filter(n => localDayKey(n.firedAt, tz) === dayKey);
  if (today.length >= settings.notifCap) return false;
  if (today.some(n => n.type === type && n.key === key)) return false;
  return true;
}

function localDayKey(d: Date | string, tz?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}

export async function fire(type: string, key: string, text: string, actionTitle: string, url: string, now = new Date()) {
  if (!(await canFire(type, key, now))) return false;
  const id = await addNudge({ type, firedAt: now.toISOString(), key, text, clicked: false });
  const nid = `lif:${String(id)}`;
  const actions = await getLocal<Record<string, { url: string; id: number }>>('nudgeActions', {});
  actions[nid] = { url, id: Number(id) };
  await setLocal('nudgeActions', actions);
  try {
    await chrome.notifications.create(nid, {
      type: 'basic', iconUrl: 'icons/icon128.png', title: 'LinkedIn forecast', message: text,
      buttons: [{ title: actionTitle }], priority: 1,
    });
  } catch (e) { console.warn('[lif] notification failed', e); }
  return true;
}

export async function onNotificationClick(nid: string) {
  const actions = await getLocal<Record<string, { url: string; id: number }>>('nudgeActions', {});
  const a = actions[nid];
  if (!a) return;
  if (a.url === 'popup') { try { await chrome.action.openPopup(); } catch { await chrome.tabs.create({ url: FEED_URL }); } }
  else await chrome.tabs.create({ url: a.url });
  const n = (await allNudges()).find(x => x.id === a.id);
  if (n) { n.clicked = true; await putNudge(n); }
  chrome.notifications.clear(nid);
}

// ---- #1 / #1b golden hour check at t+60 ----
export async function goldenHourCheck(urn: string, now = new Date()) {
  const post = await getPost(urn);
  if (!post) return;
  const snaps = await snapshotsFor(urn);
  const win = snaps.filter(s => { const h = hoursBetween(post.publishedAt, s.observedAt); return h >= 50 / 60 && h <= 70 / 60; });
  const settings = await getSettings();
  if (!win.length) {
    if (!settings.autoVisit.enabled) await fire('golden1b', urn, 'Open your post once so I can read the first hour.', 'Open post', POST_URL(urn), now);
    return;
  }
  const n = win[win.length - 1].impressions;
  const med = await medianFirstHour();
  let label = 'average';
  if (med && med > 0) label = n < 0.7 * med ? 'slow' : n > 1.3 * med ? 'strong' : 'average';
  await fire('golden1', urn, `Post at ${fmt(n)} after 1h: ${label} start for you. Push 5 comments on other posts now.`, 'Open post', POST_URL(urn), now);
  await setLocal(`golden1:${urn}`, { point: (await computePostView(urn, snaps, now))?.point ?? null, med });
}

// ---- #2 golden hour close at t+120 ----
export async function goldenHourClose(urn: string, now = new Date()) {
  const post = await getPost(urn);
  if (!post) return;
  const snaps = await snapshotsFor(urn);
  const latest = latestSnapshot(snaps);
  if (!latest) return;
  const view = await computePostView(urn, snaps, now);
  if (!view) return;
  const prev = await getLocal<{ point: number | null; med: number | null }>(`golden1:${urn}`, { point: null, med: null });
  const model = await getModel();
  const recent = await recentTotalsFor(model);
  const medTotal = recent.length ? median(recent) : null;
  const moved = prev.point ? Math.abs(view.point - prev.point) / prev.point > 0.15 : true;
  const crossed = prev.point && medTotal ? (prev.point < medTotal) !== (view.point < medTotal) : false;
  if (!moved && !crossed) return;
  const inNet = latest.inNetworkShare !== undefined ? `, ${Math.round(latest.inNetworkShare * 100)}% in-network: ${latest.inNetworkShare < 0.55 ? 'travelling' : 'mostly your network'}` : '';
  await fire('golden2', urn, `${fmt(latest.impressions)} at 2h${inNet}. ${fmt(view.point)} by end of day.`, 'Open post', POST_URL(urn), now);
}

// ---- #3 second post decision ----
export async function secondPostCheck(now = new Date()) {
  const tz = await timezone();
  const wd = localWeekday(now, tz);
  if (wd >= 5) return;
  const today = utcDateOf(now);
  const start = new Date(today + 'T00:00:00Z').getTime();
  const posts = (await allPosts()).filter(p => new Date(p.publishedAt).getTime() >= start && new Date(p.publishedAt).getTime() <= now.getTime())
    .sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1));
  if (posts.length !== 1) return;
  const first = posts[0];
  const snaps = await snapshotsFor(first.urn);
  if (snaps.length < 2) return;
  const pts: [number, number][] = snaps.map(s => [hoursBetween(first.publishedAt, s.observedAt), s.impressions]);
  const hNow = hoursBetween(first.publishedAt, now);
  const tail = evalTail(pts, hNow);
  const lh = localHour(now, tz);
  const verdict = secondPostVerdict(tail.tailMode || lh >= 15.5, lh);
  if (verdict !== 'post') return;
  const day = await computeDayView(now);
  if (Number.isFinite(day.point) && day.point >= day.pace) return;
  const model = await getModel();
  const recent = await recentTotalsFor(model);
  if (!recent.length) return;
  const slot = await bestSlot(now);
  const slotUtcOffsetH = (localHour(now, tz) - utcHourOf(now) + 48) % 24;
  const hRemaining = 24 - ((slot - slotUtcOffsetH + 24) % 24);
  const add = secondPostAdd(median(recent), hRemaining, model.sPost);
  const gain = view_gain(pts, hNow);
  await fire('second', today,
    `First post at ${fmt(gain)}/h, tail mode. Day heading to ${fmt(day.point)} vs ${fmt(day.pace)} target. A post at ${String(slot).padStart(2, '0')}:00 adds about ${fmt(add)} today.`,
    'Open compose', COMPOSE_URL, now);
}

function view_gain(pts: [number, number][], hNow: number): number {
  const t = evalTail(pts, hNow);
  return t.lastHourGain;
}

// ---- #4 morning plan 08:00 ----
export async function morningPlan(now = new Date()) {
  const today = utcDateOf(now);
  const start = new Date(today + 'T00:00:00Z').getTime();
  const posts = (await allPosts()).filter(p => new Date(p.publishedAt).getTime() >= start);
  if (posts.length) return;
  const daily = (await allDaily()).filter(d => d.utcDate < today);
  if (!daily.length) return;
  const y = daily[daily.length - 1];
  const avg3 = daily.slice(-3).reduce((a, d) => a + d.impressions, 0) / Math.min(3, daily.length);
  const day = await computeDayView(now);
  await fire('morning', today, `Yesterday ${fmt(y.impressions)}. Last 3 days averaged ${fmt(avg3)}. Post by ${day.postByLocal} for a normal day.`, 'Open feed', FEED_URL, now);
}

// ---- #5 scorecard 09:00 ----
export async function scorecard(now = new Date()) {
  const today = utcDateOf(now);
  const y = addDaysUtc(today, -1);
  const daily = await allDaily();
  const yd = daily.find(d => d.utcDate === y && d.final);
  if (!yd) return;
  const fs = (await forecastsFor(y)).filter(f => f.horizon === 'eod' && f.actual !== undefined);
  if (!fs.length) return;
  const f = fs.sort((a, b) => Math.abs(a.shareObserved - 0.66) - Math.abs(b.shareObserved - 0.66))[0];
  const stats = await accuracyStats(now);
  const mape = stats.byHorizon['eod']?.mape;
  await fire('scorecard', y,
    `Yesterday: forecast ${fmt(f.point)}, actual ${fmt(yd.impressions)} (${(f.errorPct! * 100).toFixed(0)}%). 14-day error ${Number.isFinite(mape) ? (mape * 100).toFixed(0) : '–'}%.`,
    'Open popup', 'popup', now);
}

export { paceFor, interp };
