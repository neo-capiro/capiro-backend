import { Fragment, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Eye,
  RefreshCcw,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  OutreachV3DraftArtifact,
  OutreachV3GenerationPlan,
} from './engagement-api.js';
import {
  approvalCount,
  partitionDrafts,
} from './outreach-v3-phase1-model.js';
import {
  type DraftDiff,
  recipientPresentation,
} from './outreach-v3-phase1-shared.js';
import { DraftCard } from './outreach-v3-phase1-draft-card.js';
import { DraftRecipientControls } from './outreach-v3-draft-recipient-controls.js';

export function DraftReviewScreen({
  plan,
  drafts,
  busy,
  refineBusyId,
  diffs,
  error,
  onApprove,
  onApproveMany,
  onRefine,
  onRefineMany,
  onRegenerateMany,
  onEdit,
  onGoSend,
}: {
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  busy: boolean;
  refineBusyId: string | null;
  diffs: Map<string, DraftDiff>;
  error: string | null;
  onApprove: (draft: OutreachV3DraftArtifact) => void;
  onApproveMany: (drafts: OutreachV3DraftArtifact[]) => void;
  onRefine: (draft: OutreachV3DraftArtifact, instruction: string) => void;
  onRefineMany: (drafts: OutreachV3DraftArtifact[], instruction: string) => void;
  onRegenerateMany: (drafts: OutreachV3DraftArtifact[]) => void;
  onEdit: (draft: OutreachV3DraftArtifact) => void;
  onGoSend: () => void;
}) {
  const { judgment, matching } = useMemo(() => partitionDrafts(drafts), [drafts]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(judgment.slice(0, 3).map((draft) => draft.id)),
  );
  const [bulkRefineOpen, setBulkRefineOpen] = useState(false);
  const [bulkInstruction, setBulkInstruction] = useState('');
  const [readMatching, setReadMatching] = useState(false);
  const [individualApproval, setIndividualApproval] = useState(false);
  const approved = approvalCount(drafts);
  const matchingApproved =
    matching.length > 0 &&
    matching.every((draft) => draft.current?.approvalStatus === 'approved');
  const allJudgmentSelected =
    judgment.length > 0 && judgment.every((draft) => selected.has(draft.id));
  const selectedDrafts = drafts.filter((draft) => selected.has(draft.id));

  const toggleSelect = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleOpen = (id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const approveMatching = () => {
    onApproveMany(
      matching.filter((draft) => draft.current?.approvalStatus !== 'approved'),
    );
  };

  const renderDraft = (draft: OutreachV3DraftArtifact, forceOpen = false) => (
    <Fragment key={draft.id}>
      <DraftCard
        draft={draft}
        recipient={recipientPresentation(draft, plan)}
        selected={selected.has(draft.id)}
        open={open.has(draft.id) || forceOpen}
        busy={busy}
        refineBusy={refineBusyId === draft.id}
        diff={diffs.get(draft.id)}
        onSelect={() => toggleSelect(draft.id)}
        onToggle={() => toggleOpen(draft.id)}
        onApprove={() => onApprove(draft)}
        onEdit={() => onEdit(draft)}
        onRefine={(instruction) => onRefine(draft, instruction)}
      />
      <DraftRecipientControls
        draft={draft}
        busy={busy}
        refineBusy={refineBusyId === draft.id}
        onEdit={() => onEdit(draft)}
        onRefine={(instruction) => onRefine(draft, instruction)}
      />
    </Fragment>
  );

  return (
    <div className="ov3p1-content ov3p1-content--narrow">
      <h2>
        {approved >= drafts.length && drafts.length
          ? `All ${drafts.length} approved.`
          : `${drafts.length} drafts. ${judgment.length} need your judgment.`}
      </h2>
      <p className="ov3p1-lead">
        {approved >= drafts.length && drafts.length
          ? 'Every draft is an exact approved version. If anything changes, that draft comes back to you.'
          : `The ${judgment.length || 'few'} that need a decision are first, with what each one drew on and what Capiro checked. The rest follow the approved campaign packet and passed the same governed checks.`}
      </p>

      <div className="ov3p1-review-toolbar">
        <button
          type="button"
          className="ov3p1-select-all"
          onClick={() =>
            setSelected(
              allJudgmentSelected
                ? new Set()
                : new Set(judgment.map((draft) => draft.id)),
            )
          }
        >
          <span data-checked={allJudgmentSelected || undefined}>
            {allJudgmentSelected ? <Check size={13} /> : null}
          </span>
          {allJudgmentSelected
            ? 'Clear selection'
            : `Select the ${judgment.length} that need you`}
        </button>
        <span>
          {approved} of {drafts.length} approved
        </span>
      </div>

      {selected.size ? (
        <div className="ov3p1-bulk-bar">
          <strong>
            {selected.size} draft{selected.size === 1 ? '' : 's'} selected
          </strong>
          <button type="button" onClick={() => onApproveMany(selectedDrafts)}>
            <Check size={14} /> Approve selected
          </button>
          <button type="button" onClick={() => setBulkRefineOpen(true)}>
            <Sparkles size={14} /> Refine with Meri
          </button>
          <button type="button" onClick={() => onRegenerateMany(selectedDrafts)}>
            <RefreshCcw size={14} /> Regenerate
          </button>
          <button type="button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}

      {bulkRefineOpen ? (
        <section className="ov3p1-refine-panel is-bulk">
          <header>
            <div>
              <span>Selected drafts</span>
              <h3>Describe one change for all {selectedDrafts.length}</h3>
            </div>
            <button
              type="button"
              className="ov3p1-icon-button"
              onClick={() => setBulkRefineOpen(false)}
            >
              <X size={16} />
            </button>
          </header>
          <textarea
            rows={3}
            value={bulkInstruction}
            onChange={(event: { target: { value: string } }) => setBulkInstruction(event.target.value)}
          />
          <button
            type="button"
            className="ov3p1-button is-primary"
            disabled={!bulkInstruction.trim() || busy}
            onClick={() => onRefineMany(selectedDrafts, bulkInstruction.trim())}
          >
            <Sparkles size={14} /> Create new versions
          </button>
        </section>
      ) : null}

      <div className="ov3p1-draft-stack">
        {judgment.map((draft) => renderDraft(draft))}
      </div>

      <section
        className="ov3p1-matching-block"
        data-approved={matchingApproved || undefined}
      >
        <div>
          <span className="ov3p1-match-dot" />
          <div>
            <h3>
              {individualApproval
                ? `Individual approval is on — ${matching.length} to read`
                : matchingApproved
                  ? `${matching.length} approved · exact versions locked`
                  : `${matching.length} drafts follow the approved campaign packet and have no identified issues.`}
            </h3>
            <p>
              {individualApproval
                ? 'You will read and approve each yourself. Capiro will not offer group approval again for this campaign.'
                : matchingApproved
                  ? 'The exact text you approved is what sends. If any version changes, that draft comes back to you first.'
                  : 'Same approved subject, governed context, campaign ask and length. Approval locks these exact versions.'}
            </p>
          </div>
        </div>
        {!individualApproval && !matchingApproved ? (
          <div className="ov3p1-matching-actions">
            <button
              type="button"
              className="ov3p1-button is-primary"
              disabled={busy || !matching.length}
              onClick={approveMatching}
            >
              <Check size={15} /> Approve these {matching.length} exact versions
            </button>
            <button
              type="button"
              className="ov3p1-button is-secondary"
              onClick={() => setReadMatching(true)}
            >
              <Eye size={15} /> Read all {matching.length}
            </button>
            <button
              type="button"
              className="ov3p1-button is-quiet"
              onClick={() => setIndividualApproval(true)}
            >
              Require individual approval
            </button>
          </div>
        ) : null}
        {matchingApproved ? (
          <p className="ov3p1-approval-note">
            Exact-version approval is recorded by the server. Editing or refining
            any draft clears only that changed version&apos;s approval.
          </p>
        ) : null}
      </section>

      {readMatching || individualApproval ? (
        <div className="ov3p1-draft-stack is-matching">
          {matching.map((draft) => renderDraft(draft, individualApproval))}
        </div>
      ) : null}

      {error ? (
        <p className="ov3p1-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="ov3p1-primary-row">
        <button
          type="button"
          className="ov3p1-button is-primary"
          onClick={onGoSend}
        >
          Take me to sending <ArrowRight size={16} />
        </button>
        <span>Nothing sends from this screen.</span>
      </div>
    </div>
  );
}
