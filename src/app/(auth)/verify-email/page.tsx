"use client";
import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useVerifySignup } from "@/client/queries/auth.queries";
import { toUserMessage } from "@/client/lib/errors";
export default function VerifyEmail() {
  const token = useRef("");
  const [password, setPassword] = useState("");
  const verify = useVerifySignup();
  useEffect(() => {
    token.current =
      new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
    history.replaceState(null, "", location.pathname);
  }, []);
  return (
    <main className="mx-auto max-w-md px-6 py-20">
      <h1 className="text-3xl font-semibold">Confirm your email</h1>
      {verify.isSuccess ? (
        <p className="mt-6">
          Email confirmed.{" "}
          <Link href="/login" className="underline">
            Sign in
          </Link>
        </p>
      ) : (
        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate({ token: token.current, password });
          }}
        >
          <p>
            Enter the password you chose when requesting this account. If you
            did not request this, close this page.
          </p>
          <label className="block">
            Password
            <input
              required
              type="password"
              autoComplete="new-password"
              className="mt-2 w-full rounded border p-3"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {verify.error && <p role="alert">{toUserMessage(verify.error)}</p>}
          <button
            disabled={verify.isPending}
            className="rounded bg-slate-900 px-4 py-3 text-white"
          >
            Confirm email
          </button>
        </form>
      )}
    </main>
  );
}
