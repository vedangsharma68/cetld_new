import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { ForbiddenError, RateLimitError } from "@/server/lib/errors";
import type { SignupInput } from "@/shared/schemas/auth.schema";
import {
  verificationMailer,
  type VerificationMailer,
} from "@/server/lib/verification-mail";
import { authRepository } from "./auth.repository";
import { signupRepository } from "./signup.repository";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function createSignupService(
  repository = signupRepository,
  limiter = authRepository,
  mailer: VerificationMailer = verificationMailer,
) {
  return {
    async signup(input: SignupInput, address = "synthetic-test") {
      if (
        !(await limiter.takeAttempt(digest(`signup-address:${address}`))) ||
        !(await limiter.takeAttempt(digest(`signup:${address}:${input.email}`)))
      )
        throw new RateLimitError();
      if (!(await limiter.takeAttempt(digest(`signup-email:${input.email}`))))
        throw new RateLimitError();
      mailer.assertReady();
      const token = randomBytes(32).toString("hex");
      const prepared = await repository.prepare({
        email: input.email,
        name: input.name,
        businessName: input.businessName,
        passwordHash: await hash(input.password, 12),
        tokenHash: digest(token),
      });
      if (prepared) await mailer.send(input.email, token);
      return {
        message:
          "Check your email to confirm your account, or sign in if you already have one.",
      };
    },
    async verify(token: string, password: string, address = "synthetic-test") {
      if (!(await limiter.takeAttempt(digest(`verify:${address}`))))
        throw new RateLimitError();
      const result = await repository.verify(digest(token), password);
      if (!result)
        throw new ForbiddenError(
          "Verification link or password is invalid or expired",
        );
      return result;
    },
  };
}
export const signupService = createSignupService();
