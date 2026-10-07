import { useState } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import type { PlannerMyTasksData, PlannerPersonalRule } from '@capiro/strategy-verifier';
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
  const [rules, setRules] = useState<PlannerPersonalRule[]>(() =>
    structuredClone(data.rules ?? []),
  );
  const editRule = (id: string, patch: Partial<PlannerPersonalRule>) =>
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
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
                  rules: rules.map((r) => ({
                    ...r,
                    ...(r.sectionId && !ids.has(r.sectionId) ? { sectionId: null } : {}),
                  })),
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
              <h3>Date rules and reminders</h3>
              <p className="planner-muted">
                Rules run automatically. Calendar days use each task’s time zone (UTC when unset).
                Each rule runs once per due schedule. Only your assigned, unfinished work is
                included.
              </p>
              {rules.map((rule) => (
                <fieldset key={rule.id} className="planner-rule-editor">
                  <legend>{rule.name || 'Personal date rule'}</legend>
                  <label className="planner-field">
                    <span>Rule name</span>
                    <input
                      required
                      maxLength={200}
                      value={rule.name}
                      onChange={(e) => editRule(rule.id, { name: e.target.value })}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => editRule(rule.id, { enabled: e.target.checked })}
                    />{' '}
                    Enabled
                  </label>
                  <div className="planner-form-grid">
                    <label className="planner-field">
                      <span>When</span>
                      <select
                        value={rule.trigger}
                        onChange={(e) =>
                          editRule(rule.id, {
                            trigger: e.target.value as PlannerPersonalRule['trigger'],
                          })
                        }
                      >
                        <option value="due_approaching">Due date is approaching</option>
                        <option value="overdue">Task is overdue</option>
                      </select>
                    </label>
                    <label className="planner-field">
                      <span>
                        {rule.trigger === 'overdue' ? 'After due date' : 'Before due date'}
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={
                          rule.schedule.unit === 'days'
                            ? 365
                            : rule.schedule.unit === 'hours'
                              ? 8760
                              : 525600
                        }
                        value={rule.schedule.amount}
                        onChange={(e) =>
                          editRule(rule.id, {
                            schedule: { ...rule.schedule, amount: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                    <label className="planner-field">
                      <span>Offset unit</span>
                      <select
                        value={rule.schedule.unit}
                        onChange={(e) =>
                          editRule(rule.id, {
                            schedule: {
                              amount: 0,
                              unit: e.target.value as PlannerPersonalRule['schedule']['unit'],
                            },
                          })
                        }
                      >
                        <option value="days">Calendar days</option>
                        <option value="hours">Hours</option>
                        <option value="minutes">Minutes</option>
                      </select>
                    </label>
                    <label className="planner-field">
                      <span>Move to personal section</span>
                      <select
                        value={rule.sectionId === undefined ? 'keep' : (rule.sectionId ?? '')}
                        onChange={(e) =>
                          editRule(rule.id, {
                            sectionId:
                              e.target.value === 'keep' ? undefined : e.target.value || null,
                          })
                        }
                      >
                        <option value="keep">Keep section</option>
                        <option value="">Recently assigned</option>
                        {sections.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={rule.notify}
                      onChange={(e) => editRule(rule.id, { notify: e.target.checked })}
                    />{' '}
                    Remind me in Planner Inbox and Capiro’s bell
                  </label>
                  <button
                    type="button"
                    onClick={() => setRules(rules.filter((r) => r.id !== rule.id))}
                  >
                    Remove rule {rule.name}
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                disabled={rules.length >= 100}
                onClick={() =>
                  setRules([
                    ...rules,
                    {
                      id: crypto.randomUUID(),
                      name: 'Due soon',
                      enabled: true,
                      trigger: 'due_approaching',
                      schedule: { amount: 3, unit: 'days' },
                      notify: true,
                    },
                  ])
                }
              >
                Add personal date rule
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
