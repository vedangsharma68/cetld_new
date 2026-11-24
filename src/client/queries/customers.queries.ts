"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { customersApi } from "@/client/api/customers.api";
import { qk } from "./query-keys";
import type {
  CustomerFilters,
  UpdateCustomerInput,
} from "@/shared/schemas/customers.schema";
export const useCustomers = (filters: CustomerFilters) =>
  useQuery({
    queryKey: qk.customers.list(filters),
    queryFn: () => customersApi.list(filters),
    enabled: Boolean(filters.workspaceId),
  });
export const useCustomer = (id: string) =>
  useQuery({
    queryKey: qk.customers.detail(id),
    queryFn: () => customersApi.detail(id),
  });
export function useCreateCustomer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: customersApi.create,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.customers.all });
      toast.success("Customer added");
    },
  });
}
export function useUpdateCustomer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCustomerInput }) =>
      customersApi.update(id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.customers.all });
      toast.success("Customer updated");
    },
  });
}
export function useDeleteCustomer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: customersApi.remove,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.customers.all });
      toast.success("Customer deleted");
    },
  });
}
