const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204', 'DELETED_AT_SCHEMA_MISSING']);
const MISSING_COLUMN_PATTERN = /\bdeleted_at\b/i;

/** Match only Postgres/PostgREST errors that specifically identify deleted_at. */
export function isMissingDeletedAtColumn(error) {
  const code = String(error?.code || error?.data?.code || '');
  if (!MISSING_COLUMN_CODES.has(code)) return false;
  if (code === 'DELETED_AT_SCHEMA_MISSING') return true;
  return MISSING_COLUMN_PATTERN.test([
    error?.message,
    error?.details,
    error?.hint,
    error?.data?.message,
    error?.data?.details,
    error?.data?.hint,
  ].filter(Boolean).join(' '));
}

export function isDeletedInvoice(invoice) {
  return Boolean(invoice?.deleted_at);
}

/**
 * Use the deleted_at predicate when available. A narrowly matched missing
 * column error falls back to the pre-migration query only before this runtime
 * has ever confirmed the column. Returned rows are also filtered in memory
 * whenever deleted_at is present. Negative probes are never cached, so a
 * newly applied migration is detected on the next read.
 */
export function createDeletedAtCompatibility() {
  let capability = null;

  return Object.freeze({
    async read({withDeletedAt, legacy}) {
      if (typeof withDeletedAt !== 'function' || typeof legacy !== 'function') throw new TypeError('both invoice read paths are required');
      try {
        const rows = await withDeletedAt();
        capability = true;
        return Array.isArray(rows) ? rows.filter(row => !isDeletedInvoice(row)) : rows;
      } catch (error) {
        if (!isMissingDeletedAtColumn(error)) throw error;
        // Once a runtime has confirmed the column, never downgrade to an
        // unfiltered query. This also covers a stale positive capability.
        if (capability === true) throw error;
        // Do not cache a negative result: a migration may land while this
        // browser or server instance remains alive. Every later read probes
        // the predicate again and therefore sees the new schema immediately.
        const rows = await legacy();
        return Array.isArray(rows) ? rows.filter(row => !isDeletedInvoice(row)) : rows;
      }
    },
    reset() { capability = null; },
  });
}
