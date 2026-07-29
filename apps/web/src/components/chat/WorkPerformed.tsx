import {
  CheckCircleFilled,
  DownOutlined,
  LoadingOutlined,
  RightOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../lib/use-api.js';
import { ContextInspector, type TrustContextPacket } from '../trust/ContextInspector.js';
import { useChatStore } from './chat-store.js';

export interface TrustStep {
  tool: string;
  label: string;
  detail?: string;
  count?: number;
  confidence?: 'high' | 'medium' | 'low';
  status: 'running' | 'done' | 'error';
}

export interface WorkPerformedProps {
  intent?: string | null;
  tier?: 'fast' | 'deep' | null;
  steps: TrustStep[];
  planSteps?: string[];
  isStreaming: boolean;
  assumptions?: string[];
  warnings?: string[];
  contextPacketId?: string | null;
  asOf?: string | null;
}

const INTENT_LABELS: Record<string, string> = {
  query_intelligence: 'Researching government-affairs intelligence',
  query_clients: 'Reviewing client records',
  query_engagement: 'Reviewing meetings and outreach',
  query_workflow: 'Checking workflows',
  generate_draft: 'Drafting',
  generate_briefing: 'Building a briefing',
  navigate: 'Navigating',
  general_question: 'Working on your question',
};

function confidenceDot(confidence?: 'high' | 'medium' | 'low'): string {
  if (confidence === 'high') return 'chat-tp-dot--high';
  if (confidence === 'low') return 'chat-tp-dot--low';
  return 'chat-tp-dot--medium';
}

function formattedAsOf(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Bounded execution evidence. It exposes plans, tool outcomes, source counts,
 * checks, assumptions, errors, and the exact persisted context packet. Raw
 * model reasoning is not accepted as a prop and cannot render.
 */
export function WorkPerformed({
  intent,
  tier,
  steps,
  planSteps,
  isStreaming,
  assumptions = [],
  warnings = [],
  contextPacketId,
  asOf,
}: WorkPerformedProps) {
  const api = useApi();
  // Held in a ref so the fetch below is keyed on what actually invalidates the
  // packet (the answer) and not on the client's object identity. `useApi()` is
  // memoized, but it is legitimately rebuilt on an org switch or impersonation
  // change — and re-running the effect for that would blank out provenance the
  // user is currently reading.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const { activeConversationId } = useChatStore();
  const [expanded, setExpanded] = useState(false);
  const [packet, setPacket] = useState<TrustContextPacket | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPacket(null);
    if (!activeConversationId || isStreaming) {
      return () => {
        cancelled = true;
      };
    }
    void apiRef.current
      .get<TrustContextPacket>(
        `/api/clio/context-packets/conversation/${encodeURIComponent(activeConversationId)}/latest`,
      )
      .then((response) => {
        if (!cancelled) setPacket(response.data);
      })
      .catch(() => {
        if (!cancelled) {
          setPacket({
            surface: 'ga-chat',
            items: [],
            exclusions: [],
            unauthorizedCount: 0,
            degraded: true,
            degradedReason: 'Context provenance could not be loaded for this answer.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId, isStreaming]);

  const hasWorkLog =
    isStreaming || steps.length > 0 || assumptions.length > 0 || warnings.length > 0;
  if (!hasWorkLog && !packet) return null;

  const toolCount = steps.length;
  const sourceCount = steps.reduce(
    (sum, step) => sum + (typeof step.count === 'number' ? step.count : 0),
    0,
  );
  const planLabel = (intent && INTENT_LABELS[intent]) || 'Working';
  const runningStep = steps.find((step) => step.status === 'running');
  const errorCount = steps.filter((step) => step.status === 'error').length;
  const asOfLabel = formattedAsOf(asOf ?? packet?.compiledAt);

  const headerText = isStreaming
    ? runningStep?.label || `${planLabel}…`
    : toolCount === 0
      ? 'Sources and context'
      : [
          `Work performed · ${toolCount} tool${toolCount === 1 ? '' : 's'}`,
          sourceCount ? `${sourceCount} source${sourceCount === 1 ? '' : 's'}` : null,
          errorCount ? `${errorCount} issue${errorCount === 1 ? '' : 's'}` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <div className={`chat-tp${isStreaming ? ' chat-tp--live' : ''}`}>
      <button
        type="button"
        className="chat-tp-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="chat-tp-header-icon" aria-hidden="true">
          {isStreaming ? <LoadingOutlined spin /> : <ThunderboltOutlined />}
        </span>
        <span className="chat-tp-header-text">{headerText}</span>
        {tier === 'deep' && <span className="chat-tp-tier">deep</span>}
        <span className="chat-tp-chevron" aria-hidden="true">
          {expanded ? <DownOutlined /> : <RightOutlined />}
        </span>
      </button>

      {expanded && (
        <div className="chat-tp-body">
          {planSteps && planSteps.length > 0 ? (
            <section className="chat-tp-plan" aria-label="Plan">
              <span className="chat-tp-plan-label">Plan</span>
              <ol className="chat-tp-plan-steps">
                {planSteps.map((step, index) => <li key={index}>{step}</li>)}
              </ol>
            </section>
          ) : intent ? (
            <section className="chat-tp-plan" aria-label="Plan">
              <span className="chat-tp-plan-label">Plan</span>
              <span>{planLabel}</span>
            </section>
          ) : null}

          {steps.length > 0 && (
            <ol className="chat-tp-steps" aria-label="Sources and checks">
              {steps.map((step, index) => (
                <li
                  key={`${step.tool}-${index}`}
                  className={`chat-tp-step chat-tp-step--${step.status}`}
                >
                  <span className="chat-tp-step-icon" aria-hidden="true">
                    {step.status === 'running' ? (
                      <LoadingOutlined spin />
                    ) : step.status === 'error' ? (
                      <WarningOutlined />
                    ) : (
                      <CheckCircleFilled />
                    )}
                  </span>
                  <span className="chat-tp-step-main">
                    <span className="chat-tp-step-label">{step.label}</span>
                    {step.detail && <span className="chat-tp-step-detail">{step.detail}</span>}
                  </span>
                  {step.confidence && step.status === 'done' && (
                    <span
                      className={`chat-tp-dot ${confidenceDot(step.confidence)}`}
                      title={`Source confidence: ${step.confidence}`}
                      aria-label={`Source confidence ${step.confidence}`}
                    />
                  )}
                </li>
              ))}
              {isStreaming && steps.every((step) => step.status !== 'running') && (
                <li className="chat-tp-step chat-tp-step--running">
                  <span className="chat-tp-step-icon" aria-hidden="true">
                    <LoadingOutlined spin />
                  </span>
                  <span className="chat-tp-step-main">
                    <span className="chat-tp-step-label">Composing answer…</span>
                  </span>
                </li>
              )}
            </ol>
          )}

          {assumptions.length > 0 && (
            <section className="chat-tp-plan" aria-label="Assumptions">
              <span className="chat-tp-plan-label">Assumptions stated in the answer</span>
              <ul>{assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </section>
          )}
          {warnings.length > 0 && (
            <section className="chat-tp-plan" aria-label="Execution warnings">
              <span className="chat-tp-plan-label">Warnings</span>
              <ul>{warnings.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </section>
          )}

          {/* Always offered once the answer has settled. A missing packet renders
              as an explicit "details unavailable" state rather than silently
              dropping the affordance, so absent provenance is never mistaken for
              "no context was used". */}
          {!isStreaming && <ContextInspector packet={packet} />}

          {(asOfLabel || contextPacketId || packet?.packetId) && (
            <div className="chat-tp-footnote">
              {asOfLabel && <span>As of {asOfLabel}</span>}
              {asOfLabel && (contextPacketId || packet?.packetId) && <span> · </span>}
              {(contextPacketId || packet?.packetId) && (
                <span title={contextPacketId || packet?.packetId || undefined}>
                  Context packet {(contextPacketId || packet?.packetId || '').slice(0, 8)}
                </span>
              )}
            </div>
          )}
          <p className="chat-tp-footnote">
            This log shows tools, sources, context, and checks—not private model reasoning. Verify specifics before high-stakes use.
          </p>
        </div>
      )}
    </div>
  );
}
