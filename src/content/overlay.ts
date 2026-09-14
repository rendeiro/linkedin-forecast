import type { DayForecastView, PostForecastView } from '../shared/types';
import { fmt } from '../shared/numbers';
import { send } from './readers/common';

// Near-native: LinkedIn's system font, its 60% / 90% black text tones, no fills, one line.
const CSS = `
:host { all: initial; }
.lif { display:block; font: 12px/16px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: rgba(0,0,0,.6);
  padding: 6px 16px 10px; font-variant-numeric: tabular-nums; letter-spacing: 0; }
.lif.card { padding: 0 0 12px; }
.lif b { color: rgba(0,0,0,.9); font-weight: 600; }
.lif .sep { margin: 0 6px; color: rgba(0,0,0,.3); }
.lif .tag { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: rgba(0,0,0,.45); margin-left: 8px; }
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

export async function mountPostOverlay(card: Element, urn: string) {
  const host = ensureHost(card, 'post-' + urn);
  const resp = (await send({ type: 'forecast:post', payload: { urn } })) as { view?: PostForecastView; enabled?: boolean } | undefined;
  if (!resp || resp.enabled === false) { host.remove(); return; }
  const v = resp.view;
  if (!v) { render(host, 'Forecast pending'); return; }
  const gain = v.gainPerHour !== undefined ? `${sep}${fmt(v.gainPerHour)}/h` : '';
  if (v.hours >= 24) { render(host, `24h checkpoint passed${gain}`); return; }
  const tail = v.tailMode ? `<span class="tag">tail</span>` : '';
  render(host, `24h ≈ <b>${fmt(v.point)}</b>${gain}${tail}`, '', `80% interval ${fmt(v.low)} to ${fmt(v.high)} · ${v.regime}`);
}

export async function mountDayOverlay(parent: Element, before?: Element | null) {
  const host = ensureHost(parent, 'day', before);
  const resp = (await send({ type: 'forecast:day' })) as { view?: DayForecastView; enabled?: boolean } | undefined;
  if (!resp || resp.enabled === false) { host.remove(); return; }
  const v = resp.view;
  if (!v || v.dailyNowSource === 'none') { render(host, 'No reading for today yet', 'card'); return; }
  const pace = `${sep}pace <b>${fmt(v.pace)}</b>`;
  if (v.early) { render(host, `Today <b>${fmt(v.dailyNow)}</b>${sep}EOD from 06:00 UTC${pace}`, 'card'); return; }
  render(host, `Today <b>${fmt(v.dailyNow)}</b>${sep}EOD ≈ <b>${fmt(v.point)}</b>${pace}`, 'card', `80% interval ${fmt(v.low)} to ${fmt(v.high)} · ${v.regime}`);
}
