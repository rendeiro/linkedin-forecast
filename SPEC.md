# LinkedIn Impressions Forecast: Chrome extension build spec

Self-contained specification for building a Chrome (Manifest V3) extension that reads a LinkedIn creator's own impression numbers while they browse, forecasts end-of-day impressions and the remaining impressions of live posts, nudges at the right moments, and keeps score of its own accuracy. All numbers in this document are theoretical examples for a fictional account. Nothing here depends on a specific user.

Everything runs locally in the browser. No backend, no accounts, no telemetry.

---

## 1. Scope

**In scope**

- Zero-typing setup from pages the user already has access to (their own analytics and posts).
- Passive capture of impression counts on every LinkedIn page view, plus optional scheduled background "visits" to the user's own analytics pages.
- Forecasts: (a) a live post's 24-hour total, (b) today's end-of-day (EOD) daily impressions, (c) tomorrow's daily total.
- Nudges: golden-hour checks, second-post decision, morning plan, next-morning scorecard.
- Goal tracking (daily or monthly target, user-overridable) and pace.
- Forecast history with error rates and interval coverage.
- Optional import of LinkedIn's creator analytics `.xlsx` export.

**Out of scope, permanently**

- LinkedIn's internal (Voyager) API. Never call `/voyager/api/*` or any authenticated JSON endpoint. All data comes from rendered pages and their embedded hydration payloads, or from the user's export file.
- Any action on LinkedIn (posting, liking, commenting, following). Read only.
- Reading other people's analytics.

---

## 2. Definitions

| Term | Meaning |
|---|---|
| Impressions | Count shown by LinkedIn; per post ("N impressions" under the author's post) or per day (analytics chart). |
| UTC day | LinkedIn records daily impressions per calendar day in UTC. All "daily" logic uses UTC day boundaries; display converts to the user's local time. |
| Post 24h | A post's impressions 24 hours after publish. A checkpoint, not a lifetime total. |
| Tail | Impressions a post earns after its first 24h. Posts typically keep earning 3 to 5 days; lifetime is often 1.5x to 3x the 24h figure. |
| Golden hour | First 60 to 120 minutes after publish, when LinkedIn tests distribution. |
| Tail mode | A post whose impressions gained in the last hour are below 20% of what it gained in its first hour. |
| Snapshot | One observed reading `{post, observed_at, impressions, ...}`. |
| Regime | Confidence label from the number of own posts with a 24h actual: `priors` (<10), `calibrating` (10 to 29), `fitted` (30+). Shown on every forecast. |
| Local hour | Hour in the user's browser timezone, fractional (14:30 = 14.5). |
| UTC hour | Hours since the start of the current UTC day, fractional. |

---

## 3. User-facing behaviour

### 3.1 Onboarding (first run)

**Mode A, no file. Default. Target: under 3 minutes, one question asked.**

1. Popup: "Open your LinkedIn analytics." Button opens `https://www.linkedin.com/analytics/creator/content/` in a new tab.
2. Content script reads (see §4): the daily impressions series (28 days if the page offers it, otherwise 7), the account 7-day total, the timezone string, and the Top Posts list (URNs) once it hydrates. Popup shows "28 days captured" with a tiny bar chart so the user sees it worked.
3. For each recent post (up to 15, youngest first) the extension needs a per-post reading. If auto-visit is on, it opens each post-summary page in a background tab, reads it, closes it (about 10 seconds each, progress bar "7 of 12 posts read"). If auto-visit is off, the popup lists the posts as links; each click the user makes logs one reading.
4. Publish times decoded from URNs (§4.4). Post type detected from the feed card when seen, else `unknown`.
5. One question: goal. Prefilled suggestion = mean of the last 7 recorded days x 30 as a monthly figure, with a toggle to daily. Skippable; default goal logic in §6.4 applies if skipped.
6. Model initialised (§5). Popup shows: baseline per post (median of recent 24h or lifetime totals), best posting hours seen so far, regime label.

**Mode B, with export. Optional, in Settings, not in the first-run flow.**

The user drops LinkedIn's creator analytics `.xlsx` into the options page. It adds up to 50 posts with lifetime impressions and the follower series (§4.6). Recommended for users who post daily, since it gives 25+ posts on day one. Import is idempotent: posts merge by URN, daily values overwrite by date.

### 3.2 Running

- Every LinkedIn page view runs a light content script. When it sees a post authored by the user, an analytics page, or the account 7-day total, it writes a snapshot or daily reading. Dedup rule: one snapshot per (post, minute); one daily reading per (UTC date, minute).
- **Overlay** under each of the user's own posts in the feed and on the post page, one line: `1,530 now · 24h ≈ 2,550 (2,300 to 2,850) · 180/h`. On the analytics page, one line above the chart: `Today 2,512 so far · EOD ≈ 3,400 (3,200 to 3,650) · pace needs 3,650/day`. The overlay is an injected element with its own shadow DOM; it never modifies LinkedIn's nodes.
- **Popup**: Today (EOD forecast, interval, goal pace), Live posts (younger than 48h, with current count, 24h forecast, hourly gain, tail-mode flag), Goal, Accuracy (§7), a "capture health" indicator (last successful read per page type, failing selectors).
- **Options page**: goal (daily/monthly, number), quiet hours, auto-visit toggle and cadence, notification cap, timezone override, export data (JSON and CSV), import export file, reset.

### 3.3 Auto-visit (optional, default ON for a personal build, configurable)

Opens the user's own pages in a background tab (`chrome.tabs.create({active:false})`), waits for the content script to report a successful read or 15 s timeout, closes the tab.

Schedule (chrome.alarms), only while Chrome is running and outside quiet hours (default quiet 23:00 to 07:00 local):

- Analytics page: every 60 min.
- Post-summary page of each post younger than 48h: every 30 min.
- Forced reads at t+55 min and t+115 min after a detected new post, so golden-hour nudges have a fresh number.

Backoff: if a visit fails to read (selectors broken, logged out, rate-limit page), double the interval up to 4 h and show a "capture failing" badge on the popup. Never retry more than once per failure. Hard cap 60 visits per day.

This is automation under LinkedIn's terms even if it only touches the user's own pages. The toggle text must say so plainly.

---

## 4. Data capture

### 4.1 Pages and what each provides

| Page (URL pattern) | Data | Source |
|---|---|---|
| `/analytics/creator/content/` | Daily impressions series, timezone, Top Posts (URNs, impressions), followers | Rehydration payload + hydrated DOM |
| `/analytics/post-summary/urn:li:activity:<id>/` | This post's impressions, members reached, in-network vs out-of-network %, reactions, comments, reposts | Rehydration payload + hydrated DOM |
| `/feed/` and `/feed/update/urn:li:activity:<id>/` | Own posts: URN, impressions count, post type, actor = self; account 7-day total in left rail | DOM |
| `/in/<slug>/recent-activity/all/` | Legacy Ember shell; empty until client render. Do not depend on it; Top Posts and the export cover it. | Skip |
| Notifications | "Your post has N impressions" cards | DOM text pattern, opportunistic |

### 4.2 Rehydration payload (primary source on React pages)

LinkedIn's newer pages embed their data in:

```html
<script id="rehydrate-data">window.__como_rehydration__ = ["...", "...", ...];</script>
```

The value is a JSON array of string chunks (a React Flight stream). Parse:

```ts
const el = document.querySelector('script#rehydrate-data');
const raw = el?.textContent ?? '';
const json = raw.slice(raw.indexOf('=') + 1).trim().replace(/;$/, '');
const text: string = JSON.parse(json).join('');   // one big string containing JSON fragments
```

Then extract with regex over `text` (the fragments are not one valid JSON document; do not try to parse the whole thing):

- **Daily series** (Highcharts config): find `"name":"Impressions"`, then the following `"data":[...]` array of `{"y":N,"x":epochMs}`. `x` is midnight UTC of the day; `y` the impressions. The last point is the current day and is partial. Verified to match the `.xlsx` export exactly on completed days.
- **Timezone**: first `"timezone":"<IANA>"` occurrence; fall back to `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- **Own profile id**: `"currentUserNonIterableProfileId":"<id>"` (used to tag data, never sent anywhere).
- **Post identifiers** on feed/post pages: `"activityId":"<19 digits>"`, `"postSlugUrl":"..."`, optionally `"shareId"`. Prefer `activityId`.

If the script tag is absent (legacy page), fall back to `code[id^="bpr-guid-"]` elements containing JSON envelopes, or to DOM text patterns (§4.3). Log which path succeeded.

### 4.3 DOM hooks (stable attributes only)

Never select on class names; they are build hashes. Use `href`, `aria-label`, `data-testid`, `id`, and text patterns.

| Data | Selector / rule |
|---|---|
| Own-post analytics link (also proves authorship) | `a[href*="/analytics/post-summary/urn:li:activity:"]` |
| Post impressions (own post, feed or post page) | Inside the card containing that link: `[aria-label="Content analytics"] p` or the link's own text; match `/^([\d,.]+)\s+impressions$/i` |
| Post URN | From that href: `/urn:li:activity:(\d+)/` |
| Actor is self (secondary check) | Actor link `aria-label` ends with ` You` |
| Account 7-day impressions (left rail, feed and post pages) | `a[href$="/analytics/creator/content/"] [aria-label^="Post impressions"]`, parse the number in the aria-label or inner text |
| Post type | `[data-vjs-player]` or `button[aria-label="Play video"]` → `video`; `img[src*="feedshare-shrink"]` → `image`; document viewer present → `document` (unverified selector, use text "Download" button heuristic); else `[data-testid="expandable-text-box"]` → `text` |
| Feed container | `[data-testid="mainFeed"]` (observe for inserted cards) |
| Analytics chart placeholder | `[data-testid="chart-loader"]` present means chart not yet drawn; never read the SVG, use the payload |
| Analytics lazy sections | `#impressionsBreakdownCA` (in-network %), `#membersReachedFeatureCA`, `#topPostFeature`, `#demographicsFeatureCA`; attach a `MutationObserver`, read when text matching `/\d/` appears, timeout 10 s |

Number parsing: strip `,` and `.` thousands separators by locale; accept `1.2K`, `3,4 mil`, `12K` (K = 1000, M = 1e6); reject if the result is not finite.

### 4.4 Publish time from the URN

The activity id is a 64-bit snowflake-style integer; the top bits are a millisecond epoch:

```ts
const publishedAt = new Date(Number(BigInt(activityId) >> 22n));
```

Example: `7503731490816000000` → `2026-09-10T08:30:00.000Z`.

Caveat: the id is minted when the share is created, not when it goes live. Scheduled posts therefore decode to their scheduling time (often odd hours). Rule: if the decoded local hour is outside 06:00 to 23:00, or disagrees by more than 60 minutes with a relative label on the page ("3h", "2d"), trust the label, set `publishedApprox = true`, and refine later from the first snapshot (a post cannot have impressions before it is live).

### 4.5 Snapshot sources and precedence

Tag every snapshot with `source ∈ {post_summary, feed, post_page, notification, export}`. When two readings for the same post fall within 10 minutes, keep `post_summary` over `feed`/`post_page` (feed counts can lag by minutes).

### 4.6 Export file (`.xlsx`) parser

Sheet names and header rows shift between LinkedIn versions. Detect by content, not position: scan the first 15 rows for a header row containing the required column names (case-insensitive substring match).

| Sheet (name contains) | Required headers | Yields |
|---|---|---|
| `DISCOVERY` or `ENGAGEMENT` | `date`, `impressions` (optional `engagements`) | Daily series, one row per day |
| `TOP POSTS` | `post`/`url`, `impression` | Two side-by-side tables (engagements table, impressions table). Take the impressions table. URL contains the 19-digit URN id. Publish date column is a date only, no time. |
| `FOLLOWERS` | `date`, `follower` | Follower series |
| `DEMOGRAPHICS` | ignore | |

Dates appear as `M/D/YYYY`, ISO, or Excel serials; try each. Posts from the export have `publishedApprox = true` unless the URN decode gives a plausible time (then use it).

---

## 5. Forecast model

One model, about 150 lines, deterministic, no dependencies. It answers three questions and applies one rule. All state is a JSON object (§6.2). Reference vectors in §9 must be reproduced within 0.5%.

### 5.1 Tables and constants

```ts
// Share of a post's 24h total reached at h hours after publish (prior: morning weekday post)
S_POST = {0.5:0.10, 1:0.18, 2:0.30, 3:0.40, 4:0.48, 5:0.56, 6:0.63, 8:0.74,
          10:0.82, 12:0.87, 15:0.92, 18:0.95, 21:0.98, 24:1.00}

// Share of a UTC day's recorded impressions reached at u hours after 00:00 UTC.
// Prior assumes the account's main post lands about 07:30 UTC (Central European morning).
S_DAY  = {6:0.05, 8:0.12, 10:0.30, 11:0.40, 12:0.50, 13:0.58, 14:0.66, 15:0.73,
          16:0.79, 17:0.85, 18:0.90, 19:0.94, 20:0.96, 21:0.98, 22:0.99, 24:1.00}

DOW = [1.05, 1.10, 1.10, 1.05, 0.90, 0.70, 0.75]   // Mon..Sun multiplier on a day's total
ALPHA = 0.30            // exponential smoothing rate when an actual arrives
PRIOR_WEIGHT = 0.35     // shrinkage toward the account median
TAIL_MODE_RATIO = 0.20  // hourly gain below 20% of first-hour gain = tail mode
SECOND_POST_RETENTION = 0.70  // each of two same-day posts keeps ~70%
TYPE_PRIOR = {video: 1.5, image: 1.0, text: 1.0, document: 1.1, unknown: 1.0}
DAY_CAPTURE_TARGET = 0.90   // "post by" time: share of a post's 24h that must land before 00:00 UTC
```

**Onboarding shift of S_DAY.** Compute the account's median publish UTC hour from decoded times of the last 10 posts, `delta = round(median − 7.5)`. Rebuild S_DAY with keys `k + delta`, drop keys outside (0, 24), force `S_DAY[24] = 1.0`, and keep it monotone. Learning (§5.5) corrects the rest within a week.

**Interpolation.** Linear between keys. Below the first key: `S[k0] * max(x / k0, 0.02)`. Above the last: last value. Every share used in a division is floored at 0.02.

### 5.2 Post 24h forecast

Inputs: `h` hours since publish, `impressions` now, `recentTotals` = last 10 own posts' 24h actuals (if fewer than 3, fall back to lifetime totals from export/Top Posts divided by 1.6), `type`.

```
s       = max(S_POST(h), 0.02)
implied = impressions / s
if recentTotals non-empty:
    med   = median(recentTotals) * typeFactor      // typeFactor = learned per-type median ratio after 5 posts of that type, else TYPE_PRIOR
    w     = min(s, 1)
    total = exp( (w*ln(implied) + (1−w)*PRIOR_WEIGHT*ln(med)) / (w + (1−w)*PRIOR_WEIGHT) )
else:
    total = implied
sd      = 0.08 + 0.45*(1 − min(s,1))               // log-space
low, high = total*exp(−1.28*sd), total*exp(1.28*sd)   // 80% interval
```

Use the latest snapshot. If two snapshots exist at least 20 minutes apart, also report `gainPerHour = Δimpressions / Δhours`.

**In-network adjustment (only when the post-summary page gives in-network %)**: `total *= clamp(exp(1.0 * (0.55 − inNetworkShare)), 0.75, 1.25)`. Lower in-network share at the same time means wider distribution.

### 5.3 Daily EOD forecast

Inputs: `u` hours since 00:00 UTC, `dailyNow` (today's running total).

```
s     = max(S_DAY(u), 0.02)
total = dailyNow / s
sd    = 0.06 + 0.35*(1 − min(s,1))
low, high = total*exp(∓1.28*sd)
```

`dailyNow` sources, in order of preference: (1) today's partial point in the analytics daily series; (2) left-rail 7-day total minus the sum of the six previous completed days from stored history (available on every feed load; flag as `derived`); (3) sum of today's gains across live posts (lower bound, flag as `partial`).

Split shown to the user: `fromTodayPosts = Σ (current impressions of posts published today, within this UTC day)`, `fromTails = dailyNow − fromTodayPosts` (floor 0).

### 5.4 Day-ahead

```
base = mean(last 7 recorded UTC days)
dayAhead(d) = base * DOW[weekday(d)] / (mean(DOW))
```

If no post is planned that day, the user can toggle "no post" and the forecast becomes tails only: `0.30 * base`.

### 5.5 Learning

When a post's 24h actual arrives (a snapshot with `h ≥ 23.5`, interpolated to exactly 24h using S_POST shape, or the first snapshot after 24h capped by `min(v/actual, 1)`): for each earlier snapshot `(h, v)` of that post, pick the nearest key `k` in S_POST and set `S_POST[k] = (1−ALPHA)*S_POST[k] + ALPHA*min(v/actual, 1)`. Then enforce monotone non-decreasing. Push `actual` onto `recentTotals` (keep 10). Increment `nPostActuals`. Update the per-type ratio.

When a UTC day closes (its value in the daily series is read on a later day; take the latest value LinkedIn shows, it can revise for up to 48 h): for each daily reading `(u, v)` of that day, same update on S_DAY. Push onto `recentDaily` (keep 14). DOW factor: after 4 weeks of data, `DOW[i] = (1−ALPHA)*DOW[i] + ALPHA * mean(days with weekday i) / mean(all days)`, renormalised to mean 1.

### 5.6 Second-post rule

Evaluate at the candidate time `t`, not at the last snapshot:

```
firstHourGain = impressions at t+60min (interpolated)
lastHourGain  = impressions(t) − impressions(t − 60min)
tailMode      = lastHourGain < TAIL_MODE_RATIO * firstHourGain
verdict       = !tailMode ? "wait"
              : (7 ≤ localHour(t) ≤ 18) ? "post" : "weak slot: tomorrow morning"
```

Price of a second post today: `hRemaining = hours from t to 00:00 UTC`, `addToday ≈ SECOND_POST_RETENTION * median(recentTotals) * S_POST(min(hRemaining, 24))`. Cost: the first post also loses about 30% of what it would still have earned; the nudge states the add, not the net.

Heuristic constants for the copy: two posts a day give roughly 1.3x to 1.5x one post; plain reposts contribute about nothing; video runs about 1.5x text and keeps earning overnight.

### 5.7 Goal and pace

- If the user sets a **daily** goal `G`: `pace = G`.
- If **monthly** goal `M`: `remaining = M − Σ recorded days this month (UTC)`, `pace = remaining / remainingDays`, weighted so weekday pace = pace * DOW[i] / mean(DOW).
- If no goal set: `pace = mean(last 3 completed days) * DOW[today] / mean(DOW)`.

"Post by" time for a normal day: the latest local time `T` such that `S_POST(hours from T to 00:00 UTC) ≥ DAY_CAPTURE_TARGET`. With the prior table that is about 13.8 h before UTC midnight.

---

## 6. Storage

### 6.1 IndexedDB (database `lif`, version 1)

| Store | Key | Fields |
|---|---|---|
| `posts` | `urn` | `publishedAt` (ISO), `publishedApprox` (bool), `type`, `textPreview` (first 80 chars), `firstSeenAt`, `actual24h?`, `lifetime?` |
| `snapshots` | auto | `urn`, `observedAt`, `impressions`, `inNetworkShare?`, `membersReached?`, `reactions?`, `comments?`, `reposts?`, `source`. Index on `urn`, on `observedAt`. |
| `daily` | `utcDate` (YYYY-MM-DD) | `impressions`, `engagements?`, `final` (bool), `source`, `updatedAt` |
| `dailyReadings` | auto | `utcDate`, `observedAt`, `value`, `source`. Index on `utcDate`. |
| `followers` | `utcDate` | `count` |
| `forecasts` | auto | `createdAt`, `target` (`post`/`day`), `key` (urn or utcDate), `horizon` (`24h`/`eod`/`dayahead`), `point`, `low`, `high`, `shareObserved`, `modelVersion`, `regime`, `actual?`, `errorPct?`, `inBand?`. Index on `key`. |
| `nudges` | auto | `type`, `firedAt`, `key`, `text`, `clicked` |

### 6.2 chrome.storage.local

- `settings`: `{goal:{kind:'daily'|'monthly'|null, value}, quietHours:{start:23, end:7}, autoVisit:{enabled, analyticsMin:60, postMin:30}, notifCap:4, tzOverride?, overlay:true}`
- `model`: `{sPost, sDay, dow, recentTotals, recentDaily, nPostActuals, typeRatio, version}`
- `onboarding`: `{step, done, profileId?, timezone}`
- `captureHealth`: `{[pageType]: {lastOkAt, lastErrorAt, lastError}}`

Log a forecast every time one is computed for display, but at most one per (target, key, horizon) per 15 minutes.

---

## 7. Accuracy tracking

When an actual arrives, fill every open forecast for that key: `errorPct = (point − actual)/actual`, `inBand = low ≤ actual ≤ high`.

Popup "Accuracy" view: rolling 14-day MAPE by horizon; MAPE bucketed by `shareObserved` (<0.25, 0.25 to 0.5, 0.5 to 0.8, >0.8); interval coverage (target 80%; if below 65% over 20+ forecasts, widen `sd` by 10%; if above 92%, narrow by 10%); MAPE by post type; a sparkline of daily EOD error over time.

Expected performance from a comparable model on real data: daily EOD within ~10% by mid-afternoon, post 24h within ~25% at the 3h mark once 10 posts have actuals. Day-ahead forecasts run 25 to 35% MAPE because post quality is unobservable before the first reading; the product's value is in intraday readings, and the UI should say so in the regime tooltip.

---

## 8. Nudges

Chrome notifications, one line each, one action button, max `notifCap` per day (default 4), none during quiet hours, deduplicated per (type, key, day). Text templates use the user's local time.

| # | Trigger | Condition | Text template | Action |
|---|---|---|---|---|
| 1 | Golden hour check, t+60 after a new own post is detected | A reading at 50 to 70 min exists (auto-visit forces one; else ask) | "Post at {n} after 1h: {label} start for you. Push 5 comments on other posts now." `label`: below 0.7x median first-hour = slow, 0.7 to 1.3x = average, above = strong. Median first-hour from stored posts, interpolated to 60 min. | Open post |
| 1b | Same, no reading | No snapshot in 50 to 70 min window and auto-visit off | "Open your post once so I can read the first hour." | Open post |
| 2 | Golden hour close, t+120 | Forecast moved >15% since #1 or crossed the median | "{n} at 2h{inNetwork? ', {p}% in-network: travelling' : ''}. 24h forecast {point}." | Open post |
| 3 | Second post decision | First post of the day in tail mode, or 15:30 local, whichever first; weekdays; suppressed if EOD forecast ≥ pace | "First post at {gain}/h, tail mode. Day heading to {eod} vs {pace} target. A post at {bestSlot} adds about {add} today." | Open compose |
| 4 | Morning plan, 08:00 local | No own post yet today | "Yesterday {y}. Last 3 days averaged {avg3}. Post by {postBy} for a normal day." | Open feed |
| 5 | Scorecard, 09:00 local | Yesterday closed and had an EOD forecast | "Yesterday: forecast {point}, actual {actual} ({err}%). 14-day error {mape}%." | Open popup |

`bestSlot` = next whole local hour in 07:00 to 18:00 with the highest historical first-hour reading for this account, defaulting to 17:00 if fewer than 5 posts.

---

## 9. Reference vectors (model port must match)

Using the prior tables, `PRIOR_WEIGHT 0.35`, no type factor, no in-network adjustment:

| Case | Input | Expected `point / low / high` |
|---|---|---|
| A | post_24h(h=6.0, impressions=1300, recent=[2000,2500,2200]) | 2086 / 1522 / 2860 |
| B | post_24h(h=1.5, impressions=600, recent=[]) | 2500 / 1457 / 4291 |
| C | post_24h(h=1.5, impressions=600, recent=[1800,2000,2600,2200,2400]) | 2338 / 1362 / 4012 |
| D | daily_eod(u=16.0, dailyNow=3148) | 3985 / 3359 / 4727 |
| E | daily_eod(u=9.5, dailyNow=900) | 3529 / 2341 / 5321 |
| F | day_ahead with recentDaily=[3400,2900,4100,3800,2700,2100,2300] | Tuesday 3523; Saturday 2242 |
| G | learn_post(readings=[(3.0,900),(6.0,1500)], actual=2400) from priors | S_POST[3]=0.3925, S_POST[6]=0.6285 |
| H | second post add: median 2400, 7 h to UTC midnight | ≈1151 |
| I | URN `7503731490816000000` | publishedAt `2026-09-10T08:30:00Z` |

Synthetic fixture for end-to-end tests (`fixtures/account-a.json`): a fictional account with 28 daily values around a mean of 3,200 (weekend dip to ~2,300), 20 posts with 24h actuals between 1,400 and 5,000, one video post at 4,800, two days with two posts, and a replay of intraday snapshots for the last 5 days. Assertions: after replay, the EOD forecast at u=16 on each day is within 15% of the recorded value on at least 4 of 5 days; interval coverage ≥ 3 of 5.

---

## 10. Architecture

```
manifest.json                MV3; permissions: storage, alarms, notifications, tabs (auto-visit), scripting
src/
  content/
    index.ts                 route by URL, run the matching reader, post results to background
    readers/analytics.ts     payload daily series, timezone, Top Posts observer
    readers/postSummary.ts   per-post reading + lazy sections
    readers/feed.ts          own-post cards, left-rail 7-day total, MutationObserver on mainFeed
    readers/notifications.ts opportunistic counts
    payload.ts               rehydration parsing (§4.2)
    selectors.ts             every selector and regex in one file
    overlay.ts               shadow-DOM one-liner under own posts / above chart
  background/
    index.ts                 message router, alarm handlers
    store.ts                 IndexedDB wrapper
    engine.ts                model glue: on new snapshot → recompute → log forecast → check nudges
    autovisit.ts             tab manager, backoff, daily cap
    nudges.ts                rules from §8
  model/
    simple.ts                §5 (pure functions, no browser APIs)
    urn.ts                   §4.4
    export.ts                §4.6 (SheetJS)
  ui/
    popup/                   Preact: Today, Live posts, Goal, Accuracy, Health
    options/                 settings, import, export, reset
tests/
    model.test.ts            reference vectors §9
    payload.test.ts          against saved HTML fixtures (redacted)
    replay.test.ts           fixtures/account-a.json
fixtures/
```

Stack: TypeScript, Vite with `@crxjs/vite-plugin` (or esbuild), Preact, Vitest, SheetJS for `.xlsx`. No other runtime dependencies. Message passing via `chrome.runtime.sendMessage` with a typed union of `{type: 'snapshot'|'daily'|'posts'|'health', payload}`.

Service worker lifetime: MV3 workers sleep; every alarm handler must load state from storage, never rely on module globals. Content scripts run at `document_idle` and additionally observe DOM mutations for 30 s, since LinkedIn hydrates lazily.

Privacy: no network requests except to `linkedin.com` pages the user's browser opens. The options page states this. Export/import of the local database as JSON lets the user back up or move machines.

---

## 11. Build order and acceptance

1. **Capture** (first milestone). Readers for analytics, post-summary, feed; payload parser; URN decode; IndexedDB store; a debug panel listing captured snapshots and daily values. Accept: on a live account, daily series equals the analytics chart; a post's reading equals the number rendered on the page; health panel shows a green tick per page type.
2. **Engine**. `model/simple.ts` passing §9; engine wiring; popup Today and Live posts; forecast logging with actual fill-in. Accept: vectors pass; after one full day, the scorecard shows a filled EOD error.
3. **Nudges**. Alarms per new post; 08:00, 15:30, 09:00 daily checks; quiet hours; cap. Accept: a post detected at 10:00 produces #1 at 11:00 and #2 at 12:00 (with auto-visit on) in a manual test.
4. **Onboarding and auto-visit**. Mode A flow with progress; auto-visit with backoff and cap; export import (Mode B) in options. Accept: fresh profile reaches "model initialised" in under 3 minutes with auto-visit on.
5. **Hardening**. Text-pattern fallbacks for every selector; "capture failed" banner instead of silent zeros; interval auto-calibration (§7); data export/import; per-type factors.

Ship as an unpacked extension. A Web Store listing requires auto-visit off by default and "reads pages you visit" language.

---

## 12. Risks and mitigations

- **Markup changes.** All selectors in `selectors.ts`; payload regexes first, DOM second, text patterns third; health panel makes breakage visible within one page load.
- **Automation exposure.** Auto-visit only opens the user's own pages, capped and backed off, off by default in any public build, clearly labelled.
- **Feed count lag.** Source precedence (§4.5).
- **Scheduled posts.** URN time sanity rule (§4.4); first-snapshot refinement.
- **Same-day double posts.** Handled natively because forecasts are per post from direct readings; the daily model needs no decomposition.
- **Timezone drift.** UTC everywhere in storage; convert only for display and for the local-hour conditions in §5.6 and §8.
- **Sleeping service worker.** Alarms and storage-loaded state; nudges that need a fresh number degrade to "open your post once".
