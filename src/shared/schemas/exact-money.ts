import { z } from "zod";
export const exactMoneySchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/,
    "Use a non-negative decimal amount with at most two decimals",
  );
export function moneyUnits(value: string): bigint {
  const checked = exactMoneySchema.parse(value);
  const [whole, fraction = ""] = checked.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function moneyString(units: bigint): string {
  if (units < 0n) throw Error("Negative money");
  return `${units / 100n}.${String(units % 100n).padStart(2, "0")}`;
}
