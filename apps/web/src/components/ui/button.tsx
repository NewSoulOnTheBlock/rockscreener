'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Buttons.
 *
 * `action` is the ONLY variant painted in the violet, and there should be one
 * of it on a screen: connect, buy, arm. Everything else is a surface. A page
 * with four primary buttons has no primary button.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-sm)] text-[13px] font-medium transition-[background-color,border-color,color,opacity] outline-none focus-visible:ring-2 focus-visible:ring-action/60 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        action: 'bg-action text-action-ink hover:bg-action/85 font-semibold',
        rock: 'bg-rock-wash text-rock border border-rock/30 hover:bg-rock/15',
        solid: 'bg-raised text-bone border border-rule hover:bg-rule/40',
        outline: 'border border-rule text-ash hover:text-bone hover:border-dim',
        ghost: 'text-ash hover:text-bone hover:bg-raised',
        danger: 'bg-down/10 text-down border border-down/30 hover:bg-down/20',
      },
      size: {
        sm: 'h-7 px-2.5 text-[12px]',
        md: 'h-9 px-3.5',
        lg: 'h-11 px-5 text-[14px]',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'solid', size: 'md' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  }
);
Button.displayName = 'Button';

export { buttonVariants };
