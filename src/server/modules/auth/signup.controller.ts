import "server-only";
import { clientAddress } from "@/server/lib/client-address";
import { signupSchema, verifySignupSchema } from "@/shared/schemas/auth.schema";
import { readJson } from "@/server/lib/validation";
import { ok } from "@/server/lib/response";
import { signupService } from "./signup.service";
export async function signup(request: Request) {
  return ok(
    await signupService.signup(
      signupSchema.parse(await readJson(request)),
      clientAddress(request),
    ),
  );
}

export async function verifySignup(request: Request) {
  const input = verifySignupSchema.parse(await readJson(request));
  return ok(
    await signupService.verify(
      input.token,
      input.password,
      clientAddress(request),
    ),
  );
}
