import type { DayForecastView, PostForecastView } from '../shared/types';
import { fmt } from '../shared/numbers';
import { send } from './readers/common';

const CSS = `
:host { all: initial; }
.lif { display:block; font: 12px/1.5 -apple-system, system-ui, Segoe UI, Roboto, sans-serif; color:#3a3a3a;
  background:#f5f7f0; border:1px solid #d9e0c8; border-radius:6px; padding:4px 10px; margin:6px 12px; }
.lif b { color:#1d3a1d; font-weight:600; }
.lif .tag { display:inline-block; background:#e2e8d2; border-radius:3px; padding:0 5px; margin-left:6px; font-size:11px; }
.lif .dim { color:#7a7a7a; }
`;

function ensureHost(parent: Element, id: string): HTMLElement {
  let host = parent.querySelector<HTMLElement>(`:scope > [data-lif="${id}"]`);
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('data-lif', id);
    host.attachShadow({ mode: 'open' });
    parent.appendChild(host);
  }
  return host;
}

function render(host: HTMLElement, html: string) {
  const root = host.shadowRoot!;
  root.innerHTML = `<style>${CSS}</style><div class="lif">${html}</div>`;
}

export async function mountPostOverlay(card: Element, urn: string) {
  const host = ensureHost(card, 'post-' + urn);
  const resp = (await send({ type: 'forecast:post', payload: { urn } })) as { view?: PostForecastView; enabled?: boolean } | undefined;
  if (!resp || resp.enabled === false) { host.remove(); return; }
  const v = resp.view;
  if (!v) { render(host, `<span class="dim">Forecast pending, reading this post.</span>`); return; }
  const gain = v.gainPerHour !== undefined ? ` · <b>${fmt(v.gainPerHour)}</b>/h` : '';
  const tail = v.tailMode ? `<span class="tag">tail mode</span>` : '';
  const done = v.hours >= 24;
  const body = done
    ? `<b>${fmt(v.impressions)}</b> now · 24h checkpoint passed${gain}`
    : `<b>${fmt(v.impressions)}</b> now · 24h ≈ <b>${fmt(v.point)}</b> <span class="dim">(${fmt(v.low)} to ${fmt(v.high)})</span>${gain}`;
  render(host, `${body}${tail}<span class="tag">${v.regime}</span>`);
}

export async function mountDayOverlay(anchor: Element) {
  const host = ensureHost(anchor, 'day');
  const resp = (await send({ type: 'forecast:day' })) as { view?: DayForecastView; enabled?: boolean } | undefined;
  if (!resp || resp.enabled === false) { host.remove(); return; }
  const v = resp.view;
  if (!v || v.dailyNowSource === 'none') { render(host, `<span class="dim">Today's number not captured yet.</span>`); return; }
  render(host, `Today <b>${fmt(v.dailyNow)}</b> so far · EOD ≈ <b>${fmt(v.point)}</b> <span class="dim">(${fmt(v.low)} to ${fmt(v.high)})</span> · pace needs <b>${fmt(v.pace)}</b>/day<span class="tag">${v.regime}</span>`);
}
