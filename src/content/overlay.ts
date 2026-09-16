import type { DayForecastView, PostForecastView } from '../shared/types';
import { fmt } from '../shared/numbers';
import { send } from './readers/common';

// Near-native: LinkedIn's system font, its 60% / 90% black text tones, no fills, one line.
const CSS = `
:host { all: initial; }
.lif { display:block; font: 12px/16px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: rgba(0,0,0,.6);
  padding: 6px 16px 10px; font-variant-numeric: tabular-nums; letter-spacing: 0; }
.lif.card { padding: 0 0 12px; font-size: 13px; line-height: 18px; }
.lif b { color: rgba(0,0,0,.9); font-weight: 600; }
.lif .sep { margin: 0 6px; color: rgba(0,0,0,.3); }
.lif .tag { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: rgba(0,0,0,.45); margin-left: 8px; }
.lif .toggle { float:right; color: rgba(0,0,0,.45); cursor:pointer; text-decoration: underline; font-size: 12px; }
.lif svg { display:block; width:100%; height:auto; margin-top: 10px; overflow: visible; }
.lif svg text { font: 11px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; fill: rgba(0,0,0,.6); font-variant-numeric: tabular-nums; }
.lif svg text.strong { fill: rgba(0,0,0,.9); font-weight: 600; }
`;

function ensureHost(parent: Element, id: string, before?: Element | null): HTMLElement {
  let host = document.querySelector<HTMLElement>(`[data-lif="${id}"]`);
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('data-lif', id);
    host.attachShadow({ mode: 'open' });
  }
  host.style.cssText = 'display:block;width:100%;flex:0 0 100%;clear:both;';
  if (before && before.parentElement === parent) { if (host.nextElementSibling !== before) parent.insertBefore(host, before); }
  else if (host.parentElement !== parent) parent.appendChild(host);
  return host;
}

function render(host: HTMLElement, html: string, cls = '', title = '') {
  host.shadowRoot!.innerHTML = `<style>${CSS}</style><div class="lif ${cls}" title="${title}">${html}</div>`;
}

const sep = '<span class="sep">·</span>';

/** Render the one-liner under an own post. Pass `view` when the snapshot reply already carries it. */
export async function mountPostOverlay(card: Element, urn: string, view?: PostForecastView | null) {
  const host = ensureHost(card, 'post-' + urn);
  let v = view;
  if (v === undefined) {
    const resp = (await send({ type: 'forecast:post', payload: { urn } })) as { view?: PostForecastView | null; enabled?: boolean } | undefined;
    if (!resp || resp.enabled === false) { host.remove(); return; }
    v = resp.view;
  }
  if (!v) { render(host, 'Forecast pending'); return; }
  const tip = [v.gainPerHour !== undefined ? `${fmt(v.gainPerHour)} per hour` : '', v.tailMode ? 'tail mode' : '', `80% interval ${fmt(v.low)} to ${fmt(v.high)}`, v.regime].filter(Boolean).join(' · ');
  render(host, `<b>${fmt(v.impressions)}</b> now${sep}<b>${fmt(v.point)}</b> by end of day`, '', tip);
}

export interface DayHistory { utcDate: string; impressions: number; today: boolean }

/**
 * Analytics card: one line plus, in Daily view, a bar chart of the last days with today's bar
 * extended to the end-of-day forecast. LinkedIn's own chart is hidden while ours shows.
 */
export async function mountDayOverlay(parent: Element, before: Element | null, opts: { daily: boolean; chartBlock?: Element | null }) {
  const host = ensureHost(parent, 'day', before);
  const resp = (await send({ type: 'forecast:day' })) as { view?: DayForecastView; history?: DayHistory[]; enabled?: boolean } | undefined;
  if (!resp || resp.enabled === false) { host.remove(); return; }
  const v = resp.view;
  if (!v || v.dailyNowSource === 'none') { render(host, 'Daily impressions: no reading for today yet', 'card'); return; }
  const tip = `pace needs ${fmt(v.pace)} per day · 80% interval ${fmt(v.low)} to ${fmt(v.high)} · ${v.regime}`;
  // Match LinkedIn's 7-day window: six completed days plus today.
  const hist = (resp.history ?? []).slice(-7);
  const eodDaily = v.early || !Number.isFinite(v.point) ? 0 : v.point;
  let head: string;
  let points: DayHistory[] = hist;
  let eod = eodDaily;
  if (opts.daily) {
    head = v.early
      ? `Daily impressions${sep}<b>${fmt(v.dailyNow)}</b> now${sep}end of day estimate from 06:00 UTC`
      : `Daily impressions${sep}<b>${fmt(v.dailyNow)}</b> now${sep}<b>${fmt(v.point)}</b> by end of day`;
  } else {
    let run = 0;
    points = hist.map(h => ({ ...h, impressions: (run += h.impressions) }));
    const past = run - v.dailyNow;
    eod = eodDaily ? past + eodDaily : 0;
    head = v.early
      ? `7-day total${sep}<b>${fmt(run)}</b> now${sep}end of day estimate from 06:00 UTC`
      : `7-day total${sep}<b>${fmt(run)}</b> now${sep}<b>${fmt(eod)}</b> by end of day`;
  }
  if (points.length < 2) { render(host, head, 'card', tip); return; }

  const hidden = localStorage.getItem('lif:showLinkedInChart') !== '1';
  const toggle = `<span class="toggle" data-toggle>${hidden ? 'LinkedIn chart' : 'Forecast chart'}</span>`;
  render(host, head + toggle + (hidden ? chartSvg(points, eod) : ''), 'card', tip);
  if (opts.chartBlock) (opts.chartBlock as HTMLElement).style.display = hidden ? 'none' : '';
  host.shadowRoot!.querySelector('[data-toggle]')?.addEventListener('click', () => {
    localStorage.setItem('lif:showLinkedInChart', hidden ? '1' : '0');
    void mountDayOverlay(parent, before, opts);
  });
}

function chartSvg(history: DayHistory[], eod: number): string {
  // Mirrors LinkedIn's line chart: light horizontal grid, axis labels, one teal line.
  // Solid through completed days to today's current value; dashed from yesterday to the EOD point.
  const W = 800, H = 260, top = 16, bottom = 36, left = 56, right = 24;
  const line = '#2d6a72';
  const rawMax = Math.max(1, ...history.map(h => h.impressions), eod);
  const step = niceStep(rawMax / 4);
  const max = Math.ceil(rawMax / step) * step;
  const n = history.length;
  const x = (i: number) => left + (W - left - right) * (n === 1 ? 0.5 : i / (n - 1));
  const y = (val: number) => top + (H - top - bottom) * (1 - val / max);
  const parts: string[] = [];
  for (let g = 0; g <= max + 1e-9; g += step) {
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${y(g)}" y2="${y(g)}" stroke="rgba(0,0,0,.08)"/>`);
    parts.push(`<text x="${left - 10}" y="${y(g) + 4}" text-anchor="end">${kfmt(g)}</text>`);
  }
  history.forEach((h, i) => {
    const d = new Date(h.utcDate + 'T00:00:00Z');
    const label = h.today ? 'Today' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    parts.push(`<text x="${x(i)}" y="${H - 10}" text-anchor="middle"${h.today ? ' class="strong"' : ''}>${label}</text>`);
  });
  const solid = history.map((h, i) => `${x(i)},${y(h.impressions)}`).join(' ');
  parts.push(`<polyline points="${solid}" fill="none" stroke="${line}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
  const ti = n - 1, t = history[ti];
  if (eod > t.impressions && n >= 2) {
    const p = history[ti - 1];
    parts.push(`<line x1="${x(ti - 1)}" y1="${y(p.impressions)}" x2="${x(ti)}" y2="${y(eod)}" stroke="${line}" stroke-width="2" stroke-dasharray="5 5" stroke-linecap="round"/>`);
    parts.push(`<circle cx="${x(ti)}" cy="${y(eod)}" r="4.5" fill="#fff" stroke="${line}" stroke-width="2"/>`);
    parts.push(`<text x="${x(ti) - 10}" y="${y(eod) - 10}" text-anchor="end" class="strong">${fmt(eod)} by end of day</text>`);
  }
  parts.push(`<circle cx="${x(ti)}" cy="${y(t.impressions)}" r="4.5" fill="${line}"/>`);
  parts.push(`<text x="${x(ti) - 10}" y="${y(t.impressions) + 16}" text-anchor="end">${fmt(t.impressions)} now</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">${parts.join('')}</svg>`;
}

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const m = raw / pow;
  const f = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return f * pow;
}

function kfmt(n: number): string {
  if (n === 0) return '0';
  if (n >= 1000) { const k = n / 1000; return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + 'K'; }
  return String(Math.round(n));
}
