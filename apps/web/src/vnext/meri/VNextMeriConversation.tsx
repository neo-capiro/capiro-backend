import { useEffect, useMemo, useRef, useState } from 'react';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { VNextMeriMessage } from './VNextMeriMessage.js';
import { VNextMeriComposer } from './VNextMeriComposer.js';

const PROMPT_LIBRARY = [
  { text: 'What changed across my clients this week?', tag: 'PORTFOLIO · ALL CLIENTS' },
  { text: "Prep me for Thursday's appropriations markup", tag: 'HEARING · APPROPRIATIONS' },
  { text: 'Draft a client update on the highest-priority budget change', tag: 'DRAFT · CLIENT' },
  { text: 'Which FY27 exposures need attention first?', tag: 'ANALYSIS · FY27' },
  { text: 'Which of my asks survived from House mark to enacted last cycle, and why?', tag: 'PATTERN · PRIOR CYCLES' },
  { text: 'Who on committee staff has moved on this program before, and what did they ask for?', tag: 'RELATIONSHIPS · STAFF' },
  { text: 'Where do two sources disagree on a number I am about to send a client?', tag: 'CONFLICT CHECK' },
  { text: 'Watch the most important issue in this week\u2019s hearings and tell me what moves', tag: 'WATCHLIST · LIVE' },
  { text: 'Compare the committee report language against what we actually requested, line by line', tag: 'LANGUAGE DIFF' },
  { text: 'What is the strongest evidence against our own position?', tag: 'RED TEAM' },
  { text: 'Turn the latest meeting debrief into follow-ups with owners and dates', tag: 'MEETING · DEBRIEF' },
  { text: 'Which grants is this client eligible for, and name the criteria met', tag: 'GRANTS · ELIGIBILITY' },
] as const;

function formatTime(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function greetingFor(name: string): string {
  const hour = new Date().getHours();
  const daypart = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${daypart}, ${name}.` : `${daypart}.`;
}

interface VNextMeriConversationProps {
  controller: MeriChatController;
  userLabel: string;
  greetingName: string;
  tenantName: string;
}

export function VNextMeriConversation({
  controller,
  userLabel,
  greetingName,
  tenantName,
}: VNextMeriConversationProps) {
  const [libraryPage, setLibraryPage] = useState(0);
  const { messages, isStreaming, clients, activeConversationId } = controller;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);

  const hasThread = messages.length > 0;
  const selectedClient =
    clients.find((client) => client.id === controller.selectedClientValue) ?? null;

  const promptPages = Math.ceil(PROMPT_LIBRARY.length / 4);
  const prompts = useMemo(
    () => PROMPT_LIBRARY.slice(libraryPage * 4, libraryPage * 4 + 4),
    [libraryPage],
  );

  // Scroll anchoring: stick to the bottom only while the user is at the bottom.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      stickToBottomRef.current = atBottom;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (text: string) => {
    if (!text.trim() || isStreaming) return;
    void controller.sendMessage(text);
  };

  const threadTitle = hasThread
    ? controller.sessionTitle.trim() || 'Untitled thread'
    : 'New thread';
  const threadSub = selectedClient
    ? `SCOPED · ${selectedClient.name.toUpperCase()}`
    : 'PORTFOLIO · ALL CLIENTS';

  return (
    <main className="vnext-meri__main">
      {/* Thread header (only when thread exists) */}
      {hasThread ? (
        <div className="vnext-meri__thread-header">
          <span className="vnext-meri__thread-icon">●</span>
          <div className="vnext-meri__thread-title-block">
            <span className="vnext-meri__thread-title">{threadTitle}</span>
            <span className="vnext-meri__thread-sub">{threadSub}</span>
          </div>
          <span className="vnext-meri__mode-pill">
            <span className="vnext-meri__mode-pill-dot" />
            <span className="vnext-meri__mode-pill-label">STANDARD</span>
          </span>
        </div>
      ) : null}

      {/* Conversation scroll area */}
      <div className="vnext-meri__conversation-scroll" ref={scrollRef} role="log" aria-live="polite">
        <div className="vnext-meri__conversation-column">
          {controller.metaError ? (
            <div className="vnext-meri__error" role="alert">
              {controller.metaError}
            </div>
          ) : null}

          {!hasThread ? (
            /* Landing / new thread */
            <div className="vnext-meri__landing">
              <div className="vnext-meri__landing-greeting-row">
                <span
                  className="vnext-meri__landing-mark"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    fontWeight: 700,
                    fontSize: 24,
                    color: 'var(--meri-accent)',
                  }}
                >
                  Meri
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span className="vnext-meri__landing-greeting">
                    {greetingFor(greetingName)}
                  </span>
                  <span className="vnext-meri__landing-sub">
                    {tenantName.toUpperCase()} · {clients.length} CLIENT{clients.length === 1 ? '' : 'S'} IN SCOPE
                  </span>
                </div>
              </div>

              <VNextMeriComposer controller={controller} variant="landing" hasThread={false} />

              <div className="vnext-meri__prompt-library-head">
                <span className="vnext-meri__section-label">PROMPT LIBRARY</span>
                <span className="vnext-meri__prompt-library-rule" />
                <span className="vnext-meri__prompt-library-page">
                  {libraryPage + 1} / {promptPages}
                </span>
                <div className="vnext-meri__prompt-library-nav">
                  <button
                    type="button"
                    className="vnext-meri__prompt-nav-btn"
                    disabled={libraryPage === 0}
                    onClick={() => setLibraryPage((page) => Math.max(0, page - 1))}
                    aria-label="Previous prompts"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    className="vnext-meri__prompt-nav-btn"
                    disabled={libraryPage >= promptPages - 1}
                    onClick={() => setLibraryPage((page) => Math.min(promptPages - 1, page + 1))}
                    aria-label="More prompts"
                  >
                    →
                  </button>
                </div>
              </div>

              <div className="vnext-meri__prompt-grid">
                {prompts.map((prompt) => (
                  <button
                    type="button"
                    key={prompt.text}
                    className="vnext-meri__prompt-card"
                    onClick={() => submit(prompt.text)}
                  >
                    <span className="vnext-meri__prompt-card-text">{prompt.text}</span>
                    <span className="vnext-meri__prompt-card-tag">{prompt.tag}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Active thread messages */
            <>
              {messages.length > 0 ? (
                <div className="vnext-meri__date-divider">
                  <span className="vnext-meri__date-divider-line" />
                  <span className="vnext-meri__date-divider-label">
                    TODAY · {formatTime(messages[0]?.createdAt)}
                  </span>
                  <span className="vnext-meri__date-divider-line" />
                </div>
              ) : null}

              {messages.map((message, index) => {
                const isLastAssistant =
                  message.role === 'assistant' && index === messages.length - 1;
                return (
                  <VNextMeriMessage
                    key={message.id}
                    message={message}
                    isLastAssistant={isLastAssistant}
                    isStreaming={isStreaming}
                    controller={controller}
                    selectedClientName={selectedClient?.name ?? null}
                    userLabel={userLabel}
                  />
                );
              })}

              {/* Research clarify form */}
              {controller.researchAwaitingAnswers && controller.researchQuestions.length > 0 ? (
                <ResearchClarifyInline controller={controller} />
              ) : null}

              {/* Pending approvals */}
              {controller.pendingApprovals.length > 0 && !isStreaming ? (
                <PendingApprovalsInline controller={controller} />
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* Pinned composer (only when thread exists) */}
      {hasThread ? (
        <div ref={pinnedRef}>
          <VNextMeriComposer controller={controller} variant="pinned" hasThread={true} />
        </div>
      ) : null}
    </main>
  );
}

function ResearchClarifyInline({ controller }: { controller: MeriChatController }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});

  return (
    <div
      style={{
        borderRadius: 'var(--meri-radius)',
        background: 'var(--meri-surface)',
        boxShadow: 'var(--meri-shadow-card)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '15px 18px',
          borderBottom: '1px solid var(--meri-border)',
          background: 'var(--meri-accent-soft)',
        }}
      >
        <span
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 7,
            background: 'var(--meri-accent)',
            color: 'var(--capiro-color-text-inverse-primary)',
            fontSize: 13,
          }}
        >
          ?
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--meri-accent)',
          }}
        >
          A few quick questions before I dig in
        </span>
      </div>
      <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 15 }}>
        {controller.researchQuestions.map((question, i) => (
          <label key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--meri-ink)',
              }}
            >
              {question}
            </span>
            <textarea
              value={answers[i] ?? ''}
              rows={1}
              placeholder="Optional"
              onChange={(event) =>
                setAnswers((prev) => ({ ...prev, [i]: event.target.value }))
              }
              style={{
                width: '100%',
                border: 0,
                outline: 'none',
                borderRadius: 'var(--meri-radius-sm)',
                background: 'var(--meri-surface-2)',
                boxShadow: 'var(--meri-shadow-composer)',
                padding: '10px 12px',
                fontSize: 13,
                lineHeight: '20px',
                color: 'var(--meri-ink)',
                minHeight: 40,
                maxHeight: 110,
                overflowY: 'auto',
                resize: 'none',
              }}
            />
          </label>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
          padding: '0 18px 16px',
        }}
      >
        <button
          type="button"
          className="vnext-meri__new-chat-btn"
          style={{ height: 38, padding: '0 16px' }}
          onClick={() =>
            void controller.submitResearchAnswers(
              answers,
              Object.keys(answers).length === 0,
            )
          }
        >
          Run deep research
        </button>
        <button
          type="button"
          className="vnext-meri__protip-trigger"
          style={{ height: 38, padding: '0 14px' }}
          onClick={() => void controller.submitResearchAnswers({}, true)}
        >
          Skip — use your best judgment
        </button>
      </div>
    </div>
  );
}

function PendingApprovalsInline({ controller }: { controller: MeriChatController }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          display: 'flex',
          gap: 13,
          padding: '15px 17px',
          borderRadius: 11,
          background: 'var(--meri-dark-ink)',
        }}
      >
        <span
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            background: 'var(--meri-accent)',
            color: 'var(--capiro-color-text-inverse-primary)',
            marginTop: 1,
          }}
        >
          🔒
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--capiro-color-text-inverse-primary)',
            }}
          >
            Your approval is required before Meri creates the external draft.
          </span>
          <span
            style={{
              display: 'block',
              marginTop: 6,
              fontFamily: 'var(--meri-font-mono)',
              fontSize: 11,
              lineHeight: 18,
              color: 'var(--capiro-color-text-inverse-muted)',
            }}
          >
            Claims are grounded. Recipients, language, and memory promotion remain under your
            control.
          </span>
        </span>
      </div>
      {controller.pendingApprovals.map((proposal) => (
        <div
          key={proposal.proposalId}
          style={{
            borderRadius: 'var(--meri-radius)',
            background: 'var(--meri-surface)',
            boxShadow: 'var(--meri-shadow-card)',
            padding: '16px 18px',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--meri-font-mono)',
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '0.1em',
              color: 'var(--meri-text-muted)',
            }}
          >
            PENDING APPROVAL · {proposal.preview.label.toUpperCase()}
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: 14,
              lineHeight: 21,
              color: 'var(--meri-text-secondary)',
            }}
          >
            {proposal.reason}
          </div>
          <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
            <button
              type="button"
              className="vnext-meri__rail-action-btn"
              style={{ marginTop: 0 }}
              disabled={controller.approvingProposalId === proposal.proposalId}
              onClick={() => void controller.handleApprovePending(proposal.proposalId)}
            >
              {controller.approvingProposalId === proposal.proposalId
                ? 'Approving…'
                : 'Approve'}
            </button>
            <button
              type="button"
              className="vnext-meri__protip-trigger"
              style={{ height: 34, padding: '0 13px' }}
              onClick={() => void controller.handleDismissPending(proposal.proposalId)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
      {controller.pendingApprovals.length > 1 ? (
        <button
          type="button"
          className="vnext-meri__rail-action-btn"
          onClick={() => void controller.handleApproveAll()}
        >
          Approve all
        </button>
      ) : null}
    </div>
  );
}
