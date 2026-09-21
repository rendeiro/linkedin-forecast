import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { rpc } from '../rpc';
import type { Settings, Snapshot, Daily, Post, NudgeRecord } from '../../shared/types';
import { parseExport } from '../../model/export';
import { fmt } from '../../shared/numbers';

interface State { settings: Settings; timezone?: string; model: { regime: string; nPostActuals: number }; }

function App() {
  const [s, setS] = useState<State | null>(null);
  const [msg, setMsg] = useState('');
  const [debug, setDebug] = useState<{ snapshots: Snapshot[]; daily: Daily[]; posts: Post[]; nudges: NudgeRecord[]; log: { at: string; kind: string; message: string }[] } | null>(null);
  const load = () => rpc<State>({ type: 'ui:getState' }).then(setS);
  useEffect(() => { load(); }, []);
  if (!s) return <div class="dim">Loading…</div>;
  const st = s.settings;
  const save = async (next: Settings) => { await rpc({ type: 'ui:setSettings', payload: next }); setMsg('Saved.'); load(); };
  const upd = (patch: Partial<Settings>) => save({ ...st, ...patch });

  const exportJson = async () => {
    const dump = await rpc<object>({ type: 'ui:export' });
    download(`lif-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump, null, 2), 'application/json');
  };
  const exportCsv = async () => {
    const dump = await rpc<{ daily: Daily[]; snapshots: Snapshot[]; posts: Post[] }>({ type: 'ui:export' });
    const lines = ['kind,key,date,value,source'];
    for (const d of dump.daily) lines.push(`daily,${d.utcDate},${d.utcDate},${d.impressions},${d.source}`);
    for (const x of dump.snapshots) lines.push(`snapshot,${x.urn},${x.observedAt},${x.impressions},${x.source}`);
    for (const p of dump.posts) lines.push(`post,${p.urn},${p.publishedAt},${p.actual24h ?? p.lifetime ?? ''},${p.type}`);
    download(`lif-export-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'), 'text/csv');
  };
  const importJson = async (f: File) => {
    const dump = JSON.parse(await f.text());
    await rpc({ type: 'ui:importJson', payload: dump });
    setMsg('Backup restored.'); load();
  };
  const importXlsx = async (f: File) => {
    try {
      const buf = await f.arrayBuffer();
      const r = parseExport(buf);
      const res = await rpc<{ daily: number; posts: number; followers: number; notes: string[] }>({ type: 'ui:importExport', payload: r });
      setMsg(`Imported ${res.daily} days, ${res.posts} posts, ${res.followers} follower points.${res.notes.length ? ' Notes: ' + res.notes.join('; ') : ''}`);
      load();
    } catch (e) { setMsg('Import failed: ' + String(e)); }
  };
  const reset = async () => {
    if (!confirm('Delete all captured data, forecasts and settings on this browser?')) return;
    await rpc({ type: 'ui:reset' }); setMsg('Reset done.'); load();
  };
  const showDebug = async () => setDebug(await rpc({ type: 'ui:debug' }));
  const rebuild = async () => {
    const r = await rpc<{ posts: number; trusted: number; actuals: number }>({ type: 'ui:rebuild' });
    setMsg(`Model rebuilt from ${r.posts} posts: ${r.trusted} with a trusted publish time, ${r.actuals} usable 24h actuals.`); load();
  };

  return (
    <div>
      <h1>LinkedIn impressions forecast</h1>
      <p class="note">Everything runs in this browser. The extension only reads LinkedIn pages you open (or, with auto-visit on, your own analytics pages it opens for you). No backend, no accounts, no telemetry, no requests to any other site.</p>
      {msg && <p class="tag">{msg}</p>}

      <h2>Goal</h2>
      <div style="display:flex; gap:12px">
        <div style="flex:1"><label>Type</label>
          <select value={st.goal.kind ?? ''} onChange={e => upd({ goal: { ...st.goal, kind: ((e.target as HTMLSelectElement).value || null) as Settings['goal']['kind'] } })}>
            <option value="">None</option><option value="daily">Daily</option><option value="monthly">Monthly</option>
          </select></div>
        <div style="flex:1"><label>Target impressions</label>
          <input type="number" value={st.goal.value} onChange={e => upd({ goal: { ...st.goal, value: Number((e.target as HTMLInputElement).value) } })} /></div>
      </div>

      <h2>Quiet hours</h2>
      <div style="display:flex; gap:12px">
        <div style="flex:1"><label>Start (local hour)</label><input type="number" min="0" max="23" value={st.quietHours.start} onChange={e => upd({ quietHours: { ...st.quietHours, start: Number((e.target as HTMLInputElement).value) } })} /></div>
        <div style="flex:1"><label>End (local hour)</label><input type="number" min="0" max="23" value={st.quietHours.end} onChange={e => upd({ quietHours: { ...st.quietHours, end: Number((e.target as HTMLInputElement).value) } })} /></div>
      </div>

      <h2>Auto-visit</h2>
      <label><input type="checkbox" checked={st.autoVisit.enabled} onChange={e => upd({ autoVisit: { ...st.autoVisit, enabled: (e.target as HTMLInputElement).checked } })} /> Open my own analytics pages in background tabs on a schedule</label>
      <p class="note">This is automation under LinkedIn's terms of service, even though it only opens your own pages. It runs only while Chrome is open, outside quiet hours, backs off when a read fails, and never exceeds 60 visits a day. Turn it off if you would rather log readings only when you browse.</p>
      <div style="display:flex; gap:12px">
        <div style="flex:1"><label>Analytics page every (min)</label><input type="number" min="15" value={st.autoVisit.analyticsMin} onChange={e => upd({ autoVisit: { ...st.autoVisit, analyticsMin: Number((e.target as HTMLInputElement).value) } })} /></div>
        <div style="flex:1"><label>Live post pages every (min)</label><input type="number" min="10" value={st.autoVisit.postMin} onChange={e => upd({ autoVisit: { ...st.autoVisit, postMin: Number((e.target as HTMLInputElement).value) } })} /></div>
      </div>

      <h2>Notifications and display</h2>
      <div style="display:flex; gap:12px">
        <div style="flex:1"><label>Max nudges per day</label><input type="number" min="0" max="10" value={st.notifCap} onChange={e => upd({ notifCap: Number((e.target as HTMLInputElement).value) })} /></div>
        <div style="flex:1"><label>Timezone override (IANA, blank = detected {s.timezone ?? 'browser'})</label><input type="text" value={st.tzOverride ?? ''} onChange={e => upd({ tzOverride: (e.target as HTMLInputElement).value || undefined })} /></div>
      </div>
      <label><input type="checkbox" checked={st.overlay} onChange={e => upd({ overlay: (e.target as HTMLInputElement).checked })} /> Show the forecast line under my posts and above the analytics chart</label>

      <h2>Import LinkedIn analytics export (.xlsx)</h2>
      <p class="dim">Optional. Adds up to 50 posts with lifetime impressions plus the daily and follower series. Merges by URN and date, so importing twice is safe.</p>
      <input type="file" accept=".xlsx" onChange={e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) importXlsx(f); }} />

      <h2>Backup</h2>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
        <button class="ghost" onClick={exportJson}>Export JSON</button>
        <button class="ghost" onClick={exportCsv}>Export CSV</button>
        <label style="margin:0">Restore JSON <input type="file" accept=".json" onChange={e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) importJson(f); }} /></label>
      </div>

      <h2>Debug</h2>
      <div style="display:flex; gap:8px"><button class="ghost" onClick={showDebug}>Show captured data</button><button class="ghost" onClick={rebuild}>Rebuild model from readings</button><button class="ghost" onClick={reset}>Reset everything</button></div>
      {debug && (<>
        <h2>Daily ({debug.daily.length})</h2>
        <table><thead><tr><th>UTC date</th><th class="n">Impressions</th><th>Final</th><th>Source</th></tr></thead>
          <tbody>{debug.daily.slice(-40).map(d => <tr><td>{d.utcDate}</td><td class="n">{fmt(d.impressions)}</td><td>{d.final ? 'yes' : 'no'}</td><td>{d.source}</td></tr>)}</tbody></table>
        <h2>Posts ({debug.posts.length})</h2>
        <table><thead><tr><th>URN</th><th>Published</th><th>Type</th><th class="n">24h</th><th class="n">Lifetime</th></tr></thead>
          <tbody>{debug.posts.sort((a, b) => a.publishedAt < b.publishedAt ? 1 : -1).slice(0, 50).map(p => <tr><td>{p.urn}</td><td>{p.publishedAt.slice(0, 16)}{p.publishedApprox ? ' ~' : ''}</td><td>{p.type}</td><td class="n">{fmt(p.actual24h)}</td><td class="n">{fmt(p.lifetime)}</td></tr>)}</tbody></table>
        <h2>Snapshots (last {debug.snapshots.length})</h2>
        <table><thead><tr><th>Observed</th><th>URN</th><th class="n">Impressions</th><th>Source</th></tr></thead>
          <tbody>{debug.snapshots.slice(-60).reverse().map(x => <tr><td>{x.observedAt.slice(0, 16)}</td><td>{x.urn}</td><td class="n">{fmt(x.impressions)}</td><td>{x.source}</td></tr>)}</tbody></table>
        <h2>Log (last {debug.log.length})</h2>
        <pre>{debug.log.slice().reverse().map(l => `${l.at.slice(5, 19).replace('T', ' ')}  ${l.kind.padEnd(9)} ${l.message}`).join('\n')}</pre>
        <h2>Nudges ({debug.nudges.length})</h2>
        <table><tbody>{debug.nudges.slice(-20).reverse().map(n => <tr><td>{n.firedAt.slice(0, 16)}</td><td>{n.type}</td><td>{n.text}</td></tr>)}</tbody></table>
      </>)}
    </div>
  );
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

render(<App />, document.getElementById('app')!);
