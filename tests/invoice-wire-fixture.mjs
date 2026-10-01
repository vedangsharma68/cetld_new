export function invoiceWire(normalized) {
  normalized = {...normalized};
  for (const name of ['currencySource', 'addressHint', 'paymentTerms']) {
    normalized[name] ??= {value: null, confidence: 0};
  }
  const wire = {};
  for (const [name, field] of Object.entries(normalized)) {
    if (name === 'lineItems') {
      wire.lineItems = field.value;
      wire.lineItemsConfidence = field.confidence;
    } else {
      wire[name] = field.value;
      wire[`${name}Confidence`] = field.confidence;
    }
  }
  return wire;
}
