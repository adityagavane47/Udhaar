import * as React from "react";
import { cn } from "@/lib/utils";

const field =
  "flex h-11 w-full border border-[#1B2340] bg-[#FBF6EA] px-3 py-2 font-mono text-sm text-[#1B2340] placeholder:text-[#6B6F86] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B3261E] disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...p }, ref) => <input ref={ref} className={cn(field, className)} {...p} />,
);
Input.displayName = "Input";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...p }, ref) => <select ref={ref} className={cn(field, className)} {...p} />,
);
Select.displayName = "Select";

export const Label = ({ className, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
  <label className={cn("font-mono text-xs uppercase tracking-[0.06em] text-[#1B2340]", className)} {...p} />
);
