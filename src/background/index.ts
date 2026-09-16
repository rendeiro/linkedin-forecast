/** Background service worker: message router, alarm handlers, install hooks. State lives in storage. */
import type { ContentMessage, Post, Settings } from '../shared/types';
import {
  ingestSnapshot, ingestDaily, ingestTotal7, ingestPosts, ingestFollowers, computePostView, computeDayView, livePosts,
  accuracyStats, onNewPost, initModelFromData, goalSuggestion, logDayForecasts, ensurePost, dayHistory, rebuildModel,
} from './engine';
import { getSettings, setSettings, getModel, setModel, getOnboarding, setOnboarding, getHealth, timezone, getLocal, setLocal } from './state';
import { allDaily, allPosts, allSnapshots, dumpAll, restoreAll, clearAll, putDaily, putPost, getPost, addSnapshot, putFollower, allNudges, type Dump } from './store';
import { scheduleAlarms, runAnalyticsVisit, runPostVisits, forcedPostVisit, resolveVisit, recordHealth, avStatus, ANALYTICS_URL, postSummaryUrl } from './autovisit';
import { goldenHourCheck, goldenHourClose, secondPostCheck, morningPlan, scorecard, onNotificationClick } from './nudges';
import { initialModel, regimeOf, MODEL_VERSION } from '../model/simple';
import { nextLocalTime, utcDateOf, hoursBetween } from '../shared/time';
import type { ExportResult } from '../model/export';

// ---- daily local alarms ----
async function scheduleDailyAlarms() {
  const tz = await timezone();
  const set = async (name: string, h: number, m: number) => {
    await chrome.alarms.clear(name);
    await chrome.alarms.create(name, { when: nextLocalTime(h, m, tz).getTime() });
  };
  await set('daily-morning', 8, 0);
  await set('daily-scorecard', 9, 0);
  await set('daily-second', 15, 30);
  await chrome.alarms.create('tick', { periodInMinutes: 30 });
}

onNewPost(async (post: Post) => {
  const t0 = new Date(post.publishedAt).getTime();
  const settings = await getSettings();
  const mk = (name: string, min: number) => chrome.alarms.create(name, { when: Math.max(t0 + min * 60_000, Date.now() + 1000) });
  if (settings.autoVisit.enabled) { await mk(`av-force55:${post.urn}`, 55); await mk(`av-force115:${post.urn}`, 115); }
  await mk(`post60:${post.urn}`, 60);
  await mk(`post120:${post.urn}`, 120);
  await mk(`tail:${post.urn}`, 150);
});

chrome.alarms.onAlarm.addListener(async alarm => {
  const [name, arg] = alarm.name.split(':');
  try {
    switch (name) {
      case 'av-analytics': return void (await runAnalyticsVisit());
      case 'av-posts': return void (await runPostVisits());
      case 'av-force55': case 'av-force115': return void (await forcedPostVisit(arg));
      case 'post60': return void (await goldenHourCheck(arg));
      case 'post120': return void (await goldenHourClose(arg));
      case 'tail': {
        // Re-check tail mode every 30 min for the first post of the day until 15:30 fires.
        await secondPostCheck();
        const post = await getPost(arg);
        if (post && hoursBetween(post.publishedAt, new Date()) < 10) await chrome.alarms.create(`tail:${arg}`, { delayInMinutes: 30 });
        return;
      }
      case 'daily-morning': await morningPlan(); return void (await scheduleDailyAlarms());
      case 'daily-scorecard': await scorecard(); return void (await scheduleDailyAlarms());
      case 'daily-second': await secondPostCheck(); return void (await scheduleDailyAlarms());
      case 'tick': return void (await logDayForecasts());
    }
  } catch (e) { console.warn('[lif] alarm failed', alarm.name, e); }
});

async function ensureModelVersion() {
  const rebuilt = await getLocal<number>('modelRebuilt', 0);
  if (rebuilt !== MODEL_VERSION) {
    const r = await rebuildModel();
    console.info('[lif] model rebuilt', r);
    await setLocal('modelRebuilt', MODEL_VERSION);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await getSettings().then(setSettings);
  const m = await getLocal('model', null);
  if (!m) await setModel(initialModel());
  await ensureModelVersion();
  await scheduleDailyAlarms();
  await scheduleAlarms();
});
chrome.runtime.onStartup.addListener(async () => { await ensureModelVersion(); await scheduleDailyAlarms(); await scheduleAlarms(); });

chrome.notifications.onButtonClicked.addListener(id => { void onNotificationClick(id); });
chrome.notifications.onClicked.addListener(id => { void onNotificationClick(id); });

// ---- messages ----
export type UiMessage =
  | { type: 'ui:getState' }
  | { type: 'ui:setSettings'; payload: Settings }
  | { type: 'ui:onboarding'; payload: { action: 'openAnalytics' | 'readPosts' | 'setGoal' | 'finish'; goal?: Settings['goal'] } }
  | { type: 'ui:visitNow' }
  | { type: 'ui:export' }
  | { type: 'ui:importJson'; payload: Dump }
  | { type: 'ui:importExport'; payload: ExportResult }
  | { type: 'ui:reset' }
  | { type: 'ui:rebuild' }
  | { type: 'ui:debug' };

type AnyMessage = ContentMessage | UiMessage;

chrome.runtime.onMessage.addListener((msg: AnyMessage, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, e => { console.warn('[lif] handler failed', msg.type, e); sendResponse({ error: String(e) }); });
  return true;
});

async function handle(msg: AnyMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'snapshot': {
      const view = await ingestSnapshot(msg.payload);
      await maybeAdvanceOnboarding();
      return { view };
    }
    case 'daily': await ingestDaily(msg.payload.points, msg.payload.observedAt, msg.payload.timezone, msg.payload.profileId); return { ok: true };
    case 'total7': await ingestTotal7(msg.payload.value, msg.payload.observedAt); return { ok: true };
    case 'posts': await ingestPosts(msg.payload.posts, msg.payload.topPosts); return { ok: true };
    case 'followers': await ingestFollowers(msg.payload.points); return { ok: true };
    case 'health': {
      await recordHealth(msg.payload.page, msg.payload.ok, msg.payload.error, msg.payload.path);
      if (sender.tab?.id !== undefined) resolveVisit(sender.tab.id, msg.payload.ok);
      return { ok: true };
    }
    case 'forecast:post': {
      const settings = await getSettings();
      if (!settings.overlay) return { enabled: false };
      return { enabled: true, view: await computePostView(msg.payload.urn) };
    }
    case 'forecast:day': {
      const settings = await getSettings();
      if (!settings.overlay) return { enabled: false };
      return { enabled: true, view: await computeDayView(), history: await dayHistory() };
    }
    case 'ui:getState': return uiState();
    case 'ui:setSettings': {
      const prev = await getSettings();
      await setSettings(msg.payload);
      if (JSON.stringify(prev.autoVisit) !== JSON.stringify(msg.payload.autoVisit) || prev.quietHours !== msg.payload.quietHours) await scheduleAlarms(msg.payload);
      if (prev.tzOverride !== msg.payload.tzOverride) await scheduleDailyAlarms();
      return { ok: true };
    }
    case 'ui:onboarding': return onboardingAction(msg.payload);
    case 'ui:visitNow': { await runAnalyticsVisit(); await runPostVisits(); return { ok: true }; }
    case 'ui:export': {
      const local = await chrome.storage.local.get(null);
      return dumpAll(local);
    }
    case 'ui:importJson': {
      await restoreAll(msg.payload);
      const local = msg.payload.local ?? {};
      for (const k of ['settings', 'model', 'onboarding', 'captureHealth']) if (k in local) await setLocal(k, local[k]);
      return { ok: true };
    }
    case 'ui:importExport': return importExport(msg.payload);
    case 'ui:reset': {
      await clearAll();
      await chrome.storage.local.clear();
      await setModel(initialModel());
      await getSettings().then(setSettings);
      await chrome.alarms.clearAll();
      await scheduleDailyAlarms();
      await scheduleAlarms();
      return { ok: true };
    }
    case 'ui:rebuild': { const r = await rebuildModel(); await setLocal('modelRebuilt', MODEL_VERSION); return { ok: true, ...r }; }
    case 'ui:debug': return { snapshots: (await allSnapshots()).slice(-200), daily: await allDaily(), posts: await allPosts(), nudges: await allNudges() };
  }
  return { error: 'unknown message' };
}

async function uiState() {
  const now = new Date();
  const settings = await getSettings();
  const model = await getModel();
  const onboarding = await getOnboarding();
  const health = await getHealth();
  const daily = await allDaily();
  const [today, live, accuracy, av] = await Promise.all([computeDayView(now), livePosts(now), accuracyStats(now), avStatus()]);
  const posts = await allPosts();
  return {
    now: now.toISOString(), settings, onboarding, health, today, live, accuracy, autovisit: av,
    model: { regime: regimeOf(model.nPostActuals), nPostActuals: model.nPostActuals, recentTotals: model.recentTotals, recentDaily: model.recentDaily, sdScale: model.sdScale },
    daily: daily.slice(-28),
    goalSuggestion: await goalSuggestion(),
    postsToRead: (onboarding.postsToRead ?? []).map(urn => ({ urn, read: (onboarding.postsRead ?? []).includes(urn), url: postSummaryUrl(urn), post: posts.find(p => p.urn === urn) })),
    timezone: await timezone(),
    analyticsUrl: ANALYTICS_URL,
  };
}

async function maybeAdvanceOnboarding() {
  const ob = await getOnboarding();
  if (ob.done || !ob.postsToRead?.length) return;
  const snaps = await allSnapshots();
  const withSnap = new Set(snaps.map(s => s.urn));
  ob.postsRead = ob.postsToRead.filter(u => withSnap.has(u));
  await setOnboarding(ob);
}

async function onboardingAction(p: { action: string; goal?: Settings['goal'] }) {
  const ob = await getOnboarding();
  switch (p.action) {
    case 'openAnalytics':
      await chrome.tabs.create({ url: ANALYTICS_URL, active: true });
      ob.step = Math.max(ob.step, 1);
      await setOnboarding(ob);
      return { ok: true };
    case 'readPosts': {
      const settings = await getSettings();
      if (!settings.autoVisit.enabled) return { ok: false, reason: 'auto-visit off' };
      const list = ob.postsToRead ?? [];
      const snaps = await allSnapshots();
      const done = new Set(snaps.map(s => s.urn));
      for (const urn of list) {
        if (done.has(urn)) continue;
        await forcedPostVisit(urn);
        await maybeAdvanceOnboarding();
      }
      return { ok: true };
    }
    case 'setGoal': {
      const s = await getSettings();
      if (p.goal) s.goal = p.goal;
      await setSettings(s);
      ob.step = Math.max(ob.step, 5);
      await setOnboarding(ob);
      return { ok: true };
    }
    case 'finish': {
      const summary = await initModelFromData();
      ob.done = true; ob.step = 6;
      await setOnboarding(ob);
      await scheduleAlarms();
      return { ok: true, summary };
    }
  }
  return { ok: false };
}

async function importExport(r: ExportResult) {
  const now = new Date().toISOString();
  const today = utcDateOf(now);
  for (const d of r.daily) {
    await putDaily({ utcDate: d.utcDate, impressions: d.impressions, engagements: d.engagements, final: d.utcDate < today, source: 'export', updatedAt: now });
  }
  for (const p of r.posts) {
    const existing = await getPost(p.urn);
    if (existing) {
      existing.lifetime = Math.max(existing.lifetime ?? 0, p.lifetime);
      if (existing.publishedApprox && p.publishedAt && !p.publishedApprox) { existing.publishedAt = p.publishedAt; existing.publishedApprox = false; }
      await putPost(existing);
    } else {
      const { post } = await ensurePost({ urn: p.urn });
      if (p.publishedAt) { post.publishedAt = p.publishedAt; post.publishedApprox = p.publishedApprox; }
      post.lifetime = p.lifetime;
      await putPost(post);
      await addSnapshot({ urn: p.urn, observedAt: now, impressions: p.lifetime, source: 'export' });
    }
  }
  for (const f of r.followers) await putFollower(f);
  const model = await getModel();
  if (model.recentDaily.length === 0) {
    const finals = (await allDaily()).filter(d => d.final).slice(-14).map(d => d.impressions);
    await setModel({ ...model, recentDaily: finals });
  }
  const ob = await getOnboarding();
  if (!ob.done && ob.step < 2 && r.daily.length) { ob.step = 2; await setOnboarding(ob); }
  return { ok: true, daily: r.daily.length, posts: r.posts.length, followers: r.followers.length, notes: r.notes };
}
