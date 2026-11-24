import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
const variants = cva(
  "inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium transition disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2",
  {
    variants: {
      variant: {
        default: "bg-slate-900 text-white hover:bg-slate-700",
        outline: "border border-slate-300 bg-white hover:bg-slate-50",
        destructive: "bg-red-700 text-white hover:bg-red-800",
      },
    },
    defaultVariants: { variant: "default" },
  },
);
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof variants>
>(function Button({ className, variant, ...props }, ref) {
  return (
    <button
      ref={ref}
      className={twMerge(clsx(variants({ variant }), className))}
      {...props}
    />
  );
});
