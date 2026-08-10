import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'quiet';
type ButtonSize = 'compact' | 'standard';

export interface CapiroButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: ReactNode;
}

export function CapiroButton({
  variant = 'secondary',
  size = 'standard',
  loading = false,
  leadingIcon,
  disabled,
  className = '',
  children,
  ...props
}: CapiroButtonProps) {
  return (
    <button
      type="button"
      className={`capiro-button capiro-button--${variant} capiro-button--${size} capiro-elevation-control ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {leadingIcon}
      {loading ? 'Working…' : children}
    </button>
  );
}

export interface CapiroIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
}

export function CapiroIconButton({ label, icon, className = '', ...props }: CapiroIconButtonProps) {
  return (
    <button
      type="button"
      className={`capiro-icon-button capiro-elevation-control ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      {icon}
    </button>
  );
}
