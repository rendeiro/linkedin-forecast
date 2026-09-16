import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { rpc } from '../rpc';
import { fmt, pct } from '../../shared/numbers';
import { fmtLocalTime } from '../../shared/time';
import type { DayForecastView, PostForecastView, Settings, Onboarding, CaptureHealth, Daily, GoalView } from '../../shared/types';
import type { AccuracyStats } from '../../background/engine';

interface State {
  now: string; settings: Settings; onboarding: Onboarding; health: CaptureHealth; today: DayForecastView; live: PostForecastView[];
  goal: GoalView; accuracy: AccuracyStats; autovisit: { count: number; failures: number; backoff: number; lastOkAt?: string; lastFailAt?: string };
  model: { regime: string; nPostActuals: number; recentTotals: number[]; recentDaily: number[]; sdScale: { post: number; day: number } };
  daily: Daily[]; goalSuggestion: number; timezone?: string; analyticsUrl: string;
  postsToRead: { urn: string; read: boolean; url: string; post?: { publishedAt: string; type: string; textPreview?: string } }[];
}

const REGIME_TIP: Record<string, string> = {
  priors: 'Fewer than 10 posts with a 24h actual. Forecasts use the prior curves. Intraday readings are where the value is; day-ahead runs 25 to 35% error.',
  calibrating: '10 to 29 posts with actuals. Curves are adapting to this account.',
  fitted: '30 or more posts with actuals. Curves are fitted to this account.',
};

function App() {
  const [s, setS] = useState<State | null>(null);
  const initial = (location.hash.slice(1) || 'today') as Tab;
  const [tab, setTab] = useState<Tab>((TABS as readonly string[]).includes(initial) ? initial : 'today');
  const [err, setErr] = useState('');
  const load = () => rpc<State>({ type: 'ui:getState' }).then(setS).catch(e => setErr(String(e)));
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);
  if (err) return <section><b>Cannot reach the background worker.</b><div class="dim">{err}</div></section>;
  if (!s) return <section class="dim">Loading…</section>;
  if (!s.onboarding.done) return <OnboardingView s={s} reload={load} />;
  return (
    <>
      <header>
        <h1>LinkedIn forecast</h1>
        <span class="tag" title={REGIME_TIP[s.model.regime]}>{s.model.regime}</span>
      </header>
      <nav>
        {TABS.map(t => <button class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </nav>
      {tab === 'today' && <Today s={s} reload={load} />}
      {tab === 'posts' && <Posts s={s} />}
      {tab === 'accuracy' && <Accuracy s={s} />}
      {tab === 'health' && <Health s={s} reload={load} />}
    </>
  );
}

const TABS = ['today', 'posts', 'accuracy', 'health'] as const;
type Tab = typeof TABS[number];

function Today({ s, reload }: { s: State; reload: () => void }) {
  const t = s.today, g = s.goal;
  const none = t.dailyNowSource === 'none';
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(g.target || g.suggestion);
  const save = async () => {
    await rpc({ type: 'ui:setSettings', payload: { ...s.settings, goal: { kind: 'monthly', value: Number(target) } } });
    setEditing(false); reload();
  };
  const verdict: Record<GoalView['verdict'], [string, string]> = {
    'set-target': ['Set a monthly target', `Suggestion from your last 7 days: ${fmt(g.suggestion)}.`],
    'post-first': ['No post yet today', `Post by ${g.postByLocal ?? '–'} for a normal day. Pace needed: ${fmt(g.paceNeeded)} a day.`],
    'on-pace': ['On pace. No second post needed', `Today heads to ${fmt(g.todayEod)} against ${fmt(g.paceNeeded)} needed a day.`],
    'post-again': ['Post again today', `Today heads to ${fmt(g.todayEod)}, ${fmt(g.paceNeeded - g.todayEod)} short of the ${fmt(g.paceNeeded)} needed a day. A post at ${String(g.bestSlot).padStart(2, '0')}:00 adds about ${fmt(g.secondPostAdd)}.`],
    'too-late': ['Below pace, too late for a second post', `Today heads to ${fmt(g.todayEod)} against ${fmt(g.paceNeeded)} needed a day. Tomorrow needs ${fmt((g.target - g.recordedMonth - g.todayEod) / Math.max(g.daysLeft - 1, 1))}.`],
  };
  const [head, body] = verdict[g.verdict];
  const pct = g.target > 0 ? Math.min(g.monthEod / g.target, 1) : 0;
  const pctNow = g.target > 0 ? Math.min(g.expectedByNow / g.target, 1) : 0;
  return (
    <section>
      <div class="dim">Daily impressions</div>
      <div class="big">{none ? '–' : fmt(t.dailyNow)} <span class="dim" style="font-size:15px; font-weight:400">now</span></div>
      {!none && !t.early && <div style="margin-top:4px"><b>{fmt(t.point)}</b> by end of day <span class="dim">({fmt(t.low)} to {fmt(t.high)})</span></div>}
      {!none && t.early && <div class="dim" style="margin-top:4px">End of day estimate from 06:00 UTC.</div>}
      {none && <div class="note" style="margin-top:8px">No reading for today yet. Open <a href={s.analyticsUrl} target="_blank">your analytics</a> once.</div>}

      <div class="decision">
        <div class="decision-head">{head}</div>
        <div class="dim">{body}</div>
      </div>

      <h2>Month</h2>
      {g.target > 0 && !editing ? (<>
        <div class="row"><span>Target</span><span><b>{fmt(g.target)}</b> <a href="#" onClick={e => { e.preventDefault(); setEditing(true); }}>edit</a></span></div>
        <div class="row"><span>Recorded so far</span><span>{fmt(g.recordedMonth)}</span></div>
        <div class="row"><span>With today's end of day</span><span>{fmt(g.monthEod)}</span></div>
        <div class="row"><span>Needed per day, {g.daysLeft} days left</span><b>{fmt(g.paceNeeded)}</b></div>
        <div class="progress" style="margin-top:10px; position:relative">
          <i style={`width:${pct * 100}%`} />
          <em style={`left:${pctNow * 100}%`} title="Where the month should be by now" />
        </div>
        <div class="dim" style="font-size:11px">Bar: month with today's end of day. Mark: where the month should be by now.</div>
      </>) : (<>
        <label>Monthly target (impressions)</label>
        <input type="number" value={target} onInput={e => setTarget(Number((e.target as HTMLInputElement).value))} />
        <div style="display:flex; gap:8px; margin-top:8px">
          <button class="primary" onClick={save}>Save</button>
          {g.target > 0 && <button class="ghost" onClick={() => setEditing(false)}>Cancel</button>}
        </div>
      </>)}

      <h2>Last 28 days</h2>
      <Bars daily={s.daily} />
    </section>
  );
}

function Bars({ daily }: { daily: Daily[] }) {
  const max = Math.max(1, ...daily.map(d => d.impressions));
  return (
    <div class="bars" title={daily.map(d => `${d.utcDate}: ${fmt(d.impressions)}`).join('\n')}>
      {daily.map(d => <i class={d.final ? '' : 'today'} style={`height:${Math.max(4, (d.impressions / max) * 100)}%`} />)}
    </div>
  );
}

const STATUS: Record<PostForecastView['status'], [string, string]> = {
  starting: ['starting', 'Less than 90 minutes old, or one reading so far.'],
  rising: ['rising', 'Still gaining at half or more of its first-hour rate.'],
  slowing: ['slowing', 'Gaining at 20 to 50% of its first-hour rate.'],
  tail: ['tail', 'Below 20% of its first-hour rate. Distribution has moved on.'],
};

function Posts({ s }: { s: State }) {
  if (!s.live.length) return <section class="dim">No posts younger than 48h with a reading.</section>;
  return (
    <section>
      {s.live.map(p => {
        const [label, tip] = STATUS[p.status];
        const title = p.textPreview ? p.textPreview.replace(/\s+/g, ' ').slice(0, 72) + (p.textPreview.length > 72 ? '…' : '') : `Post from ${fmtLocalTime(p.publishedAt, s.timezone)}`;
        return (
          <div class="post">
            <a class="post-title" href={`https://www.linkedin.com/feed/update/urn:li:activity:${p.urn}/`} target="_blank">{title}</a>
            <div class="dim" style="font-size:12px">{fmtLocalTime(p.publishedAt, s.timezone)} · {p.type === 'unknown' ? 'post' : p.type} · {p.hours < 48 ? p.hours.toFixed(1) + 'h' : Math.round(p.hours / 24) + 'd'}<span class={'tag ' + (p.status === 'tail' ? 'warn' : p.status === 'rising' ? 'good' : '')} title={tip}>{label}</span></div>
            <div class="post-row">
              <Spark p={p} />
              <div>
                <div><b>{fmt(p.impressions)}</b> now</div>
                <div><b>{fmt(p.point)}</b> by end of day</div>
                <div class="dim" style="font-size:12px">{p.gainPerHour !== undefined ? `${fmt(p.gainPerHour)}/h` : ''}</div>
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Impressions over hours since publish, solid to now, dashed to end of day. */
function Spark({ p }: { p: PostForecastView }) {
  const W = 200, H = 54, pad = 4;
  const pts = p.series.length ? p.series : [[p.hours, p.impressions] as [number, number]];
  const hEnd = Math.max(p.hours + 0.5, pts[pts.length - 1][0]);
  const hToMid = Math.max(0.2, 24 - (new Date().getUTCHours() + new Date().getUTCMinutes() / 60));
  const hMax = hEnd + hToMid;
  const vMax = Math.max(p.point, ...pts.map(x => x[1]), 1);
  const x = (h: number) => pad + (W - 2 * pad) * (h / hMax);
  const y = (v: number) => H - pad - (H - 2 * pad) * (v / vMax);
  const solid = [[0, 0] as [number, number], ...pts].map(([h, v]) => `${x(h).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} class="spark-svg" aria-hidden="true">
      <polyline points={solid} fill="none" stroke="#171717" stroke-width="2" stroke-linejoin="round" />
      <line x1={x(last[0])} y1={y(last[1])} x2={x(hMax)} y2={y(p.point)} stroke="#171717" stroke-width="1.5" stroke-dasharray="3 3" />
      <circle cx={x(last[0])} cy={y(last[1])} r="3" fill="#171717" />
      <circle cx={x(hMax)} cy={y(p.point)} r="3" fill="#fff" stroke="#171717" stroke-width="1.5" />
    </svg>
  );
}

function Accuracy({ s }: { s: State }) {
  const a = s.accuracy;
  const eod = a.byHorizon['eod'], post = a.byHorizon['24h'];
  const errs = a.eodErrors;
  const maxE = Math.max(0.05, ...errs.map(e => Math.abs(e.errorPct)));
  const line = (label: string, v: { n: number; mape: number; coverage: number } | undefined, unit: string) => (
    <div class="row" style="display:block">
      <div><b>{label}</b></div>
      {v && v.n ? <div class="dim">Typically within <b>{pct(v.mape)}</b> over the last {v.n} {unit}. The 80% range held {pct(v.coverage)} of the time.</div> : <div class="dim">Nothing to score yet.</div>}
    </div>
  );
  return (
    <section>
      <div class="note">Every forecast is kept and scored against the actual once it lands. Rolling 14 days. Confidence: <b>{s.model.regime}</b>, {REGIME_TIP[s.model.regime].toLowerCase()}</div>
      {line('End of day', eod, 'days')}
      {line('Posts at 24h', post, 'posts')}
      <h2>End of day, forecast versus actual</h2>
      {errs.length ? (<>
        <div class="spark" title={errs.map(e => `${e.utcDate}: ${e.errorPct > 0 ? 'too high' : 'too low'} by ${pct(Math.abs(e.errorPct))}`).join('\n')}>
          {errs.map(e => <i class={e.errorPct < 0 ? 'neg' : ''} style={`height:${Math.max(8, Math.abs(e.errorPct) / maxE * 100)}%`} />)}
        </div>
        <div class="dim" style="font-size:11px">One bar per day, mid-afternoon forecast. Grey: forecast too high. Red: too low.</div>
      </>) : <div class="dim">No closed day with a forecast yet.</div>}
    </section>
  );
}

function Health({ s, reload }: { s: State; reload: () => void }) {
  const pages: (keyof CaptureHealth)[] = ['analytics', 'post_summary', 'feed', 'post_page', 'notifications'];
  const [busy, setBusy] = useState(false);
  const visitNow = async () => { setBusy(true); try { await rpc({ type: 'ui:visitNow' }); } finally { setBusy(false); reload(); } };
  return (
    <section>
      {pages.map(p => {
        const h = s.health[p];
        const ok = h?.lastOkAt && (!h.lastErrorAt || h.lastOkAt > h.lastErrorAt);
        return (
          <div class="row">
            <span>{p.replace('_', ' ')}</span>
            <span>
              {!h ? <span class="dim">never read</span> : ok ? <span class="tag good">ok · {ago(h.lastOkAt!, s.now)}</span> : <span class="tag bad" title={h.lastError}>failing · {h.lastError ?? '?'}</span>}
            </span>
          </div>
        );
      })}
      <h2>Auto-visit</h2>
      <div class="row"><span>Enabled</span><span>{s.settings.autoVisit.enabled ? 'yes' : 'no'}</span></div>
      <div class="row"><span>Visits today</span><span>{s.autovisit.count} / 60</span></div>
      <div class="row"><span>Backoff</span><span>{s.autovisit.backoff}x{s.autovisit.failures ? ` (${s.autovisit.failures} failures)` : ''}</span></div>
      <div style="margin-top:10px; display:flex; gap:8px">
        <button class="ghost" onClick={visitNow} disabled={busy || !s.settings.autoVisit.enabled}>{busy ? 'Reading…' : 'Read now'}</button>
        <button class="ghost" onClick={() => chrome.runtime.openOptionsPage()}>Options</button>
      </div>
    </section>
  );
}

function ago(iso: string, now: string): string {
  const m = Math.round((new Date(now).getTime() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function OnboardingView({ s, reload }: { s: State; reload: () => void }) {
  const ob = s.onboarding;
  const daysCaptured = s.daily.length;
  const toRead = s.postsToRead;
  const readCount = toRead.filter(p => p.read).length;
  const [busy, setBusy] = useState(false);
  const [goalKind, setGoalKind] = useState<'daily' | 'monthly'>('monthly');
  const [goalValue, setGoalValue] = useState(0);
  const [summary, setSummary] = useState<{ baseline: number; bestHours: number[]; regime: string } | null>(null);
  useEffect(() => { if (!goalValue && s.goalSuggestion) setGoalValue(s.goalSuggestion); }, [s.goalSuggestion]);
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try { const r = await rpc<{ summary?: { baseline: number; bestHours: number[]; regime: string } }>({ type: 'ui:onboarding', payload: { action, ...extra } }); if (r?.summary) setSummary(r.summary); }
    finally { setBusy(false); reload(); }
  };
  const step1Done = daysCaptured > 0;
  const step2Done = toRead.length > 0 && readCount >= Math.min(toRead.length, 5);
  const goalDone = ob.step >= 5;
  if (summary) {
    return (
      <section>
        <h1>Model initialised</h1>
        <div class="row"><span>Baseline per post</span><b>{fmt(summary.baseline)}</b></div>
        <div class="row"><span>Best posting hours so far</span><span>{summary.bestHours.length ? summary.bestHours.map(h => `${String(h).padStart(2, '0')}:00`).join(', ') : 'not enough data'}</span></div>
        <div class="row"><span>Regime</span><span class="tag">{summary.regime}</span></div>
        <div class="dim" style="margin-top:10px">{REGIME_TIP[summary.regime]}</div>
        <button class="primary" style="margin-top:12px" onClick={reload}>Open dashboard</button>
      </section>
    );
  }
  return (
    <section>
      <h1>Set up in under 3 minutes</h1>
      <div class="step">
        <b>1. Open your LinkedIn analytics</b>
        <div class="dim">The extension reads the daily series, timezone and top posts from that page. Nothing is sent anywhere.</div>
        <div style="margin-top:6px">
          {step1Done ? <span class="tag">{daysCaptured} days captured</span> : <button class="primary" disabled={busy} onClick={() => act('openAnalytics')}>Open analytics</button>}
        </div>
        {step1Done && <Bars daily={s.daily} />}
      </div>
      <div class={'step' + (step1Done ? '' : ' muted')}>
        <b>2. Read your recent posts</b>
        <div class="dim">One reading per post gives the model a starting point. {s.settings.autoVisit.enabled ? 'Auto-visit opens each post summary in a background tab for about 10 seconds.' : 'Auto-visit is off, so click each post once.'}</div>
        {toRead.length > 0 && (<>
          <div class="progress"><i style={`width:${(readCount / toRead.length) * 100}%`} /></div>
          <div class="dim">{readCount} of {toRead.length} posts read</div>
          {s.settings.autoVisit.enabled
            ? <button class="primary" style="margin-top:6px" disabled={busy || readCount >= toRead.length} onClick={() => act('readPosts')}>{busy ? 'Reading…' : 'Read posts now'}</button>
            : <ul class="plain">{toRead.map(p => <li><a href={p.url} target="_blank">{p.post ? fmtLocalTime(p.post.publishedAt, s.timezone) + ' · ' + (p.post.textPreview ?? p.urn) : p.urn}</a>{p.read && <span class="tag">read</span>}</li>)}</ul>}
        </>)}
        {step1Done && !toRead.length && <div class="dim">Waiting for the Top Posts list to load on the analytics page. Scroll it once if needed.</div>}
      </div>
      <div class={'step' + (step1Done ? '' : ' muted')}>
        <b>3. One question: your goal</b>
        <div style="display:flex; gap:8px; margin-top:6px">
          <select value={goalKind} onChange={e => setGoalKind((e.target as HTMLSelectElement).value as 'daily' | 'monthly')} style="width:120px">
            <option value="monthly">Monthly</option><option value="daily">Daily</option>
          </select>
          <input type="number" value={goalKind === 'monthly' ? goalValue : Math.round(goalValue / 30)} onInput={e => { const v = Number((e.target as HTMLInputElement).value); setGoalValue(goalKind === 'monthly' ? v : v * 30); }} />
        </div>
        <div style="display:flex; gap:8px; margin-top:6px">
          <button class="ghost" disabled={busy} onClick={() => act('setGoal', { goal: { kind: goalKind, value: goalKind === 'monthly' ? goalValue : Math.round(goalValue / 30) } })}>{goalDone ? 'Saved' : 'Save goal'}</button>
          <button class="ghost" disabled={busy} onClick={() => act('setGoal', { goal: { kind: null, value: 0 } })}>Skip</button>
        </div>
      </div>
      <div style="margin-top:12px; display:flex; gap:8px; align-items:center">
        <button class="primary" disabled={busy || !step1Done} onClick={() => act('finish')}>Finish setup</button>
        {!step2Done && step1Done && <span class="dim">You can finish now and read posts later.</span>}
      </div>
      <div class="dim" style="margin-top:12px"><a href="#" onClick={e => { e.preventDefault(); chrome.runtime.openOptionsPage(); }}>Options</a> for auto-visit, quiet hours and the .xlsx import.</div>
    </section>
  );
}

render(<App />, document.getElementById('app')!);
