export type FieldErrors = {
  fieldErrors?: Record<string, string[] | undefined>;
  formErrors?: string[];
};
export type ApiSuccess<T> = { success: true; data: T; meta?: PaginationMeta };
export type ApiError = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: FieldErrors;
    requestId: string;
  };
};
export type PaginationMeta = { page: number; pageSize: number; total: number };
export type Paginated<T> = { data: T[]; meta: PaginationMeta };
