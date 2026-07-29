import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../kit.js';
import type { WsComment } from '../types.js';
import type { WsAssistantEdit, WsAssistantResult } from '../api.js';
import { CommentsRail, type ComposingComment } from './CommentsRail.js';
import type { CommentAnchor } from './anchors.js';
import { ContextInspector } from '../../../components/trust/ContextInspector.js';
import {
  MeriEditReview,
  type EditApplyOutcome,
} from './MeriEditReview.js';
import type { WorkspaceSectionState } from './edit-review.js';

interface QuickAction {
  label: string;
  prompt: string;
  allTools?: string[];
  anyTools?: string[];
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: 'Tighten the ask',
    prompt:
      'Tighten the ask across this document. Make the request specific, quantified, and action-oriented. Propose section edits and do not change the document until I approve them.',
  },
  {
    label: 'Expand acronyms',
    prompt:
      'Find undefined acronyms throughout the document and expand each on first use. Propose section edits.',
  },
  {
    label: 'Strengthen the nexus',
    prompt:
      'Strengthen the evidence-backed connection between the client and the relevant policy, program, or district. Retrieve client context before proposing edits.',
    allTools: ['search_client_knowledge'],
  },
  {
    label: 'Verify legislative status',
    prompt:
      'Verify every legislative status in this document against the authoritative bill-status tools. Identify stale or unsupported statements and propose corrected edits.',
    anyTools: ['search_congress_bills', 'search_state_bills'],
  },
  {
    label: 'Validate dollar figures',
    prompt:
      'Validate every dollar figure and fiscal year in this document against retrieved sources. Distinguish request, authorization, appropriations marks, conference, and enacted amounts. Propose corrections only where supported.',
    anyTools: ['get_pe_budget_timeline', 'query_economic_data'],
  },
  {
    label: 'Authorization vs appropriation',
    prompt:
      'Check the document for authorization-versus-appropriation conflation and propose precise corrections with the relevant stage named.',
    allTools: ['get_pe_budget_timeline'],
  },
  {
    label: 'Check committee jurisdiction',
    prompt:
      'Check whether every named committee or subcommittee has jurisdiction over the described issue. Identify uncertainty and propose corrections.',
    anyTools: ['search_committee_hearings', 'search_congress_bills'],
  },
  {
    label: 'Refresh current roles',
    prompt:
      'Refresh time-sensitive member, staff, office, and acquisition-personnel roles used in this document. Propose edits for stale titles and state the as-of date.',
    anyTools: ['search_acquisition_personnel', 'get_acquisition_person'],
  },
  {
    label: 'Compare with client Compass',
    prompt:
      'Compare this document against the approved client context and identify framing, objective, red-line, or terminology conflicts. Propose edits without changing canonical client context.',
    anyTools: ['get_client_context', 'search_client_knowledge'],
  },
  {
    label: 'Find unsupported claims',
    prompt:
      'Audit this document for unsupported factual claims. Separate established facts, inference, recommendations, and uncertainty. Propose edits that remove or clearly qualify unsupported claims.',
  },
  {
    label: 'Add state or district impact',
    prompt:
      'Assess whether state legislative or district impact is relevant. Retrieve state/client evidence before proposing a bounded impact section or edits.',
    anyTools: ['search_state_bills', 'get_state_bill_status', 'query_economic_data'],
  },
  {
    label: 'Check deadlines and time zones',
    prompt:
      'Validate every deadline, date, and time zone in this document. Identify relative dates or ambiguous cutoffs and propose exact replacements.',
    anyTools: ['query_regulatory_dockets', 'search_congress_bills', 'search_state_bills'],
  },
  {
    label: 'Check compliance language',
    prompt:
      'Review this document for compliance-sensitive promises, gifts, contingent-fee language, campaign-finance implications, procurement-integrity concerns, or unsupported legal conclusions. Flag uncertainty and propose conservative wording; do not provide a definitive legal conclusion.',
  },
];

interface ChatItem {
  role: 'user' | 'meri';
  text: string;
  result?: WsAssistantResult;
  failed?: boolean;
}

function actionAvailable(action: QuickAction, tools: Set<string>): boolean {
  if (action.allTools && !action.allTools.every((tool) => tools.has(tool))) return false;
  if (action.anyTools && !action.anyTools.some((tool) => tools.has(tool))) return false;
  return true;
}

export function MeriPanel({
  isMainDoc,
  contextItems,
  openComments,
  activeTab,
  onTabChange,
  documentId,
  comments,
  composing,
  selfClerkId,
  selfName,
  onComposeSave,
  onComposeCancel,
  onApplyEdit,
  onRunMeri,
  onApplyEdits,
  onRetrySave,
  onUndoLastMeri,
  documentState,
  availableTools,
  onEditContext,
  pendingPrompt,
  onPromptConsumed,
}: {
  isMainDoc: boolean;
  contextItems: string[];
  openComments: number;
  activeTab: 'meri' | 'comments';
  onTabChange: (tab: 'meri' | 'comments') => void;
  documentId: string | null;
  comments: WsComment[];
  composing: ComposingComment | null;
  selfClerkId: string | null;
  selfName: string;
  onComposeSave: (text: string) => void;
  onComposeCancel: () => void;
  onApplyEdit: (anchor: CommentAnchor, after: string) => void;
  onRunMeri: (
    messages: Array<{ role: 'user' | 'assistant'; text: string }>,
    signal?: AbortSignal,
  ) => Promise<WsAssistantResult>;
  onApplyEdits: (edits: WsAssistantEdit[]) => Promise<EditApplyOutcome>;
  onRetrySave?: () => Promise<EditApplyOutcome>;
  onUndoLastMeri?: () => Promise<EditApplyOutcome>;
  documentState: WorkspaceSectionState;
  availableTools?: string[];
  onEditContext: () => void;
  pendingPrompt?: string | null;
  onPromptConsumed?: () => void;
}) {
  const [input, setInput] = useState('');
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [retryText, setRetryText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const toolSet = useMemo(() => new Set(availableTools ?? []), [availableTools]);
  const quickActions = useMemo(
    () => QUICK_ACTIONS.filter((action) => actionAvailable(action, toolSet)),
    [toolSet],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [items, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async (text: string) => {
    const value = text.trim();
    if (!value || busy) return;
    setInput('');
    setRetryText(null);
    const nextItems: ChatItem[] = [...items, { role: 'user', text: value }];
    setItems(nextItems);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const history = nextItems.map((item) => ({
        role: (item.role === 'meri' ? 'assistant' : 'user') as 'user' | 'assistant',
        text: item.text,
      }));
      const result = await onRunMeri(history, controller.signal);
      if (controller.signal.aborted) return;
      setItems((previous) => [
        ...previous,
        {
          role: 'meri',
          text: result.reply || 'Done.',
          result,
        },
      ]);
    } catch (error) {
      if (controller.signal.aborted) {
        setItems((previous) => [
          ...previous,
          { role: 'meri', text: 'Stopped. No proposed edits were applied.' },
        ]);
      } else {
        setRetryText(value);
        setItems((previous) => [
          ...previous,
          {
            role: 'meri',
            text: error instanceof Error ? error.message : 'The assistant turn failed.',
            failed: true,
          },
        ]);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!pendingPrompt || busy) return;
    void send(pendingPrompt);
    onPromptConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt, busy]);

  const Tab = ({ kind, label, badge }: { kind: 'meri' | 'comments'; label: string; badge?: number }) => {
    const selected = activeTab === kind;
    return (
      <button
        type="button"
        onClick={() => onTabChange(kind)}
        aria-selected={selected}
        role="tab"
        style={{
          flex: 1,
          padding: '10px 8px',
          border: 'none',
          background: 'transparent',
          borderBottom: selected ? '2px solid var(--accent)' : '2px solid transparent',
          color: selected ? 'var(--ink-1)' : 'var(--ink-3)',
          fontWeight: 600,
        }}
      >
        {label}
        {badge != null ? ` · ${badge}` : ''}
      </button>
    );
  };

  return (
    <aside
      style={{
        borderLeft: '1px solid var(--border-1)',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
      }}
      aria-label="Meri document assistant"
    >
      <div role="tablist" style={{ display: 'flex', borderBottom: '1px solid var(--border-1)' }}>
        <Tab kind="meri" label="Meri" />
        <Tab kind="comments" label="Comments" badge={openComments} />
      </div>

      {activeTab === 'comments' ? (
        documentId ? (
          <CommentsRail
            documentId={documentId}
            comments={comments}
            composing={composing}
            selfClerkId={selfClerkId}
            selfName={selfName}
            onComposeSave={onComposeSave}
            onComposeCancel={onComposeCancel}
            onApplyEdit={onApplyEdit}
          />
        ) : (
          <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--ink-3)' }}>
            Comments attach to a saved document. Add content first.
          </div>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <header
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--border-1)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 26,
                height: 26,
                borderRadius: '50%',
                background: 'var(--accent)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Icon name="Sparkles" size={15} />
            </span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Meri</div>
              <div style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                Document session · session-only chat · {contextItems.length} linked context item
                {contextItems.length === 1 ? '' : 's'}
              </div>
            </div>
          </header>

          <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 14, minHeight: 0 }}>
            {items.length === 0 && (
              <div className="card" style={{ padding: '10px 12px', boxShadow: 'none', fontSize: 12 }}>
                <b style={{ color: 'var(--accent)' }}>Meri:</b> I review this document with you. I
                propose changes for you to inspect; nothing is applied or reported saved until the
                durable save succeeds.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
              {items.map((item, index) =>
                item.role === 'user' ? (
                  <div key={index} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div
                      style={{
                        maxWidth: '88%',
                        background: 'var(--accent)',
                        color: '#fff',
                        padding: '8px 11px',
                        borderRadius: '10px 10px 2px 10px',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {item.text}
                    </div>
                  </div>
                ) : (
                  <article key={index}>
                    <div style={{ fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                      <b style={{ color: 'var(--accent)' }}>Meri:</b> {item.text}
                    </div>
                    {item.result?.steps?.length ? (
                      <details style={{ marginTop: 6 }}>
                        <summary>Sources and checks · {item.result.steps.length}</summary>
                        <ul>
                          {item.result.steps.map((step, stepIndex) => (
                            <li key={stepIndex}>
                              {step.status === 'error' ? 'Issue' : 'Completed'} · {step.label}
                              {step.detail ? ` — ${step.detail}` : ''}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {item.result?.contextPacket && (
                      <ContextInspector
                        packet={item.result.contextPacket}
                        onReviewContext={onEditContext}
                      />
                    )}
                    {item.result?.edits?.length ? (
                      <MeriEditReview
                        edits={item.result.edits}
                        document={documentState}
                        confidence={item.result.confidence}
                        structuralWarnings={item.result.structuralWarnings}
                        citations={item.result.citations}
                        onApply={onApplyEdits}
                        onRetrySave={onRetrySave}
                        onUndo={onUndoLastMeri}
                        onDismiss={() =>
                          setItems((previous) =>
                            previous.map((entry, itemIndex) =>
                              itemIndex === index && entry.result
                                ? { ...entry, result: { ...entry.result, edits: [] } }
                                : entry,
                            ),
                          )
                        }
                      />
                    ) : null}
                  </article>
                ),
              )}
              {busy && (
                <div role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                  Meri is reviewing sources and the document…
                </div>
              )}
            </div>
          </div>

          <footer style={{ padding: 12, borderTop: '1px solid var(--border-1)' }}>
            {isMainDoc && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {quickActions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() => void send(action.prompt)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            <label style={{ display: 'grid', gap: 5 }}>
              <span className="sr-only">Ask Meri to review this document</span>
              <textarea
                value={input}
                onChange={(event) => setInput(event.currentTarget.value.slice(0, 12_000))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send(input);
                  }
                }}
                disabled={busy}
                rows={3}
                maxLength={12_000}
                placeholder="Ask Meri to review or propose edits…"
                style={{ width: '100%', resize: 'vertical', minHeight: 72 }}
              />
              <span style={{ fontSize: 10.5, color: 'var(--ink-3)', display: 'flex', justifyContent: 'space-between' }}>
                <span>Enter sends · Shift+Enter adds a line</span>
                <span>{input.length}/12,000</span>
              </span>
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {busy ? (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => abortRef.current?.abort()}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn sm btn-accent"
                  disabled={!input.trim()}
                  onClick={() => void send(input)}
                >
                  Send
                </button>
              )}
              {retryText && !busy && (
                <button type="button" className="btn sm" onClick={() => void send(retryText)}>
                  Retry failed turn
                </button>
              )}
              <button type="button" className="btn sm btn-ghost" onClick={onEditContext}>
                Review context ({contextItems.length})
              </button>
            </div>
          </footer>
        </div>
      )}
    </aside>
  );
}
