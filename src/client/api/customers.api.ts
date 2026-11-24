import { http, httpPaginated } from "./http";
import type {
  Customer,
  CustomerFilters,
  CreateCustomerInput,
  UpdateCustomerInput,
} from "@/shared/schemas/customers.schema";
export const customersApi = {
  list: (filters: CustomerFilters) =>
    httpPaginated<Customer>(
      `/customers?${new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)]))}`,
    ),
  detail: (id: string) => http<Customer>(`/customers/${id}`),
  create: (input: CreateCustomerInput) =>
    http<Customer>("/customers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, input: UpdateCustomerInput) =>
    http<Customer>(`/customers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  remove: (id: string) => http<void>(`/customers/${id}`, { method: "DELETE" }),
};
