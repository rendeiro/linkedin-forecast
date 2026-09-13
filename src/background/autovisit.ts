/** §3.3 auto-visit: background tabs to the user's own pages, backoff, daily cap. */
import type { PageType, Settings } from '../shared/types';
import { getLocal, setLocal, getSettings, getHealth, setHealth, timezone } from './state';
import { allPosts } from './store';
import { hoursBetween, inQuietHours, localHour, utcDateOf } from '../shared/time';

export const ANALYTICS_URL = 'https://www.linkedin.com/analytics/creator/content/';
export const postSummaryUrl = (urn: string) => `https://www.linkedin.com/analytics/post-summary/urn:li:activity:${urn}/`;

interface AvState { dayKey: string; count: number; failures: number; backoff: number; lastFailAt?: string; lastOkAt?: string; }
const DAILY_CAP = 60;
const TIMEOUT_MS = 15_000;

type Pending = { resolve: (ok: boolean) => void; page: PageType };
const pending = new Map<number, Pending>();

export function resolveVisit(tabId: number, ok: boolean) {
  const p = pending.get(tabId);
  if (p) { pending.delete(tabId); p.resolve(ok); }
}

async function getState(now: Date): Promise<AvState> {
  const s = await getLocal<AvState>('autovisit', { dayKey: '', count: 0, failures: 0, backoff: 1 });
  const dayKey = utcDateOf(now);
  if (s.dayKey !== dayKey) return { ...s, dayKey, count: 0 };
  return s;
}

export async function avStatus(): Promise<AvState> { return getState(new Date()); }

export async function visit(url: string, page: PageType, now = new Date()): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.autoVisit.enabled) return false;
  const tz = await timezone();
  if (inQuietHours(localHour(now, tz), settings.quietHours.start, settings.quietHours.end)) return false;
  const st = await getState(now);
  if (st.count >= DAILY_CAP) return false;
  st.count++;
  await setLocal('autovisit', st);

  let tabId: number | undefined;
  let ok = false;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (tabId === undefined) throw new Error('no tab id');
    ok = await new Promise<boolean>(resolve => {
      pending.set(tabId!, { resolve, page });
      setTimeout(() => { if (pending.has(tabId!)) { pending.delete(tabId!); resolve(false); } }, TIMEOUT_MS + 5000);
    });
  } catch (e) {
    console.warn('[lif] auto-visit failed', e);
  } finally {
    if (tabId !== undefined) { try { await chrome.tabs.remove(tabId); } catch { /* already closed */ } }
  }
  const after = await getState(new Date());
  if (ok) { after.failures = 0; after.backoff = 1; after.lastOkAt = new Date().toISOString(); }
  else { after.failures++; after.backoff = Math.min(after.backoff * 2, 8); after.lastFailAt = new Date().toISOString(); }
  await setLocal('autovisit', after);
  await updateBadge(after);
  await scheduleAlarms(settings, after);
  return ok;
}

export async function updateBadge(st?: AvState) {
  const s = st ?? (await getState(new Date()));
  const health = await getHealth();
  const failing = s.failures >= 2 || Object.values(health).some(h => h?.lastErrorAt && (!h.lastOkAt || h.lastErrorAt > h.lastOkAt) && hoursBetween(h.lastErrorAt, new Date()) < 6);
  try {
    await chrome.action.setBadgeText({ text: failing ? '!' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  } catch { /* no action API in tests */ }
}

/** (Re)create periodic alarms honoring backoff (interval doubles per failure, capped at 4h). */
export async function scheduleAlarms(settings?: Settings, st?: AvState) {
  const s = settings ?? (await getSettings());
  const state = st ?? (await getState(new Date()));
  await chrome.alarms.clear('av-analytics');
  await chrome.alarms.clear('av-posts');
  if (!s.autoVisit.enabled) return;
  const cap = 240;
  const a = Math.min(s.autoVisit.analyticsMin * state.backoff, cap);
  const p = Math.min(s.autoVisit.postMin * state.backoff, cap);
  await chrome.alarms.create('av-analytics', { delayInMinutes: 1, periodInMinutes: Math.max(a, 5) });
  await chrome.alarms.create('av-posts', { delayInMinutes: 2, periodInMinutes: Math.max(p, 5) });
}

export async function runAnalyticsVisit() {
  await visit(ANALYTICS_URL, 'analytics');
}

export async function runPostVisits() {
  const now = new Date();
  const posts = (await allPosts()).filter(p => hoursBetween(p.publishedAt, now) < 48 && hoursBetween(p.publishedAt, now) >= 0);
  for (const p of posts) {
    const ok = await visit(postSummaryUrl(p.urn), 'post_summary');
    if (!ok) break; // never retry more than once per failure; wait for the next cycle
  }
}

export async function forcedPostVisit(urn: string) {
  await visit(postSummaryUrl(urn), 'post_summary');
}

export async function recordHealth(page: PageType, ok: boolean, error?: string, path?: string) {
  const h = await getHealth();
  const cur = h[page] ?? {};
  const now = new Date().toISOString();
  if (ok) { cur.lastOkAt = now; cur.path = path; }
  else { cur.lastErrorAt = now; cur.lastError = error; cur.path = path; }
  h[page] = cur;
  await setHealth(h);
  await updateBadge();
}
