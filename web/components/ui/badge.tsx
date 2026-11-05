import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", {
  variants: {
    variant: {
      default: "border-slate-200 bg-slate-100 text-slate-700",
      green: "border-emerald-200 bg-emerald-100 text-emerald-800",
      blue: "border-blue-200 bg-blue-100 text-blue-800",
      amber: "border-amber-200 bg-amber-100 text-amber-800",
      red: "border-red-200 bg-red-100 text-red-800",
      indigo: "border-indigo-200 bg-indigo-100 text-indigo-800",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, variant, ...p }: BadgeProps) => (
  <span className={cn(badgeVariants({ variant }), className)} {...p} />
);

