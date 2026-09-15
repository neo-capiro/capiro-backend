import { messageMeriTurnScope } from '../../components/chat/meri-turn-scope.js';
import type { ChatMessage } from '../../components/chat/chat-store.js';
import type { MeriCitation } from '../../components/chat/chat-store.js';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import type { TrustStep } from '../../components/chat/work-performed-shared.js';
import type { MeriEvidenceClaim, MeriEvidenceSource, MeriEvidenceStat } from './MeriEvidenceTray.js';
import type { MeriThinkingTabProps } from './MeriThinkingTab.js';
import type { MeriEvidenceTabProps } from './MeriEvidenceTab.js';
import type { MeriTurnInspectorData } from './MeriTurnInspector.js';

/**
 * The slice of MeriChatController the default inspector reads. The streaming
 * latest turn still owns the controller's transient plan/trust/intent/tier
 * (those update live before the `finally` block persists them onto the
 * message record); every completed/historical turn reads its own saved
 * message fields instead. This mirrors the exact rule VNextMeriMessage
 * applies per message, lifted here so the rail can show the latest turn's
 * inspector by default without waiting for a "Show work" click.
 */
export interface MeriDefaultInspectorSource {
  messages: ChatMessage[];
  isStreaming: boolean;
  planSteps: string[];
  trustSteps: TrustStep[];
  orchestratorIntent: string | null;
  orchestratorTier: 'fast' | 'deep' | null;
  pendingApprovals: PendingApproval[];
}

/**
 * The turn the transient controller work state belongs to: the LAST message,
 * only while it is an in-flight assistant turn. The streaming assistant row
 * is appended optimistically before streaming starts, so it is the last array
 * element for the whole stream. If the last message is a user turn (a fresh
 * question whose assistant row has not streamed yet) the transient state has
 * no assistant owner yet — we must NOT pin it onto the previous completed
 * assistant turn.
 */
function streamingAssistantMessage(controller: MeriDefaultInspectorSource): ChatMessage | null {
  if (!controller.isStreaming) return null;
  const last = controller.messages[controller.messages.length - 1];
  return last && last.role === 'assistant' ? last : null;
}

/** The latest assistant turn, if any — the default the inspector shows. */
export function latestAssistantMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant') return message;
  }
  return null;
}

function mapEvidence(
  message: ChatMessage | null,
  onOpenSource?: (citations: MeriCitation[], index: number, message: ChatMessage) => void,
): MeriEvidenceTabProps {
  const citations = message?.citations ?? [];
  const sources: MeriEvidenceSource[] = citations.map((citation) => ({
    citationNumber: citation.n,
    icon: 'File05',
    provider: citation.tool.replace(/_/g, ' ').toUpperCase(),
    date: 'RETRIEVED THIS TURN',
    title: citation.title,
    snippet: citation.snippet ?? 'No excerpt was returned for this source.',
    locator: citation.type.toUpperCase(),
  }));
  const claims: MeriEvidenceClaim[] = (message?.verification?.claims ?? []).map((claim) => ({
    state: claim.supported ? 'verified' : 'unsupported',
    claim: claim.claim,
  }));
  const verifyStats: MeriEvidenceStat[] = message?.verification?.totalCount
    ? [
        { label: `CLAIMS CHECKED · ${message.verification.totalCount}`, tone: 'n' },
        {
          label: `UNSUPPORTED · ${message.verification.unsupportedCount}`,
          tone: message.verification.unsupportedCount ? 'w' : 'g',
        },
      ]
    : [];
  return {
    sources,
    verifyStats,
    claims,
    groundingCaveat: message?.groundingCaveat ?? null,
    retrieval: message?.retrieval ?? null,
    onOpenSource:
      onOpenSource && message ? (_source, index) => onOpenSource(citations, index, message) : undefined,
  };
}

/**
 * Build the default turn-inspector view model for the current conversation.
 *
 * Always returns an inspector (never null): the reference default rail is the
 * Thinking/Evidence/Approvals panel, which exists even for an empty/new
 * thread — the tabs render their honest empty states, and the Approvals tab
 * still surfaces conversation-level pending approvals (which are not
 * turn-scoped and may exist before any assistant turn).
 *
 * Turn data shown:
 *  - A streaming latest assistant turn reads the controller's transient state.
 *  - A completed/historical latest assistant turn reads its own saved fields.
 *  - When the last message is a user turn awaiting its assistant, the inspector
 *    still shows the latest completed assistant turn's saved data (never the
 *    new turn's in-flight state, which has no assistant owner yet).
 *  - A brand-new thread with no assistant turn shows honest empty Thinking /
 *    Evidence and the conversation's approvals.
 *
 * `onOpenSource` is threaded to the Evidence tab so a default source opens the
 * existing source-detail UI with this turn's captured scope and citation index.
 */
export function buildDefaultTurnInspector(
  controller: MeriDefaultInspectorSource,
  onOpenSource?: (citations: MeriCitation[], index: number, message: ChatMessage) => void,
): MeriTurnInspectorData {
  const streaming = streamingAssistantMessage(controller);
  const completed = latestAssistantMessage(controller.messages);
  // Prefer the streaming turn while one is in flight; otherwise the latest
  // completed assistant turn. Either may be absent on a brand-new thread.
  const message = streaming ?? completed;

  const thinking: MeriThinkingTabProps = streaming
    ? {
        plan: controller.planSteps.join(' '),
        steps: controller.trustSteps,
        intent: controller.orchestratorIntent,
        tier: controller.orchestratorTier,
        ...(streaming.runtimeStatus ? { runtimeStatus: streaming.runtimeStatus } : {}),
      }
    : {
        plan: (message?.planSteps ?? []).join(' '),
        steps: message?.trustSteps ?? [],
        intent: message?.orchestratorIntent ?? null,
        tier: message?.orchestratorTier ?? null,
        ...(message?.runtimeStatus ? { runtimeStatus: message.runtimeStatus } : {}),
      };

  return {
    // No assistant turn yet: a stable, conversation-scoped id that matches no
    // message id, so the rehydration lookup finds nothing and the panel simply
    // shows empty states rather than a stale turn.
    turnId: message?.id ?? 'conversation-default',
    turnScope: message ? messageMeriTurnScope(message) : undefined,
    contextPacketId: message?.contextPacketId,
    thinking,
    evidence: mapEvidence(message, onOpenSource),
    // Approvals are conversation-level (PendingApproval carries no turn id).
    approvals: controller.pendingApprovals,
  };
}
