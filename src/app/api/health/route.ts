import { withHandler } from "@/server/lib/handler";
import { getHealth } from "@/server/modules/health/health.controller";
export const runtime = "nodejs";
export const GET = withHandler(getHealth);
