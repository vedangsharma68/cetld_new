import "server-only";
import { headers } from "next/headers";
import { googleSignupService } from "./modules/auth/google-signup.service";
import NextAuth, { CredentialsSignin } from "next-auth";
import { clientAddress } from "./lib/client-address";
import { RateLimitError } from "./lib/errors";
class AuthRateLimited extends CredentialsSignin {
  code = "rate_limited";
}
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { z } from "zod";
import { getEnv } from "@/env";
import { authRepository } from "./modules/auth/auth.repository";
import { authService } from "./modules/auth/auth.service";
const env = getEnv();
const credentialsSchema = z.object({
  email: z.email().transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1).max(128),
});
export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: env.AUTH_SECRET,
  trustHost: true,
  session: { strategy: "jwt", maxAge: 3600 },
  pages: { signIn: "/login" },
  providers: [
    Google({
      clientId: env.AUTH_GOOGLE_ID,
      clientSecret: env.AUTH_GOOGLE_SECRET,
      allowDangerousEmailAccountLinking: false,
    }),
    Credentials({
      credentials: { email: { type: "email" }, password: { type: "password" } },
      async authorize(credentials, request) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;
        try {
          return await authService.credentials(
            parsed.data.email,
            parsed.data.password,
            clientAddress(request),
          );
        } catch (error: unknown) {
          if (error instanceof RateLimitError) throw new AuthRateLimited();
          throw error;
        }
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "credentials") return true;
      if (account?.provider !== "google") return false;
      let linked = await authService.google(
        account.providerAccountId,
        profile?.email ?? "",
        profile?.email_verified === true,
      );
      if (!linked && profile?.email_verified === true && profile.email) {
        linked = await googleSignupService.open(
          profile.email,
          account.providerAccountId,
          user.name ?? "New member",
          true,
          clientAddress(new Request(env.APP_URL, { headers: await headers() })),
        );
      }
      if (!linked) return false;
      user.id = linked.id;
      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
        const record = await authRepository.byId(user.id);
        token.sessionVersion = record?.sessionVersion;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      session.sessionVersion = token.sessionVersion;
      return session;
    },
    async redirect({ url }) {
      const origin = new URL(env.APP_URL).origin;
      const destination = new URL(url, origin);
      return destination.origin === origin ? destination.toString() : origin;
    },
  },
});
