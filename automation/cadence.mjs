/**
 * Pure follow-up scheduling helpers.
 *
 * Dates are represented as instants (Date/ISO strings) at the engine boundary.
 * Date-only invoice due dates are interpreted in the debtor's IANA timezone.
 */

const WEEKDAYS = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

const WEEKDAY_NAMES = Object.freeze([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

const pad = (value) => String(value).padStart(2, "0");

export function parseClock(value, fallback = { hour: 9, minute: 0 }) {
  const match = String(value ?? "").trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return { ...fallback };
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return { ...fallback };
  return { hour, minute };
}

export function parseCadence(value, fallbackDays = 3) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.max(1, Math.round(value));
  const text = String(value ?? "").toLowerCase();
  const match = text.match(/(\d+)/);
  if (match && /(day|daily|every)/.test(text)) return Math.max(1, Number(match[1]));
  if (/daily|every day|each day/.test(text)) return 1;
  return Math.max(1, Math.round(Number(fallbackDays) || 3));
}

export function parseFirstReminder(value, fallbackDays = 3) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = String(value ?? "").toLowerCase();
  const match = text.match(/(\d+)/);
  if (match && /(day|after|overdue)/.test(text)) return Math.max(0, Number(match[1]));
  return Math.max(0, Math.round(Number(fallbackDays) || 3));
}

export function parseEscalationAfter(value, fallback = 3) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.round(value));
  const match = String(value ?? "").match(/(\d+)/);
  return match ? Math.max(1, Number(match[1])) : Math.max(1, Math.round(Number(fallback) || 3));
}

export function timezoneParts(value, timeZone = "UTC") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid date");
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "long",
    }).formatToParts(date);
  } catch (error) {
    throw new RangeError(`Invalid timezone: ${timeZone}`);
  }
  const result = {};
  for (const part of parts) if (part.type !== "literal") result[part.type] = part.value;
  return {
    year: Number(result.year), month: Number(result.month), day: Number(result.day),
    hour: Number(result.hour), minute: Number(result.minute), second: Number(result.second),
    weekday: String(result.weekday || "").toLowerCase(),
  };
}

function utcGuessForLocal(local, timeZone) {
  // The offset is obtained by comparing the requested local fields with the
  // timezone's fields at a nearby instant. Two iterations cover DST changes.
  let guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second || 0);
  for (let i = 0; i < 4; i += 1) {
    const got = timezoneParts(new Date(guess), timeZone);
    const wantMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second || 0);
    const gotMs = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    guess += wantMs - gotMs;
  }
  return new Date(guess);
}

export function localDateTimeToDate(local, timeZone = "UTC") {
  return utcGuessForLocal(local, timeZone);
}

export function addLocalDays(local, days) {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + days, local.hour || 0, local.minute || 0, local.second || 0));
  return { ...local, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function dateOnlyParts(value) {
  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0, second: 0 };
}

function allowedWeekdays(settings) {
  const configured = Array.isArray(settings?.weekdays) ? settings.weekdays : [];
  const days = configured.map((day) => typeof day === "number" ? day : WEEKDAYS[String(day).toLowerCase()]).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return new Set(days.length ? days : [1, 2, 3, 4, 5]);
}

export function isWithinContactHours(value, settings = {}, timeZone = "UTC") {
  const local = timezoneParts(value, timeZone);
  const start = parseClock(settings.hoursStart ?? settings.contactHoursStart, { hour: 9, minute: 0 });
  const end = parseClock(settings.hoursEnd ?? settings.contactHoursEnd, { hour: 18, minute: 0 });
  const current = local.hour * 60 + local.minute;
  const from = start.hour * 60 + start.minute;
  const until = end.hour * 60 + end.minute;
  return current >= from && current < until && allowedWeekdays(settings).has(WEEKDAYS[local.weekday]);
}

/** Return the first allowed contact instant on or after `value`. */
export function nextContactTime(value, settings = {}, timeZone = "UTC") {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid date");
  const start = parseClock(settings.hoursStart ?? settings.contactHoursStart, { hour: 9, minute: 0 });
  const end = parseClock(settings.hoursEnd ?? settings.contactHoursEnd, { hour: 18, minute: 0 });
  const weekdays = allowedWeekdays(settings);
  let local = timezoneParts(date, timeZone);
  let first = true;
  for (let i = 0; i < 370; i += 1) {
    const weekday = WEEKDAYS[local.weekday];
    if (weekdays.has(weekday)) {
      const current = local.hour * 60 + local.minute;
      const from = start.hour * 60 + start.minute;
      const until = end.hour * 60 + end.minute;
      if (current < from) return localDateTimeToDate({ ...local, hour: start.hour, minute: start.minute, second: 0 }, timeZone);
      if (current >= from && current < until) return first ? date : localDateTimeToDate({ ...local, second: 0 }, timeZone);
    }
    const next = addLocalDays({ ...local, hour: 0, minute: 0, second: 0 }, 1);
    local = { ...next, weekday: WEEKDAY_NAMES[new Date(Date.UTC(next.year, next.month - 1, next.day)).getUTCDay()] };
    first = false;
  }
  throw new Error("Could not find a contact time");
}

export function scheduleInitialFollowUp(invoice, settings = {}, now = new Date()) {
  const timeZone = invoice?.debtor_timezone || settings.timezone || "UTC";
  const due = dateOnlyParts(invoice?.due_date) || timezoneParts(now, timeZone);
  const days = parseFirstReminder(settings.firstReminder ?? settings.first_reminder_days, 3);
  const local = addLocalDays({ ...due, hour: parseClock(settings.hoursStart ?? settings.contactHoursStart).hour, minute: parseClock(settings.hoursStart ?? settings.contactHoursStart).minute, second: 0 }, days);
  return nextContactTime(localDateTimeToDate(local, timeZone), settings, timeZone);
}

export function scheduleNextFollowUp(from, settings = {}, timeZone = "UTC") {
  const local = timezoneParts(from, timeZone);
  const cadenceDays = parseCadence(settings.cadence ?? settings.cadenceDays, 3);
  const start = parseClock(settings.hoursStart ?? settings.contactHoursStart, { hour: 9, minute: 0 });
  const target = addLocalDays({ ...local, hour: start.hour, minute: start.minute, second: 0 }, cadenceDays);
  return nextContactTime(localDateTimeToDate(target, timeZone), settings, timeZone);
}

export function cadenceSettings(settings = {}) {
  return {
    ...settings,
    firstReminderDays: parseFirstReminder(settings.firstReminder ?? settings.first_reminder_days, 3),
    cadenceDays: parseCadence(settings.cadence ?? settings.cadenceDays, 3),
    escalationAfter: parseEscalationAfter(settings.escalation ?? settings.escalationAfter, 3),
  };
}

export const weekdayNames = WEEKDAY_NAMES;
