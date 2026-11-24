import "server-only";
import { providerDisplayName } from "@/shared/schemas/provider-name";
import { createHash } from "node:crypto";
import { googleSignupRepository } from "./google-signup.repository";
import { authRepository } from "./auth.repository";
import { RateLimitError } from "@/server/lib/errors";
export const googleSignupService = {
  async open(
    email: string,
    subject: string,
    name: string | null | undefined,
    verified: boolean,
    address: string,
  ) {
    if (!verified) return null;
    if (
      !(await authRepository.takeAttempt(
        createHash("sha256").update(`google-create:${address}`).digest("hex"),
      ))
    )
      throw new RateLimitError();
    return googleSignupRepository.open({
      email: email.toLowerCase(),
      subject,
      name: providerDisplayName(name),
    });
  },
};
