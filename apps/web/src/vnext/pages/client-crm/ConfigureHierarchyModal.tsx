import { useState } from 'react';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import {
  HIERARCHY_LEVELS,
  LEVEL_META,
  placementLabel,
  type HierarchyLevel,
  type OrganizationModel,
} from '../../adapters/legacy/useClientOrganizationModel.js';

/**
 * Configure Hierarchy — Figma `907:3028`.
 *
 * Two jobs: choose which levels the org chart shows, and clear the review
 * queue. Both write through the same hierarchy endpoint the drawer uses, so a
 * placement made here is indistinguishable from one made anywhere else.
 *
 * The rule set itself is read-only: title inference lives in the API
 * (`client-hierarchy.helpers.ts`), and a per-client rule editor is not in the
 * contract. The levels and their example titles are shown so the behaviour is
 * legible rather than magic.
 */
export function ConfigureHierarchyModal({
  model,
  onClose,
}: {
  model: OrganizationModel;
  onClose: () => void;
}) {
  const [visible, setVisible] = useState<Set<HierarchyLevel>>(
    () => new Set(HIERARCHY_LEVELS),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleLevel = (level: HierarchyLevel) =>
    setVisible((previous) => {
      const next = new Set(previous);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

  const place = async (id: string, level: HierarchyLevel | null) => {
    setBusyId(id);
    setError(null);
    try {
      await model.savePlacement.mutateAsync({ id, hierarchyLevel: level });
    } catch (caught) {
      const data = (caught as { response?: { data?: { message?: unknown } } })?.response?.data;
      setError(typeof data?.message === 'string' ? data.message : 'Could not save that placement');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <CapiroModal open title="Configure hierarchy" onClose={onClose}>
      <div className="capiro-crm-form">
        <div>
          <p className="capiro-crm__meta">Mode</p>
          <p className="capiro-crm__field-value">
            Automatic from titles · Corporate standard v3
          </p>
          <p className="capiro-crm__foot">
            Titles are matched most-senior first. A title the rule set does not recognise is
            left unplaced and flagged for review — it is never assumed to be junior.
          </p>
        </div>

        <p className="capiro-crm__meta capiro-crm__setting-head">Visible levels</p>
        <ul className="capiro-crm__levels">
          {HIERARCHY_LEVELS.map((level) => {
            const count = model.people.filter((person) => person.hierarchyLevel === level).length;
            return (
              <li key={level} className="capiro-crm__level">
                <label className="capiro-crm__level-toggle">
                  <input
                    type="checkbox"
                    checked={visible.has(level)}
                    onChange={() => toggleLevel(level)}
                    className="capiro-crm-fill__check"
                  />
                  <span className="capiro-crm__level-label">{LEVEL_META[level].label}</span>
                </label>
                <span className="capiro-crm__meta capiro-crm__level-examples">
                  {LEVEL_META[level].examples}
                </span>
                <span className="capiro-crm__meta">{count}</span>
              </li>
            );
          })}
        </ul>

        {model.needsReview.length > 0 ? (
          <>
            <p className="capiro-crm__meta capiro-crm__setting-head">
              Titles to review · {model.needsReview.length}
            </p>
            <ul className="capiro-crm__rows">
              {model.needsReview.map((person) => (
                <li key={person.id} className="capiro-crm__review-row">
                  <span className="capiro-crm__row-main">
                    <span className="capiro-crm__row-title">{person.name}</span>
                    <span className="capiro-crm__meta capiro-crm__row-meta">
                      {person.title ?? 'No title recorded'} · {placementLabel(person)}
                    </span>
                  </span>
                  <select
                    className="capiro-crm-form__input capiro-crm__review-select"
                    value={person.hierarchyLevel ?? ''}
                    disabled={busyId === person.id}
                    onChange={(event) =>
                      void place(
                        person.id,
                        event.target.value === '' ? null : (event.target.value as HierarchyLevel),
                      )
                    }
                    aria-label={`Place ${person.name}`}
                  >
                    <option value="">Not placed</option>
                    {HIERARCHY_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {LEVEL_META[level].label}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="capiro-crm__foot">Every title in this roster has been resolved.</p>
        )}

        <div className="capiro-crm__chips">
          <CapiroBadge>{model.manualOverrides.length} manual</CapiroBadge>
          <CapiroBadge tone={model.needsReview.length > 0 ? 'warning' : 'neutral'}>
            {model.needsReview.length} to review
          </CapiroBadge>
          <CapiroBadge>{model.unplaced.length} unplaced</CapiroBadge>
        </div>

        {error ? <p className="capiro-crm__foot capiro-crm__state--error">{error}</p> : null}

        <div className="capiro-crm-fill__actions">
          <CapiroButton variant="primary" size="compact" onClick={onClose}>
            Done
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}
