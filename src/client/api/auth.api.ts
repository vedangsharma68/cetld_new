import { http } from "./http";
import type { GoogleSignupInput } from "@/shared/schemas/google-signup.schema";
import type { SignupInput } from "@/shared/schemas/auth.schema";
export const authApi = {
  prepareGoogle: (input: GoogleSignupInput) =>
    http<{ ready: boolean }>("/auth/google-signup", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  verify: (input: { token: string; password: string }) =>
    http<{ verified: boolean }>("/auth/verify-email", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  signup: (input: SignupInput) =>
    http<{ message: string }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
