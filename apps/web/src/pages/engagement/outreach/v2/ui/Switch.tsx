import type { ReactNode } from 'react';
import { Switch as RACSwitch } from 'react-aria-components';

// Not in handover §5.1/§5.2's component tables, but Send's "Append my email
// signature" toggle needs one — react-aria-components ships a Switch
// primitive, used the same way ui/Checkbox.tsx wraps RAC's Checkbox.
interface Props {
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  children: ReactNode;
}

export function Switch({ isSelected, onChange, children }: Props) {
  return (
    <RACSwitch
      isSelected={isSelected}
      onChange={onChange}
      className="flex items-center gap-2.5 text-[13px] text-ink-primary"
    >
      {({ isSelected: on }) => (
        <>
          <span
            className={`flex h-5 w-9 flex-none items-center rounded-full p-0.5 transition-colors ${
              on ? 'btn-dark' : 'bg-line-control'
            }`}
          >
            <span
              className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${
                on ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </span>
          {children}
        </>
      )}
    </RACSwitch>
  );
}
