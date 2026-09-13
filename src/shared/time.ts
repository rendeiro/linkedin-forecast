export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export function utcDateOf(d: Date | string | number): string {
  return new Date(d).toISOString().slice(0, 10);
}

export function utcHourOf(d: Date | string | number): number {
  const t = new Date(d).getTime();
  return (t - Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())) / HOUR;
}

export function hoursBetween(a: Date | string | number, b: Date | string | number): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / HOUR;
}

export function addDaysUtc(utcDate: string, n: number): string {
  return utcDateOf(new Date(utcDate + 'T00:00:00Z').getTime() + n * DAY);
}

/** ISO weekday index 0=Mon..6=Sun for a UTC date string. */
export function weekdayOfUtcDate(utcDate: string): number {
  return (new Date(utcDate + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

export function daysInMonthUtc(utcDate: string): number {
  const d = new Date(utcDate + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Fractional local hour (14:30 = 14.5) in the given IANA zone, defaulting to the browser's. */
export function localHour(d: Date | string | number, tz?: string): number {
  const date = new Date(d);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(date);
    const h = Number(parts.find(p => p.type === 'hour')?.value ?? 0) % 24;
    const m = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
    return h + m / 60;
  } catch {
    return date.getHours() + date.getMinutes() / 60;
  }
}

/** Local weekday index 0=Mon..6=Sun in tz. */
export function localWeekday(d: Date | string | number, tz?: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(d));
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name);
}

/** Minutes offset such that localTime = utcTime + offset, for the instant d in tz. */
export function tzOffsetMinutes(d: Date | string | number, tz?: string): number {
  const date = new Date(d);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(date);
    const g = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    return -date.getTimezoneOffset();
  }
}

/** Next instant at which local time in tz equals hour:minute, strictly after `from`. */
export function nextLocalTime(hour: number, minute: number, tz?: string, from = new Date()): Date {
  const offset = tzOffsetMinutes(from, tz);
  const localNow = new Date(from.getTime() + offset * 60000);
  const cand = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), hour, minute, 0));
  let t = cand.getTime() - offset * 60000;
  if (t <= from.getTime()) t += DAY;
  // Re-evaluate offset at the target in case of DST change.
  const off2 = tzOffsetMinutes(t, tz);
  if (off2 !== offset) t += (offset - off2) * 60000;
  return new Date(t);
}

export function fmtLocalTime(d: Date | string | number, tz?: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(d));
}

export function inQuietHours(localH: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return localH >= start && localH < end;
  return localH >= start || localH < end;
}
