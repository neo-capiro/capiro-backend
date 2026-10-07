import { useState, type FormEvent } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import type { PlannerSavedViewData } from '@capiro/strategy-verifier';
import { usePlannerMutations, plannerError } from './planner-api.js';
export function SavePlannerView({
  data,
  onClose,
}: {
  data: PlannerSavedViewData;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const actions = usePlannerMutations();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await actions.resource.mutateAsync({ kind: 'saved_view', name, data: { ...data } });
      onClose();
    } catch {}
  };
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className="planner-modal-overlay"
    >
      <Modal className="planner-modal">
        <Dialog aria-label="Save view">
          <form onSubmit={submit}>
            <div className="planner-dialog-head">
              <Heading slot="title">Save view</Heading>
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
            <div className="planner-dialog-body">
              <label className="planner-field">
                <span>View name</span>
                <input
                  required
                  maxLength={500}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <p>Your project, layout, search, filters, and sorting will be saved in Planner.</p>
              {actions.resource.error && (
                <p role="alert" className="planner-error">
                  {plannerError(actions.resource.error)}
                </p>
              )}
            </div>
            <footer className="planner-dialog-footer">
              <button className="planner-primary" disabled={actions.resource.isPending}>
                Save view
              </button>
            </footer>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
