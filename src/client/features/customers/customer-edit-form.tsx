"use client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  updateCustomerSchema,
  type Customer,
  type UpdateCustomerInput,
} from "@/shared/schemas/customers.schema";
import { useUpdateCustomer } from "@/client/queries/customers.queries";
import { FormField } from "@/client/components/common/form-field";
import { SubmitButton } from "@/client/components/common/submit-button";
import { applyServerErrors } from "@/client/lib/form-errors";
export function CustomerEditForm({
  customer,
  onDone,
}: {
  customer: Customer;
  onDone: () => void;
}) {
  const mutation = useUpdateCustomer();
  const form = useForm<UpdateCustomerInput>({
    resolver: zodResolver(updateCustomerSchema),
    defaultValues: {
      name: customer.name,
      companyName: customer.companyName ?? "",
      email: customer.email ?? "",
      phone: customer.phone ?? "",
    },
  });
  return (
    <form
      className="my-6 grid gap-5 rounded-xl border border-slate-200 bg-white p-6 sm:grid-cols-2"
      onSubmit={form.handleSubmit(async (input) => {
        try {
          await mutation.mutateAsync({ id: customer.id, input });
          onDone();
        } catch (error: unknown) {
          applyServerErrors(form, error);
        }
      })}
    >
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
        <SubmitButton pending={mutation.isPending}>Save changes</SubmitButton>
      </div>
    </form>
  );
}
