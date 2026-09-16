import { URL_PATTERNS, SEL } from './selectors';
import { readAnalytics } from './readers/analytics';
import { readPostSummary } from './readers/postSummary';
import { readFeed } from './readers/feed';
import { readNotifications } from './readers/notifications';
import { mountDayOverlay } from './overlay';
import { waitFor } from './readers/common';

async function run() {
  const url = location.href;
  try {
    if (URL_PATTERNS.analytics.test(url)) {
      await readAnalytics(document);
      // The card re-renders on the Daily/Cumulative toggle, so re-locate the chart on every pass.
      let lastKey = '';
      const pass = async () => {
        if (!URL_PATTERNS.analytics.test(location.href)) return;
        if (document.querySelector(SEL.chartLoader)) return;
        const chart = document.querySelector('[aria-label^="Chart"], [data-highcharts-chart], svg.highcharts-root') as Element | null;
        if (!chart) return;
        let block: Element = chart;
        for (let i = 0; i < 4 && block.parentElement && block.parentElement.children.length === 1; i++) block = block.parentElement;
        const parent = block.parentElement;
        if (!parent) return;
        const daily = isDailySelected(document);
        const host = document.querySelector('[data-lif="day"]');
        const key = `${daily}:${host?.isConnected ? 'on' : 'off'}`;
        const stale = !host || !host.isConnected || host.parentElement !== parent;
        if (stale || key !== lastKey || Date.now() - lastMount > 60_000) {
          lastKey = key; lastMount = Date.now();
          await mountDayOverlay(parent, block, { daily, chartBlock: block });
        }
      };
      let lastMount = 0;
      await pass();
      setInterval(pass, 2000);
    } else if (URL_PATTERNS.postSummary.test(url)) {
      await readPostSummary(document, url);
    } else if (URL_PATTERNS.postPage.test(url)) {
      await readFeed(document, 'post_page');
    } else if (URL_PATTERNS.feed.test(url)) {
      await readFeed(document, 'feed');
    } else if (URL_PATTERNS.notifications.test(url)) {
      await readNotifications(document);
    } else {
      // Any other LinkedIn page: still pick up own posts and the left-rail total opportunistically.
      await readFeed(document, 'other');
    }
  } catch (e) {
    console.warn('[lif] reader failed', e);
  }
}

// LinkedIn is a SPA: re-run on client-side navigation.
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(run, 1500);
  }
}, 1000);

run();

function isDailySelected(doc: Document): boolean {
  const els = Array.from(doc.querySelectorAll('button, [role="button"], [role="combobox"], select'));
  const txt = (e: Element) => (e.textContent || '').trim();
  if (els.some(e => /^cumulative$/i.test(txt(e)))) return false;
  return els.some(e => /^daily$/i.test(txt(e)));
}
