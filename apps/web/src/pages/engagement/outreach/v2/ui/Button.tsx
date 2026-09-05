import type { ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { cn } from './cn.js';

// Handover §5.1: "Every button → Button (primary for dark, secondary
// outlined, tertiary ghost); sizes md = 36, sm = 32." §4 geometry adds one
// more height, 40px, for toolbar placements — modeled here as size="lg"
// rather than a separate prop, since it's the same component in every
// other respect.
type Variant = 'primary' | 'secondary' | 'tertiary';
type Size = 'lg' | 'md' | 'sm';

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'btn-dark',
  secondary:
    'bg-surface text-ink-strong border border-line-control hover:border-accent-border disabled:opacity-50',
  tertiary: 'bg-transparent text-ink-secondary hover:bg-surface-subtle disabled:opacity-50',
};

const SIZE_CLASS: Record<Size, string> = {
  lg: 'h-10 px-4 text-sm gap-2',
  md: 'h-9 px-3.5 text-sm gap-1.5',
  sm: 'h-8 px-3 text-[13px] gap-1.5',
};

interface Props extends Omit<AriaButtonProps, 'className'> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
  className?: string;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: Props) {
  return (
    <AriaButton
      {...rest}
      className={cn(
        'inline-flex items-center justify-center rounded-sm font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:cursor-not-allowed',
        SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        className,
      )}
    >
      {children}
    </AriaButton>
  );
}
