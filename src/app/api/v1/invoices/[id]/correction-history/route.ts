import { withHandler } from "@/server/lib/handler";
import { invoiceCorrectionAuditsController } from "@/server/modules/invoice-correction-audits/invoice-correction-audits.controller";
export const GET = withHandler(invoiceCorrectionAuditsController.list);
