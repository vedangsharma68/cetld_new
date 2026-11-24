/** Provider labels are optional and unbounded. They must never block signup. */
export function providerDisplayName(value: string | null | undefined): string {
  return Array.from(value?.trim() || "New member")
    .slice(0, 160)
    .join("");
}
