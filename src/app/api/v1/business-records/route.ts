import { withHandler } from "@/server/lib/handler";
import { businessRecordsController } from "@/server/modules/business-records/business-records.controller";
export const GET = withHandler(businessRecordsController.list);
