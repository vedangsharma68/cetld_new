import "server-only";
import { createHash } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { authRepository } from "./auth.repository";
import { RateLimitError } from "@/server/lib/errors";
const dummyHash = hash("synthetic-timing-placeholder-not-a-real-account", 12);
export function createAuthService(repository = authRepository) {
  return {
    async credentials(
      email: string,
      password: string,
      address = "synthetic-test",
    ) {
      const key = createHash("sha256")
        .update(`credentials:${address}:${email}`)
        .digest("hex");
      if (!(await repository.takeAttempt(key))) throw new RateLimitError();
      const user = await repository.byEmail(email);
      const valid = await compare(
        password,
        user?.passwordHash ?? (await dummyHash),
      );
      if (!user?.passwordHash || !user.emailVerifiedAt || !valid) return null;
      await repository.resetAttempts(key);
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      };
    },
    async google(subject: string, email: string, verified: boolean) {
      if (!verified) return null;
      const linked = await repository.byProvider("google", subject);
      if (!linked || linked.email.toLowerCase() !== email.toLowerCase())
        return null;
      return linked;
    },
  };
}
export const authService = createAuthService();
