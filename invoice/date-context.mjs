export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export function validTimezone(value) {
  if (typeof value === 'string' && value.trim()) {
    try { new Intl.DateTimeFormat('en', {timeZone: value}); return value; } catch {}
  }
  return DEFAULT_TIMEZONE;
}

export function calendarDay(clock = () => new Date(), timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: validTimezone(timezone), year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date(clock()));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Shift calendar dates, not instants: DST must not change a requested day.
export function shiftDay(day, days) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function workspaceTimezone(store, timezone) {
  return validTimezone(timezone ?? (typeof store?.getWorkspaceTimezone === 'function' ? await store.getWorkspaceTimezone() : null));
}
