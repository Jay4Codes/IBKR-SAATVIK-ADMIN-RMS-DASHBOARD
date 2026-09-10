import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Buttons are styled from the same design tokens as inputs and selects (see
 * `app/globals.css`), not from Tailwind's palette. Hard-coded utility colours
 * looked right in the dark theme and unreadable in the light one, and a
 * `rounded-lg`/`h-10` button never lined up with a `--control-height` input
 * sitting beside it in a form row.
 */
const buttonVariants = cva("btn", {
  variants: {
    variant: {
      default: "btn-solid",
      outline: "btn-outline",
      ghost: "btn-ghost",
    },
    size: {
      default: "btn-md",
      sm: "btn-sm",
      icon: "btn-icon",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
