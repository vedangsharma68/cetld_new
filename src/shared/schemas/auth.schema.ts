import { z } from "zod";
export const signupSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase()),
    password: z
      .string()
      .min(12)
      .max(72)
      .refine(
        (value) => new TextEncoder().encode(value).length <= 72,
        "Password must be at most 72 UTF-8 bytes",
      ),
    name: z.string().trim().min(1).max(160),
    businessName: z.string().trim().min(1).max(160),
  })
  .strict();
export type SignupInput = z.infer<typeof signupSchema>;

export const verifySignupSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    password: signupSchema.shape.password,
  })
  .strict();
