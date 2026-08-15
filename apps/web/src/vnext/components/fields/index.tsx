import { useId, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';

interface FieldChromeProps {
  label: string;
  helpText?: string;
  error?: string;
}

export interface CapiroInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-invalid'>,
    FieldChromeProps {}

export function CapiroInput({ label, helpText, error, id, className = '', ...props }: CapiroInputProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const messageId = `${controlId}-message`;
  return (
    <label className="capiro-field" htmlFor={controlId}>
      <span className="capiro-field__label">{label}</span>
      <input
        id={controlId}
        className={`capiro-input ${className}`.trim()}
        aria-invalid={Boolean(error)}
        aria-describedby={error || helpText ? messageId : undefined}
        {...props}
      />
      {error ? (
        <span id={messageId} className="capiro-field__error">{error}</span>
      ) : helpText ? (
        <span id={messageId} className="capiro-field__help">{helpText}</span>
      ) : null}
    </label>
  );
}

export interface CapiroSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface CapiroSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-invalid'>,
    FieldChromeProps {
  options: readonly CapiroSelectOption[];
}

export function CapiroSelect({
  label,
  helpText,
  error,
  options,
  id,
  className = '',
  ...props
}: CapiroSelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const messageId = `${controlId}-message`;
  return (
    <label className="capiro-field" htmlFor={controlId}>
      <span className="capiro-field__label">{label}</span>
      <select
        id={controlId}
        className={`capiro-select ${className}`.trim()}
        aria-invalid={Boolean(error)}
        aria-describedby={error || helpText ? messageId : undefined}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <span id={messageId} className="capiro-field__error">{error}</span>
      ) : helpText ? (
        <span id={messageId} className="capiro-field__help">{helpText}</span>
      ) : null}
    </label>
  );
}
