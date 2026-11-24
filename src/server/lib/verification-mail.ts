import "server-only";
import nodemailer from "cetld-smtp";
import { getEnv } from "@/env";
import { AppError } from "./errors";
export interface VerificationMailer {
  assertReady(): void;
  send(email: string, token: string): Promise<void>;
}
export const verificationMailer: VerificationMailer = {
  assertReady() {
    const env = getEnv();
    if (
      !env.SMTP_HOST ||
      !env.SMTP_USER ||
      !env.SMTP_PASSWORD ||
      !env.SMTP_FROM
    )
      throw new AppError(
        503,
        "EMAIL_UNAVAILABLE",
        "Email signup is temporarily unavailable. Continue with Google.",
      );
  },
  async send(email, token) {
    this.assertReady();
    const env = getEnv();
    const url = new URL("/verify-email", env.APP_URL);
    url.hash = new URLSearchParams({ token }).toString();
    try {
      await nodemailer
        .createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_PORT === 465,
          requireTLS: true,
          auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
          connectionTimeout: 10000,
          socketTimeout: 10000,
          logger: false,
          debug: false,
        })
        .sendMail({
          from: env.SMTP_FROM,
          to: email,
          subject: "Confirm your Cetld account",
          text: `Confirm your account by opening this link and entering the password you chose: ${url.toString()}\nThis link expires in 30 minutes. If you did not request it, ignore it.`,
        });
    } catch {
      throw new AppError(
        503,
        "EMAIL_UNAVAILABLE",
        "Verification email could not be sent. Try again later or use Google.",
      );
    }
  },
};
