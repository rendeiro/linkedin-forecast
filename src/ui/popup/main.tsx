import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { rpc } from '../rpc';
import { fmt, pct } from '../../shared/numbers';
import { fmtLocalTime } from '../../shared/time';
import type { DayForecastView, PostForecastView, Settings, Onboarding, CaptureHealth, Daily } from '../../shared/types';
import type { AccuracyStats } from '../../background/engine';

interface State {
  now: string; settings: Settings; onboarding: Onboarding; health: CaptureHealth; today: DayForecastView; live: PostForecastView[];
  accuracy: AccuracyStats; autovisit: { count: number; failures: number; backoff: number; lastOkAt?: string; lastFailAt?: string };
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
  const [tab, setTab] = useState<'today' | 'live' | 'goal' | 'accuracy' | 'health'>('today');
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
        {(['today', 'live', 'goal', 'accuracy', 'health'] as const).map(t => (
          <button class={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </nav>
      {tab === 'today' && <Today s={s} />}
      {tab === 'live' && <Live s={s} />}
      {tab === 'goal' && <Goal s={s} reload={load} />}
      {tab === 'accuracy' && <Accuracy s={s} />}
      {tab === 'health' && <Health s={s} reload={load} />}
    </>
  );
}

function Today({ s }: { s: State }) {
  const t = s.today;
  const none = t.dailyNowSource === 'none';
  const onPace = Number.isFinite(t.point) && t.point >= t.pace;
  return (
    <section>
      <div class="dim">Daily impressions so far{t.dailyNowSource === 'derived' ? ' (derived from the 7-day total)' : t.dailyNowSource === 'partial' ? ' (lower bound from live posts)' : ''}</div>
      <div class="big">{none ? '–' : fmt(t.dailyNow)}</div>
      {!none && t.early && <div class="dim" style="margin-top:8px">UTC day just started. EOD forecast from 06:00 UTC.</div>}
      {!none && !t.early && (
        <div style="margin-top:8px">
          End of day ≈ <b>{fmt(t.point)}</b> <span class="dim">({fmt(t.low)} to {fmt(t.high)})</span>
          <span class={'tag ' + (onPace ? '' : 'warn')}>{onPace ? 'on pace' : 'below pace'}</span>
        </div>
      )}
      {none && <div class="note" style="margin-top:8px">No reading for today yet. Open <a href={s.analyticsUrl} target="_blank">your analytics</a> or the feed once.</div>}
      <div class="row" style="margin-top:10px"><span>Pace needed</span><b>{fmt(t.pace)}/day</b></div>
      <div class="row"><span>From today's posts</span><span>{fmt(t.fromTodayPosts)}</span></div>
      <div class="row"><span>From tails</span><span>{fmt(t.fromTails)}</span></div>
      <div class="row"><span>Post by (normal day)</span><span>{t.postByLocal ?? '–'}</span></div>
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

function Live({ s }: { s: State }) {
  if (!s.live.length) return <section class="dim">No posts younger than 48h with a reading.</section>;
  return (
    <section>
      {s.live.map(p => (
        <div class="row" style="display:block">
          <div>
            <a href={`https://www.linkedin.com/feed/update/urn:li:activity:${p.urn}/`} target="_blank">{fmtLocalTime(p.publishedAt, s.timezone)} · {p.type}</a>
            <span class="dim"> · {p.hours.toFixed(1)}h</span>
            {p.tailMode && <span class="tag warn">tail mode</span>}
          </div>
          <div><b>{fmt(p.impressions)}</b> now · <b>{fmt(p.point)}</b> by end of day <span class="dim">({fmt(p.low)} to {fmt(p.high)})</span>{p.gainPerHour !== undefined && <span> · {fmt(p.gainPerHour)}/h</span>}</div>
        </div>
      ))}
    </section>
  );
}

function Goal({ s, reload }: { s: State; reload: () => void }) {
  const [kind, setKind] = useState<'daily' | 'monthly' | null>(s.settings.goal.kind);
  const [value, setValue] = useState(s.settings.goal.value || s.goalSuggestion);
  const save = async () => {
    await rpc({ type: 'ui:setSettings', payload: { ...s.settings, goal: { kind, value: Number(value) } } });
    reload();
  };
  const month = s.today.utcDate.slice(0, 7);
  const recorded = s.daily.filter(d => d.utcDate.startsWith(month) && d.final).reduce((a, d) => a + d.impressions, 0);
  return (
    <section>
      <label>Goal type</label>
      <select value={kind ?? ''} onChange={e => setKind(((e.target as HTMLSelectElement).value || null) as 'daily' | 'monthly' | null)}>
        <option value="">None (pace from the last 3 days)</option>
        <option value="daily">Daily</option>
        <option value="monthly">Monthly</option>
      </select>
      <label>Target</label>
      <input type="number" value={value} onInput={e => setValue(Number((e.target as HTMLInputElement).value))} />
      <div class="dim" style="margin:6px 0 10px">Suggestion from your last 7 days: {fmt(s.goalSuggestion)} per month.</div>
      <button class="primary" onClick={save}>Save goal</button>
      <h2>Pace</h2>
      <div class="row"><span>Needed today</span><b>{fmt(s.today.pace)}</b></div>
      {kind === 'monthly' && <div class="row"><span>Recorded this month</span><span>{fmt(recorded)}</span></div>}
      <div class="row"><span>Tomorrow (day-ahead)</span><span>{s.model.recentDaily.length >= 3 ? fmt(dayAheadFrom(s)) : '–'}</span></div>
    </section>
  );
}

function dayAheadFrom(s: State): number {
  const rd = s.model.recentDaily.slice(-7);
  const base = rd.reduce((a, b) => a + b, 0) / rd.length;
  const dow = [1.05, 1.10, 1.10, 1.05, 0.90, 0.70, 0.75];
  const tomorrow = new Date(new Date(s.today.utcDate + 'T00:00:00Z').getTime() + 86400000);
  const wd = (tomorrow.getUTCDay() + 6) % 7;
  return base * dow[wd] / (dow.reduce((a, b) => a + b, 0) / 7);
}

function Accuracy({ s }: { s: State }) {
  const a = s.accuracy;
  const row = (k: string, v: { n: number; mape: number; coverage?: number }) => (
    <tr><td>{k}</td><td class="n">{v.n}</td><td class="n">{v.n ? pct(v.mape) : '–'}</td><td class="n">{v.coverage !== undefined && v.n ? pct(v.coverage) : ''}</td></tr>
  );
  const errs = a.eodErrors;
  const maxE = Math.max(0.05, ...errs.map(e => Math.abs(e.errorPct)));
  return (
    <section>
      <div class="note">Rolling 14 days. Interval target is 80% coverage. Regime <b>{s.model.regime}</b>: {REGIME_TIP[s.model.regime]}</div>
      <h2>By horizon</h2>
      <table><thead><tr><th>Horizon</th><th class="n">n</th><th class="n">MAPE</th><th class="n">Coverage</th></tr></thead>
        <tbody>{Object.entries(a.byHorizon).map(([k, v]) => row(k, v))}</tbody></table>
      <h2>By share observed</h2>
      <table><thead><tr><th>Share</th><th class="n">n</th><th class="n">MAPE</th><th></th></tr></thead>
        <tbody>{Object.entries(a.byShare).map(([k, v]) => row(k, v))}</tbody></table>
      {Object.keys(a.byType).length > 0 && (<>
        <h2>By post type</h2>
        <table><thead><tr><th>Type</th><th class="n">n</th><th class="n">MAPE</th><th></th></tr></thead>
          <tbody>{Object.entries(a.byType).map(([k, v]) => row(k, v))}</tbody></table>
      </>)}
      <h2>Daily EOD error</h2>
      {errs.length ? (
        <div class="spark" title={errs.map(e => `${e.utcDate}: ${pct(e.errorPct)}`).join('\n')}>
          {errs.map(e => <i class={e.errorPct < 0 ? 'neg' : ''} style={`height:${Math.max(8, Math.abs(e.errorPct) / maxE * 100)}%`} />)}
        </div>
      ) : <div class="dim">No closed day with a forecast yet.</div>}
      <div class="dim" style="margin-top:8px">Interval scale: post {a.sdScale.post.toFixed(2)}, day {a.sdScale.day.toFixed(2)}</div>
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
            <span>{p}</span>
            <span>
              {!h ? <span class="dim">never read</span> : ok ? <span class="tag">ok · {ago(h.lastOkAt!, s.now)}</span> : <span class="tag bad" title={h.lastError}>failing · {h.lastError ?? '?'}</span>}
              {h?.path && <span class="dim"> {h.path}</span>}
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
