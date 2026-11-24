import { signupSchema } from "./auth.schema";
import { z } from "zod";
export const googleSignupSchema = signupSchema.omit({ password: true });
export type GoogleSignupInput = z.infer<typeof googleSignupSchema>;
