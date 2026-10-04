import {createHash} from 'node:crypto';
// Fixed ASCII schema keys, recursively sorted to match app.reminder_canonical_json.
export function canonicalReminderJson(value){
  if(Array.isArray(value))return `[${value.map(canonicalReminderJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canonicalReminderJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const reminderFingerprint=value=>createHash('sha256').update(canonicalReminderJson(value)).digest('hex');
