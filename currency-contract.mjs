export const SUPPORTED_TWO_DECIMAL_CURRENCIES = Object.freeze([
  'INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'CHF',
]);

export const CURRENCY_SUPPORT_MESSAGE =
  'CETLD supports only two-decimal currencies: INR, USD, EUR, GBP, AED, SGD, AUD, CAD, and CHF. Currencies such as JPY, KWD, and BHD are not supported.';

export const AMOUNT_PRECISION_MESSAGE =
  'Amounts must use no more than two decimal places; CETLD never rounds amounts silently.';

const supported = new Set(SUPPORTED_TWO_DECIMAL_CURRENCIES);

export function isSupportedCurrency(value) {
  return supported.has(String(value ?? '').trim().toUpperCase());
}
