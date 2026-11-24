"use client";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useProfile, useUpdateProfile } from "@/client/queries/profile.queries";
import {
  updateProfileSchema,
  type UpdateProfileInput,
} from "@/shared/schemas/profile.schema";
import { QueryBoundary } from "@/client/components/common/query-boundary";
import { FormField } from "@/client/components/common/form-field";
import { SubmitButton } from "@/client/components/common/submit-button";
import { toUserMessage } from "@/client/lib/errors";
import { applyServerErrors } from "@/client/lib/form-errors";
export function ProfileForm() {
  const query = useProfile();
  return (
    <section
      className="mb-6 max-w-2xl rounded border bg-white p-5"
      aria-label="Your profile"
    >
      <h2 className="mb-4 text-lg font-semibold">Your profile</h2>
      <QueryBoundary query={query}>
        {(profile) => <EditProfile initialName={profile.fullName} />}
      </QueryBoundary>
    </section>
  );
}
function EditProfile({ initialName }: { initialName: string | null }) {
  const mutation = useUpdateProfile(),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const form = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: { fullName: initialName ?? "" },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={form.handleSubmit(async (input) => {
        setError("");
        setMessage("");
        try {
          await mutation.mutateAsync(input);
          setMessage("Profile saved.");
        } catch (e) {
          applyServerErrors(form, e);
          setError(toUserMessage(e));
        }
      })}
    >
      <FormField
        label="Your full name"
        autoComplete="name"
        {...form.register("fullName")}
        error={form.formState.errors.fullName?.message}
      />
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <SubmitButton pending={mutation.isPending}>Save profile</SubmitButton>
      <p className="text-sm text-slate-600">
        Changes only your profile. Your login email and business settings stay
        the same.
      </p>
    </form>
  );
}
