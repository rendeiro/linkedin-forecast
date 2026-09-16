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
  if (v.hours >= 24) { render(host, `<b>${fmt(v.impressions)}</b> now${sep}24h passed`, '', tip); return; }
  render(host, `<b>${fmt(v.impressions)}</b> now${sep}<b>${fmt(v.point)}</b> at 24h`, '', tip);
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
  const head = v.early
    ? `Daily impressions${sep}<b>${fmt(v.dailyNow)}</b> now${sep}end of day estimate from 06:00 UTC`
    : `Daily impressions${sep}<b>${fmt(v.dailyNow)}</b> now${sep}<b>${fmt(v.point)}</b> by end of day`;
  if (!opts.daily || !resp.history || resp.history.length < 2) { render(host, head, 'card', tip); return; }

  const hidden = localStorage.getItem('lif:showLinkedInChart') !== '1';
  const toggle = `<span class="toggle" data-toggle>${hidden ? 'LinkedIn chart' : 'Forecast chart'}</span>`;
  render(host, head + toggle + (hidden ? chartSvg(resp.history, v) : ''), 'card', tip);
  if (opts.chartBlock) (opts.chartBlock as HTMLElement).style.display = hidden ? 'none' : '';
  host.shadowRoot!.querySelector('[data-toggle]')?.addEventListener('click', () => {
    localStorage.setItem('lif:showLinkedInChart', hidden ? '1' : '0');
    void mountDayOverlay(parent, before, opts);
  });
}

function chartSvg(history: DayHistory[], v: DayForecastView): string {
  const W = 600, H = 170, top = 28, bottom = 30, left = 8, right = 8;
  const eod = v.early || !Number.isFinite(v.point) ? 0 : v.point;
  const max = Math.max(1, ...history.map(h => h.impressions), eod);
  const n = history.length;
  const slot = (W - left - right) / n;
  const bw = Math.min(slot * 0.56, 64);
  const y = (val: number) => top + (H - top - bottom) * (1 - val / max);
  const parts: string[] = [];
  history.forEach((h, i) => {
    const x = left + slot * i + (slot - bw) / 2;
    const d = new Date(h.utcDate + 'T00:00:00Z');
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    if (h.today) {
      if (eod > h.impressions) {
        parts.push(`<rect x="${x}" y="${y(eod)}" width="${bw}" height="${Math.max(0, y(h.impressions) - y(eod))}" rx="2" fill="none" stroke="rgba(0,0,0,.35)" stroke-dasharray="3 3"/>`);
        parts.push(`<text x="${x + bw / 2}" y="${y(eod) - 8}" text-anchor="middle" class="strong">${fmt(eod)}</text>`);
        parts.push(`<text x="${x + bw / 2}" y="${y(eod) + 12}" text-anchor="middle" font-size="10">EOD</text>`);
      } else {
        parts.push(`<text x="${x + bw / 2}" y="${y(h.impressions) - 8}" text-anchor="middle" class="strong">${fmt(h.impressions)}</text>`);
      }
      parts.push(`<rect x="${x}" y="${y(h.impressions)}" width="${bw}" height="${Math.max(1, H - bottom - y(h.impressions))}" rx="2" fill="rgba(0,0,0,.85)"/>`);
      parts.push(`<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle" class="strong">Today</text>`);
    } else {
      parts.push(`<rect x="${x}" y="${y(h.impressions)}" width="${bw}" height="${Math.max(1, H - bottom - y(h.impressions))}" rx="2" fill="rgba(0,0,0,.18)"/>`);
      parts.push(`<text x="${x + bw / 2}" y="${y(h.impressions) - 8}" text-anchor="middle">${fmt(h.impressions)}</text>`);
      parts.push(`<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle">${label}</text>`);
    }
  });
  parts.push(`<line x1="${left}" x2="${W - right}" y1="${H - bottom}" y2="${H - bottom}" stroke="rgba(0,0,0,.12)"/>`);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">${parts.join('')}</svg>`;
}
