const clockPattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const tones = new Set(['gentle', 'professional', 'firm']);

function integer(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

export function normalizeFollowUpPreferences(raw = {}, timezone = 'Asia/Kolkata') {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const start = input.contactStart ?? input.hoursStart ?? '09:00';
  const end = input.contactEnd ?? input.hoursEnd ?? '18:00';
  if (!clockPattern.test(start) || !clockPattern.test(end) || start >= end) throw new RangeError('Invalid contact window');
  const weekdays = input.allowedWeekdays ?? input.weekdays ?? [1, 2, 3, 4, 5];
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new RangeError('Invalid allowed weekdays');
  const tz = input.timezone || timezone;
  try { new Intl.DateTimeFormat('en', {timeZone: tz}).format(); } catch { throw new RangeError('Invalid timezone'); }
  return {
    tone: tones.has(input.tone) ? input.tone : 'professional',
    firstReminderDays: integer(input.firstReminderDays ?? input.first_reminder_days, 3, 0, 90),
    cadenceDays: integer(input.cadenceDays, 3, 1, 90),
    maxReminders: integer(input.maxReminders, 3, 1, 20),
    weekdays: [...new Set(weekdays)],
    hoursStart: start,
    hoursEnd: end,
    escalation: input.escalation === 'pause' ? 'pause' : 'manual_review',
    pauseOnReply: input.pauseOnReply !== false,
    stopOnPayment: input.stopOnPayment !== false,
    dailySummary: input.dailySummary === true,
    timezone: tz,
    version: input.version ?? null,
  };
}

export function reminderBody(invoice, settings) {
  const number = String(invoice.invoice_number ?? invoice.number ?? invoice.id ?? 'your invoice').slice(0, 100);
  if (settings.tone === 'gentle') return `A gentle reminder that invoice ${number} is still outstanding. If you have already paid, please let us know. Thank you.`;
  if (settings.tone === 'firm') return `Invoice ${number} remains outstanding. Please arrange payment or contact us with an update. If already paid, please share the payment details.`;
  return `A reminder that invoice ${number} remains outstanding. Please let us know if you have already paid.`;
}
