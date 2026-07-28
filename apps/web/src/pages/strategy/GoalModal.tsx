/*
 * Create-a-strategy modal (CRT) — ported from the prototype sp-landing.jsx
 * GoalModal. Manual create is always available. When Meri is enabled
 * (strategyPlannerMeri), the modal also offers "Draft with Meri" (CRT-11): the
 * goal + optional grounding documents (CRT-12) are handed to the orchestrator,
 * a progress takeover plays while it drafts, and the finished plan opens in the
 * editor with its version-1 authored by Meri. The type picker is rendered per
 * plan D5 (the prototype defined OBJECTIVE_TYPES but never showed a picker).
 * The CRT-6 owner picker is a searchable org-member dropdown (OwnerPicker)
 * defaulting to the current user.
 */
import { useEffect, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import { useUser } from '@clerk/clerk-react';
import { Overlay, Icon, btnPrimary, btnGhost, iconBtn, lbl } from './strategy-ui.js';
import { OwnerPicker } from './OwnerPicker.js';
import { OBJECTIVE_TYPES } from './constants.js';
import { useCreateStrategy, useDraftStrategy, useUploadAttachment } from './api.js';
import { useTenantMembers } from './members.js';
import type { ClientLite } from './clients-lite.js';
import type { StrategyDraftErrorBody, StrategyType } from './types.js';

const DEFAULT_DRAFT_ERROR_MESSAGE =
  "Meri needs a little more information before it can build this timeline.";

/**
 * Phase 5 §7 — a typed draft-422 body, or null for anything else (network
 * failure, a genuinely unexpected 5xx). Duck-typed off the axios error shape
 * (same idiom as agents/agent-utils.ts's httpStatus) rather than importing an
 * axios type here — this file has no other axios-shaped error handling today.
 */
function draftInputError(err: unknown): StrategyDraftErrorBody | null {
  const res = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  if (res?.status !== 422) return null;
  const body = res.data as Partial<StrategyDraftErrorBody> | null | undefined;
  if (!body || (body.code !== 'STRATEGY_DRAFT_INPUT_REQUIRED' && body.code !== 'STRATEGY_DRAFT_INVALID')) {
    return null;
  }
  return {
    code: body.code,
    message: typeof body.message === 'string' && body.message ? body.message : DEFAULT_DRAFT_ERROR_MESSAGE,
    requiredInputs: Array.isArray(body.requiredInputs) ? body.requiredInputs : [],
    violations: Array.isArray(body.violations) ? body.violations : undefined,
  };
}

interface DocChip {
  localId: string;
  filename: string;
  id: string | null;
  uploading: boolean;
}

let docSeq = 0;

export function GoalModal({
  clients,
  meriEnabled = false,
  firmConfigured = true,
  onConfigureFirm,
  onClose,
  onCreated,
}: {
  clients: ClientLite[];
  meriEnabled?: boolean;
  firmConfigured?: boolean;
  onConfigureFirm?: () => void;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { user } = useUser();
  const { message } = AntApp.useApp();
  const create = useCreateStrategy();
  const draft = useDraftStrategy();
  const upload = useUploadAttachment();
  const members = useTenantMembers();

  const [type, setType] = useState<StrategyType>('appropriations');
  const [client, setClient] = useState('');
  const [goal, setGoal] = useState('');
  const [deadline, setDeadline] = useState('');
  const [context, setContext] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocChip[]>([]);
  // Phase 5 §7: a typed draft-422 — shown inline in this SAME flow, never a
  // navigation, and cleared the moment a new draft attempt starts.
  const [draftError, setDraftError] = useState<StrategyDraftErrorBody | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const effectiveOwner = owner ?? user?.id ?? null;

  const uploading = docs.some((d) => d.uploading);
  const attachmentIds = docs.filter((d) => d.id).map((d) => d.id as string);
  const clientName = clients.find((c) => c.id === client)?.name ?? 'the client';
  const busy = create.isPending || draft.isPending;
  // Meri needs something to work from: a goal or at least one grounding doc.
  const canDraft = !!client && !busy && !uploading && (goal.trim().length > 0 || attachmentIds.length > 0);

  const pickDocs = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files).slice(0, 8)) {
      const localId = `d${docSeq++}`;
      setDocs((ds) => [...ds, { localId, filename: file.name, id: null, uploading: true }]);
      upload
        .mutateAsync(file)
        .then((res) => {
          if (!res.id) {
            message.warning(`${file.name} could not be attached.`);
            setDocs((ds) => ds.filter((d) => d.localId !== localId));
          } else {
            setDocs((ds) => ds.map((d) => (d.localId === localId ? { ...d, id: res.id, uploading: false } : d)));
          }
        })
        .catch(() => {
          message.error(`Could not upload ${file.name}.`);
          setDocs((ds) => ds.filter((d) => d.localId !== localId));
        });
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async () => {
    if (!client) return;
    try {
      const created = await create.mutateAsync({
        clientId: client,
        type,
        goal: goal.trim() || undefined,
        ownerUserId: effectiveOwner ?? undefined,
        targetDate: deadline || undefined,
        meriContext: context.trim() || undefined,
      });
      onCreated(created.id);
    } catch {
      message.error('Could not create the strategy. Please try again.');
    }
  };

  const submitDraft = async () => {
    if (!canDraft) return;
    setDraftError(null);
    try {
      const created = await draft.mutateAsync({
        clientId: client,
        type,
        goal: goal.trim() || undefined,
        meriContext: context.trim() || undefined,
        ownerUserId: effectiveOwner ?? undefined,
        targetDate: deadline || undefined,
        attachmentIds: attachmentIds.length ? attachmentIds : undefined,
      });
      // Phase 5 §7: the timeline route only ever loads on a genuine success —
      // a typed 422 below never calls onCreated, so there is no strategy id
      // to navigate to and none is invented.
      onCreated(created.id);
    } catch (err) {
      const typed = draftInputError(err);
      if (typed) {
        setDraftError(typed);
        return;
      }
      message.error('Meri could not draft a plan just now. Try again, or start from an empty timeline.');
    }
  };

  const field: React.CSSProperties = {
    width: '100%',
    border: '1px solid var(--border-2)',
    borderRadius: 9,
    padding: '9px 13px',
    fontSize: 'var(--text-base)',
    fontFamily: 'var(--font-sans)',
    color: 'var(--ink-1)',
    background: 'var(--bg-surface)',
    boxSizing: 'border-box',
  };

  return (
    <Overlay onClose={draft.isPending ? () => {} : onClose}>
      <div
        style={{
          width: 580,
          background: 'var(--bg-surface)',
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(12,26,56,0.28)',
        }}
      >
        {draft.isPending ? (
          <DraftProgress clientName={clientName} />
        ) : (
          <>
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-1)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 'var(--text-2xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--ink-4)',
                fontWeight: 600,
              }}
            >
              NEW STRATEGY
            </div>
            <div
              style={{
                fontSize: 'var(--text-lg)',
                fontWeight: 700,
                color: 'var(--ink-1)',
                marginTop: 2,
              }}
            >
              What are you trying to achieve?
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={iconBtn}>
            <Icon name="x" size={16} color="var(--ink-3)" />
          </button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          <label style={lbl}>
            Client <span style={{ color: 'var(--critical)', fontWeight: 700 }}>*</span>
          </label>
          <select
            value={client}
            onChange={(e) => setClient(e.target.value)}
            style={{
              ...field,
              border: client ? '1px solid var(--border-2)' : '1px solid var(--critical)',
              color: client ? 'var(--ink-1)' : 'var(--ink-3)',
              marginBottom: 18,
            }}
          >
            <option value="">Select a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <label style={lbl}>Objective type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as StrategyType)}
            style={{ ...field, marginBottom: 4 }}
          >
            {OBJECTIVE_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <div
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--ink-3)',
              marginBottom: 18,
              lineHeight: 1.4,
            }}
          >
            {OBJECTIVE_TYPES.find((t) => t.id === type)?.desc}
          </div>

          <label style={lbl}>Goal statement</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            placeholder="e.g. Secure a $14M FY27 HAC-D plus-up for the compliance program and authorize it in the NDAA."
            style={{ ...field, resize: 'none', lineHeight: 1.5 }}
          />

          <div style={{ display: 'flex', gap: 14, marginTop: 18 }}>
            <div style={{ flex: 1 }}>
              <label style={lbl}>Owner</label>
              <OwnerPicker members={members.data ?? []} value={effectiveOwner} onChange={setOwner} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl}>
                Target outcome date{' '}
                <span
                  style={{
                    fontWeight: 400,
                    textTransform: 'none',
                    letterSpacing: 0,
                    color: 'var(--ink-3)',
                  }}
                >
                  · optional
                </span>
              </label>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                style={field}
              />
            </div>
          </div>

          <label style={{ ...lbl, marginTop: 18 }}>
            Context for Meri{' '}
            <span
              style={{
                fontWeight: 400,
                textTransform: 'none',
                letterSpacing: 0,
                color: 'var(--ink-3)',
              }}
            >
              · optional
            </span>
          </label>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={2}
            placeholder="Key players, constraints, prior history, sensitivities — anything that should shape the plan."
            style={{ ...field, resize: 'none', lineHeight: 1.5 }}
          />

          {meriEnabled && (
            <>
              <label style={{ ...lbl, marginTop: 18 }}>
                Grounding documents{' '}
                <span
                  style={{
                    fontWeight: 400,
                    textTransform: 'none',
                    letterSpacing: 0,
                    color: 'var(--ink-3)',
                  }}
                >
                  · optional
                </span>
              </label>
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => pickDocs(e.target.files)} />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                style={{
                  ...btnGhost,
                  width: '100%',
                  justifyContent: 'center',
                  borderStyle: 'dashed',
                  padding: '10px 13px',
                }}
              >
                <Icon name="paperclip" size={14} color="var(--ink-2)" /> Attach memos, bill text, or prior plans
              </button>
              {docs.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {docs.map((d) => (
                    <span
                      key={d.localId}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 'var(--text-2xs)',
                        background: 'var(--bg-surface-2)',
                        border: '1px solid var(--border-2)',
                        borderRadius: 6,
                        padding: '3px 7px',
                        color: 'var(--ink-2)',
                        opacity: d.uploading ? 0.6 : 1,
                      }}
                    >
                      <Icon name="paperclip" size={11} color="var(--ink-3)" />
                      <span
                        style={{
                          maxWidth: 160,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {d.filename}
                      </span>
                      {d.uploading ? (
                        <span style={{ fontSize: 8 }}>…</span>
                      ) : (
                        <span
                          onClick={() => setDocs((ds) => ds.filter((x) => x.localId !== d.localId))}
                          style={{ cursor: 'pointer', display: 'grid' }}
                        >
                          <Icon name="x" size={10} color="var(--ink-4)" />
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          <div
            style={{
              marginTop: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-1)',
              borderRadius: 9,
              padding: '10px 13px',
            }}
          >
            <Icon name="spark" size={15} color="var(--accent)" />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-2)' }}>
              {meriEnabled
                ? 'Draft with Meri turns your goal and any documents into a sequenced plan on the fiscal timeline — every step stays editable. Or start from an empty timeline.'
                : 'Start with an empty timeline and add steps. Meri drafting and document import arrive soon.'}
            </span>
          </div>

          {!firmConfigured && (
            <div
              style={{
                marginTop: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: 'var(--bg-surface-2)',
                border: '1px dashed var(--border-strong)',
                borderRadius: 9,
                padding: '10px 13px',
              }}
            >
              <Icon name="calendar" size={15} color="var(--ink-3)" />
              <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--ink-2)' }}>
                Your firm phases aren't set yet — the timeline will use the standard template until
                you configure them.
              </span>
              {onConfigureFirm && (
                <button
                  onClick={onConfigureFirm}
                  style={{ ...btnGhost, padding: '6px 12px', fontSize: 'var(--text-sm)' }}
                >
                  Set phases
                </button>
              )}
            </div>
          )}

          {draftError && (
            <div
              data-testid="sp-goal-draft-error"
              style={{
                marginTop: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border-1)',
                borderRadius: 9,
                padding: '10px 13px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ marginTop: 1, flexShrink: 0 }}>
                  <Icon name="info" size={14} color="var(--ink-3)" />
                </span>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-2)', lineHeight: 1.4 }}>
                  {draftError.message}
                </span>
              </div>
              {draftError.requiredInputs.length > 0 && (
                <ul
                  style={{
                    margin: 0,
                    padding: '0 0 0 22px',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--ink-2)',
                    lineHeight: 1.5,
                  }}
                >
                  {draftError.requiredInputs.map((r) => (
                    <li key={r.code}>{r.label}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-1)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            background: 'var(--bg-surface-2)',
          }}
        >
          <button onClick={onClose} style={btnGhost}>
            Cancel
          </button>
          {meriEnabled ? (
            <>
              <button
                onClick={submit}
                disabled={!client || busy}
                title={client ? 'Create an empty timeline' : 'Select a client first'}
                style={{
                  ...btnGhost,
                  opacity: !client || busy ? 0.45 : 1,
                  cursor: !client || busy ? 'not-allowed' : 'pointer',
                }}
              >
                {create.isPending ? 'Creating…' : 'Start empty'}
              </button>
              <button
                onClick={submitDraft}
                disabled={!canDraft}
                title={
                  !client
                    ? 'Select a client first'
                    : canDraft
                      ? 'Meri drafts a full plan'
                      : 'Add a goal or a document for Meri to work from'
                }
                style={{
                  ...btnPrimary,
                  opacity: canDraft ? 1 : 0.45,
                  cursor: canDraft ? 'pointer' : 'not-allowed',
                }}
              >
                <Icon name="spark" size={14} color="#fff" /> Draft with Meri
              </button>
            </>
          ) : (
            <button
              onClick={submit}
              disabled={!client || create.isPending}
              title={client ? '' : 'Select a client first'}
              style={{
                ...btnPrimary,
                opacity: !client || create.isPending ? 0.45 : 1,
                cursor: !client || create.isPending ? 'not-allowed' : 'pointer',
              }}
            >
              {create.isPending ? 'Creating…' : 'Create strategy'}
              {!create.isPending && <Icon name="arrow" size={14} color="#fff" />}
            </button>
          )}
        </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

/**
 * CRT-11 progress takeover. Drafting can take up to ~90s (the orchestrator runs
 * a bounded tool loop over the client context pack), so the modal body is
 * replaced with a reassuring, self-advancing status list. The steps are
 * cosmetic — they narrate what Meri is doing without polling the server.
 */
function DraftProgress({ clientName }: { clientName: string }) {
  const steps = [
    'Reading your goal and context',
    `Pulling ${clientName}'s profile and tracked bills`,
    'Checking the legislative and PPBE calendars',
    'Sequencing the plan across the fiscal timeline',
    'Writing the steps',
  ];
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setActive((n) => Math.min(n + 1, steps.length - 1)), 4200);
    return () => window.clearInterval(t);
    // steps is a stable literal for the life of this component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: '40px 34px 38px', textAlign: 'center' }}>
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: '50%',
          background: 'var(--accent-soft)',
          display: 'grid',
          placeItems: 'center',
          margin: '0 auto 16px',
        }}
      >
        <span className="sp-spark-pulse" style={{ display: 'grid' }}>
          <Icon name="spark" size={24} color="var(--accent)" />
        </span>
      </div>
      <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--ink-1)' }}>
        Meri is drafting your plan
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)', marginTop: 4 }}>
        This usually takes under a minute.
      </div>
      <div
        style={{
          marginTop: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 11,
          textAlign: 'left',
          maxWidth: 340,
          margin: '22px auto 0',
        }}
      >
        {steps.map((label, i) => {
          const done = i < active;
          const current = i === active;
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                  background: done ? 'var(--success)' : current ? 'var(--accent)' : 'var(--border-2)',
                }}
              >
                {done ? (
                  <Icon name="check" size={11} color="#fff" />
                ) : current ? (
                  <span className="sp-spark-pulse" style={{ display: 'grid' }}>
                    <Icon name="spark" size={10} color="#fff" />
                  </span>
                ) : null}
              </span>
              <span
                style={{
                  fontSize: 'var(--text-sm)',
                  color: done || current ? 'var(--ink-1)' : 'var(--ink-3)',
                  fontWeight: current ? 600 : 400,
                }}
              >
                {label}
                {current ? '…' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
