import "server-only";
import { BadRequestError } from "@/server/lib/errors";
// Installed app.create_workspace naming algorithm, supplied a random UUID by
// the caller so this pure plan has no I/O and can be tested independently.
export function planBusinessCreation(name: string, entropyUuid: string) {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 160)
    throw new BadRequestError(
      "Business name must be between 1 and 160 characters",
    );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      entropyUuid,
    )
  )
    throw Error("UUID entropy required");
  const normalizedPrefix = cleanName
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "")
    .slice(0, 55);
  const prefix = normalizedPrefix || "business";
  const slug =
    prefix + "-" + entropyUuid.replaceAll("-", "").slice(0, 8).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug))
    throw new BadRequestError(
      "Business name cannot produce a supported business slug",
    );
  return { name: cleanName, slug };
}
