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
      // Anchor: the chart's own container; the overlay goes right above it, inside the card.
      const chart = await waitFor(() => {
        if (document.querySelector(SEL.chartLoader)) return null;
        return document.querySelector('[aria-label^="Chart"], [data-highcharts-chart], svg.highcharts-root') as Element | null;
      }, 12000, 500);
      if (chart) {
        let block: Element = chart;
        for (let i = 0; i < 4 && block.parentElement && block.parentElement.children.length === 1; i++) block = block.parentElement;
        const daily = isDailySelected(document);
        if (block.parentElement) {
          const parent = block.parentElement;
          const mount = () => mountDayOverlay(parent, block, { daily: isDailySelected(document), chartBlock: block });
          void mount();
          void daily;
          setInterval(mount, 60_000);
        }
      }
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
