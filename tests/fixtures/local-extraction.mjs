import {validateInvoiceExtractionWireResponse} from '../../ai/extraction.mjs';

// Script only document facts in guarded engine unit tests; no provider or network.
// Production parsing and containment use the actual local reader in separate tests.
export function localExtraction(wire){
  const {imageContent,...fields}=structuredClone(wire);
  return validateInvoiceExtractionWireResponse(fields);
}
