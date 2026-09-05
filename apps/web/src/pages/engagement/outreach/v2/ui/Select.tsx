import type { ReactNode } from 'react';
import {
  Select as RACSelect,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  Button as RACButton,
  Label,
} from 'react-aria-components';
import { Icon } from './icons.js';
import { cn } from './cn.js';

// Handover §5.1: "Client, State, Chamber, draft-to-test, Applies-to →
// Select." One option shape, one component, everywhere it's used.
export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  label?: ReactNode;
  /**
   * Required when `label` is omitted — react-aria-components warns (a real
   * accessibility gap, not just noise) if a Select has no visible label AND
   * no accessible name. A caller that doesn't want a visible label (e.g. the
   * Generate & Review tone selector, which the design shows unlabeled) must
   * supply this instead.
   */
  'aria-label'?: string;
  selectedKey: string;
  onSelectionChange: (key: string) => void;
  options: SelectOption[];
  placeholder?: string;
  height?: 40 | 38 | 36 | 30;
  className?: string;
}

const HEIGHT_CLASS = { 40: 'h-10', 38: 'h-[38px]', 36: 'h-9', 30: 'h-[30px]' } as const;

export function Select({
  label,
  'aria-label': ariaLabel,
  selectedKey,
  onSelectionChange,
  options,
  placeholder,
  height = 36,
  className = '',
}: Props) {
  return (
    <RACSelect
      selectedKey={selectedKey}
      onSelectionChange={(key) => onSelectionChange(String(key))}
      placeholder={placeholder}
      aria-label={label ? undefined : ariaLabel}
      className={cn('flex flex-col gap-1.5', className)}
    >
      {label && <Label className="text-[13px] font-semibold text-ink-strong">{label}</Label>}
      <RACButton
        className={`flex items-center justify-between gap-2 rounded-sm border border-line-control bg-surface px-3 text-sm text-ink-primary focus:border-accent focus:outline-none ${HEIGHT_CLASS[height]}`}
      >
        <SelectValue className="truncate" />
        <Icon.ChevronDown size={14} className="flex-none text-ink-tertiary" />
      </RACButton>
      <Popover className="w-(--trigger-width) rounded-md border border-line-hairline bg-surface shadow-card">
        <ListBox className="max-h-60 overflow-auto p-1 outline-none">
          {options.map((o) => (
            <ListBoxItem
              key={o.value}
              id={o.value}
              className="cursor-pointer rounded-sm px-2.5 py-1.5 text-sm text-ink-primary outline-none data-[focused]:bg-surface-subtle data-[selected]:bg-accent-tint data-[selected]:text-accent-ink"
            >
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </RACSelect>
  );
}
