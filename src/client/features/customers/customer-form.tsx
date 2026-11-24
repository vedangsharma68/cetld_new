"use client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  createCustomerSchema,
  type CreateCustomerInput,
} from "@/shared/schemas/customers.schema";
import { useCreateCustomer } from "@/client/queries/customers.queries";
import { FormField } from "@/client/components/common/form-field";
import { SubmitButton } from "@/client/components/common/submit-button";
import { applyServerErrors } from "@/client/lib/form-errors";
export function CustomerForm({
  workspaceId,
  onDone,
}: {
  workspaceId: string;
  onDone: () => void;
}) {
  const mutation = useCreateCustomer();
  const form = useForm<CreateCustomerInput>({
    resolver: zodResolver(createCustomerSchema),
    defaultValues: {
      workspaceId,
      name: "",
      email: "",
      phone: "",
      companyName: "",
    },
  });
  return (
    <form
      className="mb-8 grid gap-5 rounded-xl border border-slate-200 bg-white p-6 md:grid-cols-2"
      onSubmit={form.handleSubmit(async (values) => {
        try {
          await mutation.mutateAsync(values);
          form.reset();
          onDone();
        } catch (error: unknown) {
          applyServerErrors(form, error);
        }
      })}
    >
      <input type="hidden" {...form.register("workspaceId")} />
      <FormField
        label="Customer name"
        error={form.formState.errors.name?.message}
        {...form.register("name")}
      />
      <FormField
        label="Company"
        error={form.formState.errors.companyName?.message}
        {...form.register("companyName")}
      />
      <FormField
        label="Email"
        type="email"
        error={form.formState.errors.email?.message}
        {...form.register("email")}
      />
      <FormField
        label="Phone"
        type="tel"
        error={form.formState.errors.phone?.message}
        {...form.register("phone")}
      />
      <div>
        <SubmitButton pending={mutation.isPending}>Add customer</SubmitButton>
      </div>
    </form>
  );
}
