"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { signIn } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FormField } from "@/client/components/common/form-field";
import { SubmitButton } from "@/client/components/common/submit-button";
const schema = z.object({
  email: z.email(),
  password: z.string().min(1, "Enter your password"),
});
export default function Login() {
  const router = useRouter();
  const [error, setError] = useState("");
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
  });
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-16">
      <Link href="/" className="mb-12 text-xl font-semibold">
        cetld
      </Link>
      <h1 className="text-3xl font-semibold">Welcome back</h1>
      <p className="mb-8 mt-2 text-slate-600">Sign in to your business.</p>
      <form
        className="space-y-5"
        onSubmit={form.handleSubmit(async (values) => {
          setError("");
          try {
            const result = await signIn("credentials", {
              ...values,
              redirect: false,
            });
            if (result?.code === "rate_limited")
              setError("Too many failed attempts. Try again in 15 minutes.");
            else if (result?.error) setError("Email or password is incorrect.");
            else router.push("/customers");
          } catch {
            setError("Unable to sign in. Try again.");
          }
        })}
      >
        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          error={form.formState.errors.email?.message}
          {...form.register("email")}
        />
        <FormField
          label="Password"
          type="password"
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register("password")}
        />
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <SubmitButton pending={form.formState.isSubmitting}>
          Sign in
        </SubmitButton>
      </form>
      <button
        type="button"
        className="mt-4 rounded-lg border border-slate-300 bg-white px-4 py-3"
        onClick={() => {
          void signIn("google", { redirectTo: "/customers" });
        }}
      >
        Continue with Google
      </button>
      <p className="mt-8 text-sm text-slate-500">
        Open signup.{" "}
        <Link href="/signup" className="underline">
          Create an account
        </Link>
        . Google sign-in is also available.
      </p>
    </main>
  );
}
