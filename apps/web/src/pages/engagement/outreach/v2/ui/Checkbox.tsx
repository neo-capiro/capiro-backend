import type { ReactNode } from 'react';
import { Checkbox as RACCheckbox } from 'react-aria-components';
import { Icon } from './icons.js';

// Handover §5.1: "Include checkboxes in the pool → Checkbox." Also used for
// the plain "attach this file" list on Generate & Review.
interface Props {
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  /** Mixed state for a "select all" that only covers part of the set. */
  isIndeterminate?: boolean;
  'aria-label'?: string;
  children?: ReactNode;
}

export function Checkbox({
  isSelected,
  onChange,
  isIndeterminate,
  'aria-label': ariaLabel,
  children,
}: Props) {
  return (
    <RACCheckbox
      isSelected={isSelected}
      onChange={onChange}
      isIndeterminate={isIndeterminate}
      aria-label={children ? undefined : ariaLabel}
      className="flex items-center gap-2 text-sm text-ink-primary"
    >
      {({ isSelected: on, isIndeterminate: mixed }) => (
        <>
          <span
            className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border ${
              on || mixed ? 'btn-dark border-transparent text-white' : 'border-line-control bg-surface'
            }`}
          >
            {mixed ? (
              <span className="h-0.5 w-2.5 rounded-full bg-current" />
            ) : on ? (
              <Icon.Check size={11} />
            ) : null}
          </span>
          {children}
        </>
      )}
    </RACCheckbox>
  );
}
