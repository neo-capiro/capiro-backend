import type { ReactNode } from 'react';
import {
  ModalOverlay,
  Modal as RACModal,
  Dialog as RACDialog,
  Heading,
} from 'react-aria-components';

// Handover §5.2/§5.3: modal-shaped surfaces (template Preview, Create
// template, Cc/Bcc, Improve). Controlled open/onClose to match the
// open/onCancel shape every antd Modal call site in this codebase already
// uses, so callers barely change.
interface Props {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, onClose, title, width = 480, children, footer }: Props) {
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 data-[entering]:animate-ov-fade"
    >
      <RACModal
        className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-lg bg-surface shadow-card"
        style={{ maxWidth: width }}
      >
        <RACDialog className="flex max-h-[85vh] flex-col outline-none">
          {title && (
            <Heading
              slot="title"
              className="border-b border-line-hairline px-6 py-4 text-base font-semibold text-ink-primary"
            >
              {title}
            </Heading>
          )}
          <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-line-hairline px-6 py-4">
              {footer}
            </div>
          )}
        </RACDialog>
      </RACModal>
    </ModalOverlay>
  );
}
