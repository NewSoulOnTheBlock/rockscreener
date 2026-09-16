'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/cn';

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-rule transition-colors',
      'outline-none focus-visible:ring-2 focus-visible:ring-action/50 disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:border-rock/50 data-[state=checked]:bg-rock/25 data-[state=unchecked]:bg-sunk',
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block size-3.5 rounded-full bg-ash shadow transition-transform',
        'data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-rock data-[state=unchecked]:translate-x-0.5'
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
