const clockPattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const tones = new Set(['gentle', 'professional', 'firm']);
const REMINDER_TEMPLATE_PLACEHOLDERS = new Set(['business_name', 'customer_name', 'invoice_number', 'balance', 'due_date']);
const REMINDER_TEMPLATE_MAX_LENGTH = 1000;

function normalizeReminderPunctuation(value) {
  return String(value ?? '').replace(/(?:,\s*)?\s*[â€”â€“]\s*/g, ', ').replace(/(?:,\s*,\s*)+/g, ', ').replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
}

export function sanitizeReminderTemplate(value) {
  if (typeof value !== 'string') throw new TypeError('Reminder template must be text.');
  const template = normalizeReminderPunctuation(value.replace(/\r\n?/g, '\n').replace(/\t/g, ' '));
  if (template.length > REMINDER_TEMPLATE_MAX_LENGTH) throw new RangeError('Reminder template must be 1,000 characters or fewer.');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(template)) throw new TypeError('Reminder template contains an unsupported control character.');
  for (const [, name] of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if (!REMINDER_TEMPLATE_PLACEHOLDERS.has(name)) throw new TypeError('Unsupported reminder placeholder: {{' + name + '}}');
  }
  if (/[{}]/.test(template.replace(/\{\{[^{}]*\}\}/g, ''))) throw new TypeError('Reminder template contains an incomplete placeholder.');
  return template;
}

export function renderReminderTemplate(template, values = {}) {
  const safeTemplate = sanitizeReminderTemplate(template);
  const fields = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const rendered = safeTemplate.replace(/\{\{([^{}]*)\}\}/g, (_, name) =>
    String(fields[name] ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
  if (rendered.length > 3500) throw new RangeError('Rendered reminder is too long.');
  return rendered;
}

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
    templateButtons: input.templateButtons === true,
    firstReminderDays: integer(input.firstReminderDays ?? input.first_reminder_days, 3, 0, 90),
    cadenceDays: integer(input.cadenceDays, 3, 1, 90),
    maxReminders: integer(input.maxReminders, 3, 1, 20),
    weekdays: [...new Set(weekdays)],
    hoursStart: start,
    hoursEnd: end,
    escalation: input.escalation === 'pause' ? 'pause' : 'manual_review',
    pauseOnReply: input.pauseOnReply !== false,
    stopOnPayment: true,
    businessName: String(input.businessName || '').trim(),
    reminderTemplate: sanitizeReminderTemplate(input.reminderTemplate ?? ''),
    dailySummary: input.dailySummary === true,
    timezone: tz,
    version: input.version ?? null,
  };
}

export function brandedReminder(body, businessName) {
  const name=normalizeReminderPunctuation(String(businessName||''));
  if(!name)throw new Error('Configure a business name before preparing reminders.');
  const text=normalizeReminderPunctuation(String(body||''));
  if (!text) return name;
  if (text === name) return name;
  if (text.endsWith(name)) return text.slice(0,-name.length).trimEnd() + '\n\n' + name;
  return text + '\n\n' + name;
}

export function reminderBody(invoice, settings) {
  const number = String(invoice.invoice_number ?? invoice.number ?? invoice.id ?? 'your invoice').slice(0, 100);
  if (settings.reminderTemplate) {
    const total = Number(invoice.total_amount);
    const paid = Number(invoice.amount_paid || 0);
    const balance = settings.balance ?? invoice.balance ?? invoice.remaining_balance
      ?? (Number.isFinite(total) ? Math.max(0, total - paid).toFixed(2) : '');
    return brandedReminder(renderReminderTemplate(settings.reminderTemplate, {
      business_name: settings.businessName,
      customer_name: settings.customerName ?? invoice.customer_name ?? invoice.client ?? 'Customer',
      invoice_number: number,
      balance,
      due_date: settings.dueDate ?? invoice.due_date ?? '',
    }), settings.businessName);
  }
  const customer=String(settings.customerName ?? invoice.customer_name ?? invoice.client ?? 'Customer').slice(0,200);
  if (settings.tone === 'gentle') return brandedReminder(`Hi, this is ${settings.businessName}. A quick note about invoice ${number} for ${customer}. Questions? Just reply here.`,settings.businessName);
  return brandedReminder(`Hi, this is ${settings.businessName}. Invoice ${number} for ${customer} has an update.`,settings.businessName);
}
