/**
 * Create brief — where a hearing becomes a Workspace document.
 *
 * Setup picks the client (a brief is always for a client) and an optional
 * focus; Meri drafts the brief server-side from the grounded hearing context.
 * Review shows the draft beside the same in-editor Meri assistant Workspace
 * uses; its edits apply to the section state that is later saved verbatim, so
 * what the user reviewed is exactly what Workspace stores. Every state is
 * honest — drafting, failed (retry in place), saving — and success is only
 * reported by the caller once the draft exists.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { useWorkspaceAssistant, type WsAssistantEdit } from '../../../../pages/workspace/api.js';
import {
  applyWorkspaceAssistantEdits,
  type WorkspaceSectionState,
} from '../../../../pages/workspace/editor/edit-review.js';
import { sanitizeWorkspaceBody } from '../../../../pages/workspace/editor/workspace-richtext.js';
import { LwModal } from '../overlays/LwModal.js';
import { LwButton } from '../lib/primitives.js';
import {
  briefContextText,
  briefToSectionState,
  briefToWorkspaceConfig,
  timecode,
} from '../lib/brief-workspace.js';
import {
  useCreateBrief,
  useExportBriefDocx,
  useGenerateBrief,
  useSaveBriefToClient,
  w1Error,
  type BriefExportInput,
  type HearingBrief,
} from '../lib/wave1-api.js';

const QUICK_PROMPTS = [
  'Tighten the executive summary',
  'Add a recommended-actions section',
  'Make it one page',
];
const DANGER = { color: 'var(--lw-danger, #b42318)' };

function generateError(err: unknown): string {
  return w1Error(err);
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export function CreateBriefDialog({
  hearingId,
  hearingTitle,
  initialClientId,
  hasTranscript,
  onClose,
  onSaved,
}: {
  hearingId: string;
  hearingTitle: string;
  /** Preselected client; '' when the lens is All Clients. */
  initialClientId: string;
  /** Whether Meri will write a recap (transcript) or a preparation (none yet). */
  hasTranscript: boolean;
  onClose: () => void;
  onSaved: (draftId: string) => void;
}) {
  const api = useApi();
  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const activeClients = useMemo(
    () => (clients.data ?? []).filter((c) => c.status !== 'archived'),
    [clients.data],
  );
  const generate = useGenerateBrief(hearingId);
  const assistant = useWorkspaceAssistant();
  const create = useCreateBrief(hearingId);
  const exportDocx = useExportBriefDocx(hearingId);
  const saveToClient = useSaveBriefToClient(hearingId);

  const [phase, setPhase] = useState<'setup' | 'review'>('setup');
  const [clientId, setClientId] = useState(initialClientId);
  const [focus, setFocus] = useState('');
  const [brief, setBrief] = useState<HearingBrief | null>(null);
  const [state, setState] = useState<WorkspaceSectionState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [undo, setUndo] = useState<WsAssistantEdit[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [clientSaveNotice, setClientSaveNotice] = useState<string | null>(null);
  const [clientSaveError, setClientSaveError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const client = activeClients.find((c) => c.id === clientId);
  const clientName = client?.name;

  useEffect(() => {
    if (!notes.length) return;
    const timer = window.setTimeout(() => setNotes([]), 6_000);
    return () => window.clearTimeout(timer);
  }, [notes]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, assistant.isPending]);

  const runGenerate = () => {
    if (!client || generate.isPending) return;
    const trimmedFocus = focus.trim().slice(0, 600);
    generate.mutate(
      { clientId: client.id, ...(trimmedFocus ? { focus: trimmedFocus } : {}) },
      {
        onSuccess: (result) => {
          setBrief(result);
          setState(briefToSectionState(result));
          setMessages([]);
          setUndo(null);
          setNotes([]);
          setChatError(null);
          setSaveError(null);
          setPhase('review');
        },
      },
    );
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || !brief || !state || assistant.isPending) return;
    const history: ChatMessage[] = [...messages, { role: 'user', text }];
    setMessages(history);
    setInput('');
    setChatError(null);
    try {
      const result = await assistant.mutateAsync({
        messages: history.slice(-20),
        document: {
          title: brief.title,
          ...(clientName ? { client: clientName } : {}),
          sections: state.sections.map((name) => ({ name, content: state.content[name] ?? '' })),
        },
        context: [
          {
            label: 'Hearing context packet',
            text: JSON.stringify(brief.contextPacket).slice(0, 10_000),
          },
        ],
        clientId,
      });
      const outcome = applyWorkspaceAssistantEdits(state, result.edits ?? []);
      if (outcome.applied.length) {
        setState(outcome.state);
        setUndo(outcome.inverseEdits);
      }
      setNotes(outcome.skipped.map((skip) => `Not applied: ${skip.reason}`));
      setMessages([
        ...history,
        {
          role: 'assistant',
          text:
            result.reply?.trim() ||
            (outcome.applied.length ? 'Applied the change to the draft.' : 'No changes proposed.'),
        },
      ]);
    } catch (err) {
      setChatError(w1Error(err));
    }
  };

  const undoLast = () => {
    if (!state || !undo || assistant.isPending) return;
    setState(applyWorkspaceAssistantEdits(state, undo).state);
    setUndo(null);
  };

  const exportInput = (): BriefExportInput => ({
    title: brief!.title,
    mode: brief!.mode,
    sections: state!.sections.map((name) => ({ name, content: state!.content[name] ?? '' })),
    sources: brief!.sources,
    ...(clientName ? { clientName } : {}),
  });

  const downloadDocx = () => {
    if (!brief || !state || exportDocx.isPending) return;
    setExportError(null);
    exportDocx.mutate(exportInput(), { onError: (err) => setExportError(w1Error(err)) });
  };

  const saveToClientProfile = () => {
    if (!brief || !state || !clientId || saveToClient.isPending) return;
    setClientSaveNotice(null);
    setClientSaveError(null);
    saveToClient.mutate(
      { ...exportInput(), clientId },
      {
        onSuccess: () => setClientSaveNotice(`Saved to ${clientName ?? 'the client'}'s Documents.`),
        onError: (err) => setClientSaveError(w1Error(err)),
      },
    );
  };

  const save = async () => {
    if (!brief || !state || !clientId || create.isPending) return;
    setSaveError(null);
    try {
      const { draftId } = await create.mutateAsync({
        docTitle: brief.title,
        ...(clientName ? { client: clientName } : {}),
        config: briefToWorkspaceConfig({
          hearingId,
          clientId,
          mode: brief.mode,
          sources: brief.sources,
          state,
        }),
        contextText: briefContextText(brief),
      });
      onSaved(draftId);
    } catch (err) {
      setSaveError(w1Error(err));
    }
  };

  /** Saving to the client's Documents is a real write in flight; closing the
   *  dialog mid-save would discard the only place its outcome is reported. */
  const closeGuarded = () => {
    if (saveToClient.isPending) return;
    onClose();
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const reviewing = phase === 'review' && brief !== null && state !== null;

  return (
    <LwModal
      kind="brief"
      eyebrow="Create brief"
      title="Create a brief"
      subtitle={hearingTitle}
      note={
        reviewing
          ? 'Saving creates a Workspace document you can keep editing there.'
          : 'Meri drafts from the hearing record. Nothing is saved until you have reviewed it.'
      }
      primaryLabel={
        reviewing
          ? create.isPending
            ? 'Saving…'
            : 'Save to Workspace'
          : generate.isPending
            ? 'Drafting your brief…'
            : generate.isError
              ? 'Try again'
              : brief
                ? 'Generate again'
                : 'Generate brief'
      }
      onPrimary={reviewing ? () => void save() : runGenerate}
      primaryDisabled={
        reviewing ? create.isPending || assistant.isPending : generate.isPending || !client
      }
      primaryTitle={!reviewing && !client ? 'Choose the client this brief is for.' : undefined}
      secondaryLabel={reviewing ? 'Back' : undefined}
      onSecondary={reviewing ? () => setPhase('setup') : undefined}
      secondaryDisabled={create.isPending}
      onClose={closeGuarded}
      dirty={brief !== null && !create.isPending}
    >
      {phase === 'review' && brief && state ? (
        <>
          <div className="lw-brief__review">
            <div className="lw-brief__doc">
              <span className="lw-eyebrow">
                {brief.mode === 'recap' ? 'Recap brief' : 'Preparation brief'}
                {brief.sources.length
                  ? ` · grounded in ${brief.sources.length} source${brief.sources.length === 1 ? '' : 's'}`
                  : ''}
              </span>
              <h3>{brief.title}</h3>
              {brief.lowConfidence ? (
                <p role="status" className="lw-card__meta">
                  Meri flagged this draft as low confidence. Check its claims against the transcript
                  and sources before sharing.
                </p>
              ) : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
                <LwButton disabled={exportDocx.isPending} onClick={downloadDocx}>
                  {exportDocx.isPending ? 'Preparing download…' : 'Download .docx'}
                </LwButton>
                <LwButton disabled={saveToClient.isPending} onClick={saveToClientProfile}>
                  {saveToClient.isPending ? 'Saving…' : 'Save to client profile'}
                </LwButton>
              </div>
              {exportDocx.isPending ? (
                <p role="status" className="lw-card__meta" style={{ margin: '0 0 8px' }}>
                  Preparing your download…
                </p>
              ) : null}
              {exportError ? (
                <p role="alert" className="lw-card__meta" style={{ margin: '0 0 8px', ...DANGER }}>
                  {exportError}
                </p>
              ) : null}
              {saveToClient.isPending ? (
                <p role="status" className="lw-card__meta" style={{ margin: '0 0 8px' }}>
                  Saving to {clientName ?? 'the client'}'s Documents…
                </p>
              ) : null}
              {clientSaveError ? (
                <p role="alert" className="lw-card__meta" style={{ margin: '0 0 8px', ...DANGER }}>
                  {clientSaveError}
                </p>
              ) : clientSaveNotice ? (
                <p role="status" className="lw-card__meta" style={{ margin: '0 0 8px' }}>
                  {clientSaveNotice}
                </p>
              ) : null}
              {state.sections.map((name) => (
                <section key={name} aria-label={name}>
                  <h4>{name}</h4>
                  <div
                    className="lw-brief__section"
                    dangerouslySetInnerHTML={{
                      __html: sanitizeWorkspaceBody(state.content[name] ?? ''),
                    }}
                  />
                </section>
              ))}
              {brief.keyMoments.length ? (
                <details style={{ marginTop: 16 }}>
                  <summary className="lw-eyebrow" style={{ cursor: 'pointer' }}>
                    Key moments ({brief.keyMoments.length})
                  </summary>
                  <ul className="lw-brief__section" style={{ marginTop: 6 }}>
                    {brief.keyMoments.map((moment, i) => (
                      <li key={i}>
                        {moment.startMs != null ? (
                          <span
                            className="lw-mono"
                            style={{ fontSize: 11, color: 'var(--lw-meta)', marginRight: 6 }}
                          >
                            {timecode(moment.startMs)}
                          </span>
                        ) : null}
                        {moment.speaker ? <strong>{moment.speaker}: </strong> : null}
                        {moment.summary}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>

            <aside className="lw-brief__chat" aria-label="Refine with Meri">
              <span className="lw-eyebrow">Refine with Meri</span>
              <div ref={logRef} className="lw-brief__log" role="log" aria-live="polite">
                {messages.length === 0 ? (
                  <p className="lw-card__meta" style={{ margin: 0 }}>
                    Ask for changes in plain language. Edits apply to the draft on the left.
                  </p>
                ) : null}
                {messages.map((message, i) => (
                  <div key={i} className={`lw-brief__msg lw-brief__msg--${message.role}`}>
                    <span className="lw-eyebrow">{message.role === 'user' ? 'You' : 'Meri'}</span>
                    <p style={{ margin: '2px 0 0' }}>{message.text}</p>
                  </div>
                ))}
                {assistant.isPending ? (
                  <p role="status" className="lw-card__meta" style={{ margin: 0 }}>
                    Meri is working…
                  </p>
                ) : null}
                {chatError ? (
                  <p role="alert" className="lw-card__meta" style={{ margin: 0, ...DANGER }}>
                    {chatError}
                  </p>
                ) : null}
                {notes.length ? (
                  <p role="status" className="lw-card__meta" style={{ margin: 0 }}>
                    {notes.join(' ')}
                  </p>
                ) : null}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="lw-btn lw-brief__chip"
                    disabled={assistant.isPending}
                    onClick={() => void send(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
              <textarea
                className="lw-brief__field"
                aria-label="Message Meri"
                rows={2}
                placeholder="Ask Meri to change the brief… (Enter to send)"
                value={input}
                disabled={assistant.isPending}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onComposerKey}
              />
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                {undo ? (
                  <button
                    type="button"
                    className="lw-backlink"
                    style={{ padding: 0 }}
                    disabled={assistant.isPending}
                    onClick={undoLast}
                  >
                    Undo last edit
                  </button>
                ) : (
                  <span />
                )}
                <LwButton
                  variant="primary"
                  disabled={assistant.isPending || !input.trim()}
                  onClick={() => void send(input)}
                >
                  Send
                </LwButton>
              </div>
            </aside>
          </div>
          {saveError ? (
            <p role="alert" className="lw-card__meta" style={{ margin: 0, ...DANGER }}>
              {saveError}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <div style={{ display: 'grid', gap: 6 }}>
            <span className="lw-eyebrow">Client</span>
            {clients.isLoading ? (
              <p className="lw-card__meta" style={{ margin: 0 }}>
                Loading clients…
              </p>
            ) : clients.isError ? (
              <p role="alert" className="lw-card__meta" style={{ margin: 0 }}>
                Your client list could not be loaded, so a brief cannot be started right now.
              </p>
            ) : (
              <select
                className="lw-brief__field"
                aria-label="Client"
                value={client ? client.id : ''}
                disabled={generate.isPending}
                onChange={(e) => setClientId(e.target.value)}
              >
                <option value="">Select a client…</option>
                {activeClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <span className="lw-eyebrow">Focus (optional)</span>
            <textarea
              className="lw-brief__field"
              aria-label="Focus (optional)"
              rows={3}
              maxLength={600}
              placeholder="e.g. impact on our Medicaid waiver ask"
              value={focus}
              disabled={generate.isPending}
              onChange={(e) => setFocus(e.target.value)}
            />
          </div>
          <p className="lw-card__meta" style={{ margin: 0 }}>
            {hasTranscript
              ? 'A transcript is available, so this will be a recap brief: what was said, the intelligence extracted from it, and what it means for the client.'
              : 'No transcript yet, so this will be a preparation brief from the published notice, agenda and linked bills.'}
          </p>
          {generate.isPending ? (
            <p role="status" className="lw-card__meta" style={{ margin: 0 }}>
              Drafting your brief… Long hearings can take a few minutes.
            </p>
          ) : generate.isError ? (
            <p role="alert" className="lw-card__meta" style={{ margin: 0, ...DANGER }}>
              {generateError(generate.error)}
            </p>
          ) : brief ? (
            <p className="lw-card__meta" style={{ margin: 0 }}>
              A draft already exists; generating again replaces it.{' '}
              <button
                type="button"
                className="lw-backlink"
                style={{ padding: 0 }}
                onClick={() => setPhase('review')}
              >
                Return to the draft →
              </button>
            </p>
          ) : null}
        </>
      )}
    </LwModal>
  );
}
