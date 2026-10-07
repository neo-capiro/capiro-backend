import type { ReactNode } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';

export function PlannerTimeDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className="planner-modal-overlay"
    >
      <Modal className="planner-modal">
        <Dialog aria-label={title}>
          <header className="planner-dialog-head">
            <Heading slot="title">{title}</Heading>
            <button type="button" aria-label={`Close ${title}`} onClick={onClose}>
              ×
            </button>
          </header>
          <div className="planner-dialog-body">{children}</div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
