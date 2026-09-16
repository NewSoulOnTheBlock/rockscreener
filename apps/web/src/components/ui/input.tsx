'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-[var(--radius-sm)] border border-rule-faint bg-sunk px-2.5 text-[13px] text-bone',
        'placeholder:text-dim outline-none transition-colors',
        'focus:border-rule focus:ring-1 focus:ring-action/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
