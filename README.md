# LinkedIn Impressions Forecast

Chrome extension (Manifest V3) that reads your own LinkedIn impression numbers while you browse, forecasts end-of-day impressions and the 24h total of live posts, nudges at the right moments, and keeps score of its own accuracy.

Everything runs locally in the browser. No backend, no accounts, no telemetry. The full specification is in [SPEC.md](SPEC.md).

## Install (unpacked)

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions`, enable Developer mode, "Load unpacked", pick the `dist/` folder. Click the extension icon to start the 3-minute setup.

## Develop

| Command | What it does |
|---|---|
| `npm run build` | Bundle to `dist/` with esbuild |
| `npm run watch` | Rebuild on change (reload the extension in Chrome after each rebuild) |
| `npm test` | Vitest: §9 reference vectors, payload parsing against saved HTML, fixture replay |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run fixture` | Regenerate `fixtures/account-a.json` (deterministic) |

## Layout

```
src/content/      content script: URL router, readers (analytics, post summary, feed, notifications), payload parser, selectors, shadow-DOM overlay
src/background/   service worker: message router, IndexedDB store, engine (model glue), auto-visit, nudges
src/model/        pure model (§5), URN decode (§4.4), .xlsx export parser (§4.6)
src/ui/           Preact popup (Today, Live, Goal, Accuracy, Health, onboarding) and options page
tests/            model vectors, payload fixtures, replay
fixtures/         synthetic account fixture
```

## Notes

- Auto-visit is on by default in this personal build. It opens only your own analytics pages in background tabs, capped at 60 visits a day with backoff. This is automation under LinkedIn's terms. The options page says so. Turn it off there if you would rather log readings only as you browse.
- No call ever goes to LinkedIn's internal API. Data comes from rendered pages, their embedded rehydration payload, or your analytics export file.
- LinkedIn markup changes. Every selector lives in `src/content/selectors.ts` and the Health tab in the popup shows which page type last read successfully.
