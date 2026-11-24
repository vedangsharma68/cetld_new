import "server-only";
// Port of the installed legacy allocator. Repository supplies complete history,
// a database-current date, and trusted owner-number intent under a workspace lock.
export type NumberHistory = {
  id: string;
  invoiceNumber: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
};
type Pattern = {
  family: string;
  key: string;
  prefix: string;
  dateSeparator: string;
  sequenceSeparator: string;
  width: number;
  value: bigint;
};
const bigint = (v: string) => {
  const n = BigInt(v);
  if (n > 9223372036854775807n)
    throw Error("Invoice number exceeds bigint range");
  return n;
};
export function invoiceNumberPattern(value: string): Pattern | null {
  let m = value.match(
    /^(.*?)(20[0-9]{2})([-/.])([0-9]{2})\3([0-9]{2})([^0-9]+)([0-9]+)$/,
  );
  if (m)
    return {
      family: "date_delimited",
      key: `date-delimited:${m[1]}:${m[3]}:${m[6]}:${m[7]!.length}`,
      prefix: m[1]!,
      dateSeparator: m[3]!,
      sequenceSeparator: m[6]!,
      width: m[7]!.length,
      value: bigint(m[7]!),
    };
  m = value.match(/^(.*?)(20[0-9]{2})([0-9]{2})([0-9]{2})([^0-9]+)([0-9]+)$/);
  if (m)
    return {
      family: "date_compact",
      key: `date-compact:${m[1]}:${m[5]}:${m[6]!.length}`,
      prefix: m[1]!,
      dateSeparator: "",
      sequenceSeparator: m[5]!,
      width: m[6]!.length,
      value: bigint(m[6]!),
    };
  m = value.match(/^(.*?)(20[0-9]{2})([^0-9]+)([0-9]+)$/);
  if (m)
    return {
      family: "year",
      key: `year:${m[1]}:${m[3]}:${m[4]!.length}`,
      prefix: m[1]!,
      dateSeparator: "",
      sequenceSeparator: m[3]!,
      width: m[4]!.length,
      value: bigint(m[4]!),
    };
  m = value.match(/^(.*[^0-9])([0-9]+)$/);
  if (m)
    return {
      family: "prefix",
      key: `prefix:${m[1]}:${m[2]!.length}`,
      prefix: m[1]!,
      dateSeparator: "",
      sequenceSeparator: "",
      width: m[2]!.length,
      value: bigint(m[2]!),
    };
  if (/^[0-9]+$/.test(value)) {
    const padded = /^0[0-9]+$/.test(value);
    return {
      family: "integer",
      key: padded ? `integer:padded:${value.length}` : "integer:plain",
      prefix: "",
      dateSeparator: "",
      sequenceSeparator: "",
      width: padded ? value.length : 0,
      value: bigint(value),
    };
  }
  return null;
}
export function planInvoiceNumber(
  history: NumberHistory[],
  input: {
    sourceNumber: string;
    idempotencyKey: string | null;
    preserveOwnerNumber: boolean;
    today: string;
  },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.today))
    throw Error("Database current date required");
  const source = input.sourceNumber.trim();
  if (input.idempotencyKey !== null) {
    const existing = history.find(
      (h) => h.metadata.assistant_idempotency_key === input.idempotencyKey,
    );
    if (existing)
      return {
        invoiceNumber: existing.invoiceNumber,
        replayed: true,
        sourceInvoiceNumber: null,
      };
  }
  if (input.preserveOwnerNumber && source && source !== "AUTO")
    return {
      invoiceNumber: source,
      replayed: false,
      sourceInvoiceNumber: source,
    };
  const candidates = history
    .filter(
      (h) =>
        h.metadata.test_invoice !== true &&
        h.metadata.test_invoice !== "true" &&
        !String(h.metadata.source_invoice_number ?? "").startsWith(
          "CETLD-TEST-",
        ) &&
        !h.invoiceNumber.startsWith("CETLD-TEST-"),
    )
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id),
    )
    .slice(0, 100);
  const groups = new Map<string, { pattern: Pattern; score: number }>();
  let total = 0;
  candidates.forEach((h, i) => {
    const weight = i < 10 ? 4 : i < 30 ? 2 : 1;
    total += weight;
    const p = invoiceNumberPattern(h.invoiceNumber);
    if (!p) return;
    const old = groups.get(p.key);
    groups.set(p.key, { pattern: p, score: (old?.score ?? 0) + weight });
  });
  const ranked = [...groups.values()].sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  const chosen =
    winner && winner.score * 2 > total && winner.score > (ranked[1]?.score ?? 0)
      ? winner.pattern
      : null;
  const year = input.today.slice(0, 4);
  let max = 0n;
  for (const h of history) {
    if (chosen) {
      const p = invoiceNumberPattern(h.invoiceNumber);
      if (p?.key === chosen.key && p.value > max) max = p.value;
    } else {
      const m = h.invoiceNumber.match(new RegExp(`^INV-${year}-([0-9]+)$`));
      if (m) {
        const value = bigint(m[1]!);
        if (value > max) max = value;
      }
    }
  }
  const next = max + 1n;
  if (next > 9223372036854775807n) throw Error("Invoice sequence exhausted");
  const digits = next.toString().padStart(chosen?.width ?? 4, "0");
  let number: string;
  switch (chosen?.family) {
    case "integer":
      number = digits;
      break;
    case "prefix":
      number = chosen.prefix + digits;
      break;
    case "year":
      number = chosen.prefix + year + chosen.sequenceSeparator + digits;
      break;
    case "date_compact":
      number =
        chosen.prefix +
        input.today.replaceAll("-", "") +
        chosen.sequenceSeparator +
        digits;
      break;
    case "date_delimited":
      number =
        chosen.prefix +
        input.today.replaceAll("-", chosen.dateSeparator) +
        chosen.sequenceSeparator +
        digits;
      break;
    default:
      number = `INV-${year}-${digits}`;
  }
  return {
    invoiceNumber: number,
    replayed: false,
    sourceInvoiceNumber: source && source !== "AUTO" ? source : null,
  };
}
