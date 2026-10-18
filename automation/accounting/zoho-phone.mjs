// Zoho accepts formatted phone strings. Unqualified numbers use India as the
// default; explicit international numbers retain their country code.
export function normalizeZohoPhone(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (!/^\+?[\d\s().-]+$/.test(value.trim())) return null;
  let phone = value.replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+')) {
    if (/^0[1-9]\d{9}$/.test(phone)) phone = phone.slice(1);
    if (/^[1-9]\d{9}$/.test(phone)) phone = `+91${phone}`;
    else if (/^91[1-9]\d{9}$/.test(phone)) phone = `+${phone}`;
    else return null;
  }
  if (phone.startsWith('+91') && !/^\+91[1-9]\d{9}$/.test(phone)) return null;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

export function zohoCustomerPhone(item = {}) {
  // Invoice contact_persons can be IDs, while contact_persons_details contains
  // the actual people. Never mistake an ID for a phone number.
  const people = [item.contact_persons, item.contact_persons_details]
    .flatMap(value => Array.isArray(value) ? value : [])
    .filter(value => value && typeof value === 'object');
  const primary = people.filter(person => person.is_primary_contact === true);
  const others = people.filter(person => person.is_primary_contact !== true);
  const candidates = [item.mobile, ...primary.map(person => person.mobile),
    item.phone, ...primary.map(person => person.phone),
    ...others.flatMap(person => [person.mobile, person.phone])];
  return candidates.map(normalizeZohoPhone).find(Boolean) || null;
}
