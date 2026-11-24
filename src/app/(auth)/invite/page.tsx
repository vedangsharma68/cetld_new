"use client";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signupSchema, type SignupInput } from "@/shared/schemas/auth.schema";
import { useSignup } from "@/client/queries/auth.queries";
import { FormField } from "@/client/components/common/form-field";
import { SubmitButton } from "@/client/components/common/submit-button";
import { applyServerErrors } from "@/client/lib/form-errors";
export default function Invite() {
  const router = useRouter();
  const [done, setDone] = useState(false);
  const mutation = useSignup();
  const form = useForm<SignupInput>({ resolver: zodResolver(signupSchema) });
  return (
    <main className="mx-auto max-w-md px-6 py-14">
      <Link href="/" className="text-xl font-semibold">
        cetld
      </Link>
      <h1 className="mb-2 mt-10 text-3xl font-semibold">
        Your business starts here
      </h1>
      <p className="mb-8 text-slate-600">
        No invite code needed. Use Google or confirm your email to get started.
      </p>
      {done ? (
        <div role="status">
          <p className="mb-5">
            Check your email to confirm your account, or sign in if you already
            have one.
          </p>
          <button
            className="rounded-lg bg-slate-900 px-4 py-3 text-white"
            onClick={() => router.push("/login")}
          >
            Go to sign in
          </button>
        </div>
      ) : (
        <form
          className="space-y-5"
          onSubmit={form.handleSubmit(async (values) => {
            try {
              await mutation.mutateAsync(values);
              setDone(true);
              form.reset();
            } catch (error: unknown) {
              applyServerErrors(form, error);
            }
          })}
        >
          <FormField
            label="Name"
            autoComplete="name"
            error={form.formState.errors.name?.message}
            {...form.register("name")}
          />
          <FormField
            label="Business name"
            error={form.formState.errors.businessName?.message}
            {...form.register("businessName")}
          />
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
            autoComplete="new-password"
            error={form.formState.errors.password?.message}
            {...form.register("password")}
          />
          <p className="text-xs text-slate-500">
            At least 12 characters. Choose a password you do not use elsewhere.
          </p>
          <SubmitButton pending={mutation.isPending}>
            Create account
          </SubmitButton>
          <button
            type="button"
            className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3"
            onClick={() => {
              void signIn("google", { redirectTo: "/customers" });
            }}
          >
            Continue with Google
          </button>
        </form>
      )}
    </main>
  );
}
