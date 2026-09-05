import type { KeyboardEvent, ReactNode } from 'react';
import {
  TextField,
  Input as RACInput,
  TextArea as RACTextArea,
  Label,
} from 'react-aria-components';
import { cn } from './cn.js';

// Handover §5.1: "Search, campaign name, subject, Cc/Bcc, manual-add fields
// → Input / InputGroup with leading icon." One TextField-backed component
// covers the plain-input case; `leadingIcon` is the "InputGroup" variant.
interface InputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: ReactNode;
  /**
   * Only needed when both `label` is omitted AND `placeholder` isn't a good
   * accessible name on its own — react-aria-components' TextField requires
   * an accessible name (a real accessibility gap, not just noise) and
   * placeholder text alone doesn't count as far as it's concerned, so absent
   * an explicit override this falls back to `placeholder`.
   */
  'aria-label'?: string;
  autoFocus?: boolean;
  leadingIcon?: ReactNode;
  maxLength?: number;
  disabled?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Toolbar (40) vs standard (38/36) heights (handover §4). */
  height?: 40 | 38 | 36;
  className?: string;
}

const HEIGHT_CLASS = { 40: 'h-10', 38: 'h-[38px]', 36: 'h-9' } as const;

export function Input({
  id,
  value,
  onChange,
  placeholder,
  label,
  'aria-label': ariaLabel,
  autoFocus,
  leadingIcon,
  maxLength,
  disabled,
  onKeyDown,
  height = 36,
  className = '',
}: InputProps) {
  return (
    <TextField
      id={id}
      value={value}
      onChange={onChange}
      isDisabled={disabled}
      aria-label={label ? undefined : (ariaLabel ?? placeholder)}
      className="flex flex-col gap-1.5"
    >
      {label && <Label className="text-[13px] font-semibold text-ink-strong">{label}</Label>}
      <div className="relative flex items-center">
        {leadingIcon && (
          <span className="pointer-events-none absolute left-3 flex text-ink-tertiary">
            {leadingIcon}
          </span>
        )}
        <RACInput
          autoFocus={autoFocus}
          placeholder={placeholder}
          maxLength={maxLength}
          onKeyDown={onKeyDown}
          className={cn(
            'w-full rounded-sm border border-line-control bg-surface text-sm text-ink-primary placeholder:text-ink-tertiary focus:border-accent focus:outline-none disabled:opacity-50',
            HEIGHT_CLASS[height],
            leadingIcon ? 'pr-3 pl-9' : 'px-3',
            className,
          )}
        />
      </div>
    </TextField>
  );
}

interface TextAreaProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: ReactNode;
  /** Same fallback-to-placeholder rule as Input — see its doc comment. */
  'aria-label'?: string;
  rows?: number;
  maxLength?: number;
  showCount?: boolean;
  className?: string;
}

export function TextArea({
  id,
  value,
  onChange,
  placeholder,
  label,
  'aria-label': ariaLabel,
  rows = 4,
  maxLength,
  showCount = false,
  className = '',
}: TextAreaProps) {
  return (
    <TextField
      id={id}
      value={value}
      onChange={onChange}
      aria-label={label ? undefined : (ariaLabel ?? placeholder)}
      className="flex flex-col gap-1.5"
    >
      {label && <Label className="text-[13px] font-semibold text-ink-strong">{label}</Label>}
      <RACTextArea
        rows={rows}
        placeholder={placeholder}
        maxLength={maxLength}
        className={cn(
          'w-full resize-y rounded-md border border-line-control bg-surface p-3 text-[13.5px] leading-[21px] text-ink-primary placeholder:text-ink-tertiary focus:border-accent focus:outline-none',
          className,
        )}
      />
      {showCount && maxLength != null && (
        <div className="self-end font-mono text-[11px] text-ink-tertiary">
          {value.length}/{maxLength}
        </div>
      )}
    </TextField>
  );
}
