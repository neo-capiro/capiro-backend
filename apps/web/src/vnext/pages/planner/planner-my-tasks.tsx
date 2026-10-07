import { useState } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import type { PlannerMyTasksData } from '@capiro/strategy-verifier';
export function PlannerMyTasksSettings({
  data,
  onSave,
  onClose,
  pending,
  error,
}: {
  data: PlannerMyTasksData;
  onSave: (data: PlannerMyTasksData) => Promise<void>;
  onClose: () => void;
  pending: boolean;
  error: string | null;
}) {
  const [sections, setSections] = useState(() => structuredClone(data.sections));
  const move = (index: number, direction: number) => {
    const next = [...sections];
    const [item] = next.splice(index, 1);
    next.splice(index + direction, 0, item!);
    setSections(next);
  };
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className="planner-modal-overlay"
    >
      <Modal className="planner-modal">
        <Dialog aria-label="My tasks settings">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const ids = new Set(sections.map((s) => s.id));
                await onSave({
                  sections,
                  placements: data.placements.map((p) => ({
                    ...p,
                    sectionId: p.sectionId && ids.has(p.sectionId) ? p.sectionId : null,
                  })),
                });
                onClose();
              } catch {}
            }}
          >
            <div className="planner-dialog-head">
              <Heading slot="title">My tasks settings</Heading>
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
            <div className="planner-dialog-body">
              <p>
                These sections and their task order are private to you. Newly assigned work appears
                in Recently assigned.
              </p>
              {sections.map((section, index) => (
                <div className="planner-personal-section-editor" key={section.id}>
                  <label className="planner-field">
                    <span>Section {index + 1}</span>
                    <input
                      required
                      maxLength={200}
                      value={section.name}
                      onChange={(e) =>
                        setSections(
                          sections.map((s) =>
                            s.id === section.id ? { ...s, name: e.target.value } : s,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Move section ${section.name} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move section ${section.name} down`}
                    disabled={index === sections.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => setSections(sections.filter((s) => s.id !== section.id))}
                  >
                    Remove section {section.name}
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={sections.length >= 100}
                onClick={() =>
                  setSections([...sections, { id: crypto.randomUUID(), name: 'New section' }])
                }
              >
                Add personal section
              </button>
              {error && (
                <p role="alert" className="planner-error">
                  {error}
                </p>
              )}
            </div>
            <footer className="planner-dialog-footer">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="planner-primary" disabled={pending}>
                {pending ? 'Saving…' : 'Save personal sections'}
              </button>
            </footer>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
