import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center border-2 px-2.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em]",
  {
    variants: {
      variant: {
        default: "border-[#1B2340] bg-[#FBF6EA]/90 text-[#1B2340]",
        green: "border-[#2F6B4F] bg-[#FBF6EA]/90 text-[#2F6B4F]",
        blue: "border-[#1F5C99] bg-[#FBF6EA]/90 text-[#1F5C99]",
        amber: "border-[#8A4B08] bg-[#FBF6EA]/90 text-[#8A4B08]",
        red: "border-[#B3261E] bg-[#FBF6EA]/90 text-[#B3261E]",
        indigo: "border-[#1B2340] bg-[#FBF6EA]/90 text-[#1B2340]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, variant, ...p }: BadgeProps) => (
  <span className={cn(badgeVariants({ variant }), className)} {...p} />
);
