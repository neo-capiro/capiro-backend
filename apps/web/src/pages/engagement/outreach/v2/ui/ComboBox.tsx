import { useMemo, useState } from 'react';
import {
  ComboBox as RACComboBox,
  Input as RACInput,
  Popover,
  ListBox,
  ListBoxItem,
  Button as RACButton,
} from 'react-aria-components';
import { Icon } from './icons.js';
import { cn } from './cn.js';

// A filter dropdown that keeps BOTH behaviors antd's <Select allowClear
// showSearch> gave the Recipients toolbar: type to narrow the options, and
// clear the filter back to "no selection". react-aria-components' Select has
// neither, so this is built on ComboBox (type-ahead is native there) with an
// explicit clear control — dropping either would have been a real functional
// regression, not just a restyle.
export interface ComboOption {
  value: string;
  label: string;
}

interface Props {
  /** undefined = no filter applied. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: ComboOption[];
  placeholder: string;
  'aria-label': string;
  disabled?: boolean;
  /** Shown in place of the list when there are no options (antd's notFoundContent). */
  emptyMessage?: string;
  className?: string;
}

export function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  'aria-label': ariaLabel,
  disabled,
  emptyMessage,
  className = '',
}: Props) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [filter, options]);

  return (
    <RACComboBox
      aria-label={ariaLabel}
      selectedKey={value ?? null}
      onSelectionChange={(key) => onChange(key == null ? undefined : String(key))}
      inputValue={filter || (value ? (options.find((o) => o.value === value)?.label ?? '') : '')}
      onInputChange={setFilter}
      isDisabled={disabled}
      allowsEmptyCollection
      className={cn('relative', className)}
    >
      <div className="flex h-9 items-center rounded-sm border border-line-control bg-surface pr-1 pl-2.5 focus-within:border-accent has-disabled:opacity-50">
        <RACInput
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink-primary placeholder:text-ink-tertiary focus:outline-none"
        />
        {value != null && (
          <button
            type="button"
            aria-label={`Clear ${ariaLabel}`}
            className="flex-none rounded-sm p-1 text-ink-tertiary hover:text-ink-secondary"
            onClick={() => {
              setFilter('');
              onChange(undefined);
            }}
          >
            <Icon.XClose size={12} />
          </button>
        )}
        <RACButton className="flex-none px-1 text-ink-tertiary">
          <Icon.ChevronDown size={13} />
        </RACButton>
      </div>
      <Popover className="w-(--trigger-width) rounded-md border border-line-hairline bg-surface shadow-card">
        <ListBox
          className="max-h-60 overflow-auto p-1 outline-none"
          renderEmptyState={
            emptyMessage
              ? () => (
                  <div className="px-2.5 py-2 text-[12.5px] text-ink-tertiary italic">
                    {emptyMessage}
                  </div>
                )
              : undefined
          }
        >
          {visible.map((o) => (
            <ListBoxItem
              key={o.value}
              id={o.value}
              textValue={o.label}
              className="cursor-pointer rounded-sm px-2.5 py-1.5 text-sm text-ink-primary outline-none data-[focused]:bg-surface-subtle data-[selected]:bg-accent-tint data-[selected]:text-accent-ink"
            >
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </RACComboBox>
  );
}
