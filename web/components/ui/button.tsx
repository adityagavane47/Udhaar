import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "btn inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#B3261E] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-[#1B2340] text-[#F1E8D2] hover:text-[#F1E8D2] border border-[#1B2340]",
        outline: "border-2 border-[#1B2340] bg-[#FBF6EA] text-[#1B2340] hover:text-[#B3261E]",
        destructive: "bg-[#B3261E] text-[#FBF6EA] hover:text-[#FBF6EA] border border-[#B3261E]",
        secondary: "bg-[#FBF6EA] text-[#1B2340] hover:text-[#B3261E] border border-[#C9B98F]",
        ghost: "text-[#1B2340] hover:text-[#B3261E] underline-offset-4 hover:underline",
      },
      size: {
        default: "px-4 py-2.5",
        sm: "px-3 py-1.5 text-xs font-mono uppercase tracking-wider",
        lg: "px-6 py-3.5 text-base",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";
