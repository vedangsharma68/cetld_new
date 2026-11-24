import { forwardRef, useId, type InputHTMLAttributes } from "react";
export const FormField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }
>(function FormField({ label, error, id, ...props }, ref) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium">
        {label}
      </label>
      <input
        {...props}
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${inputId}-error` : undefined}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 outline-offset-2 focus:outline-slate-700"
      />
      {error && (
        <p id={`${inputId}-error`} className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
});
