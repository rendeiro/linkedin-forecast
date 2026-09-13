/** §4.4 publish time from the activity id. */
export function decodeUrnTime(activityId: string): Date | null {
  if (!/^\d{15,20}$/.test(activityId)) return null;
  try {
    const ms = Number(BigInt(activityId) >> 22n);
    if (!Number.isFinite(ms) || ms < 1.2e12 || ms > 4e12) return null;
    return new Date(ms);
  } catch {
    return null;
  }
}

export function urnFromHref(href: string | null | undefined): string | null {
  const m = href?.match(/urn:li:activity:(\d+)/);
  return m ? m[1] : null;
}

/** Parse "3h", "2d", "45m", "1w", "3 hours ago", "2 days" into hours. */
export function ageLabelToHours(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d+)\s*(m|min|h|hr|hour|d|day|w|week|mo|month)\w*/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('mo')) return n * 24 * 30;
  if (unit.startsWith('m')) return n / 60;
  if (unit.startsWith('h')) return n;
  if (unit.startsWith('d')) return n * 24;
  if (unit.startsWith('w')) return n * 24 * 7;
  return null;
}

/**
 * Apply the sanity rule: if the decoded local hour is outside 06:00 to 23:00, or disagrees
 * with a relative label by more than 60 minutes, trust the label and mark approximate.
 */
export function resolvePublishedAt(
  activityId: string,
  now: Date,
  opts: { ageHintHours?: number | null; localHourOf?: (d: Date) => number } = {},
): { publishedAt: Date; approx: boolean } {
  const decoded = decodeUrnTime(activityId);
  const hint = opts.ageHintHours ?? null;
  const fromHint = hint !== null ? new Date(now.getTime() - hint * 3600_000) : null;
  if (!decoded) return { publishedAt: fromHint ?? now, approx: true };
  const lh = opts.localHourOf ? opts.localHourOf(decoded) : decoded.getHours();
  const oddHour = lh < 6 || lh >= 23;
  const disagrees = fromHint !== null && Math.abs(fromHint.getTime() - decoded.getTime()) > 60 * 60_000 * Math.max(1, hint! / 24);
  if (oddHour || disagrees) {
    if (fromHint) return { publishedAt: fromHint, approx: true };
    return { publishedAt: decoded, approx: true };
  }
  if (decoded.getTime() > now.getTime()) return { publishedAt: now, approx: true };
  return { publishedAt: decoded, approx: false };
}
