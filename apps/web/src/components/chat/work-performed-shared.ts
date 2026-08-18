/**
 * work-performed-shared — UI-free contract behind the "Work performed"
 * execution-evidence cards on BOTH chat surfaces.
 *
 * `TrustStep` is the shape useMeriChatController accumulates from the SSE
 * tool_call/trace stream; `INTENT_LABELS` maps the router's intent codes to
 * the human plan label. The legacy card (WorkPerformed.tsx, antd icons +
 * ContextInspector.css) and the vNext hero card (vnext/meri/
 * MeriWorkPerformed.tsx) must agree on both — this module is the single copy,
 * held UI-free (no react, no antd, no CSS) so the vNext surface can import it
 * without pulling the antd card into the os.capiro.ai runtime module graph.
 * WorkPerformed re-exports both so legacy consumers are unchanged.
 */

export interface TrustStep {
  tool: string;
  label: string;
  detail?: string;
  count?: number;
  confidence?: 'high' | 'medium' | 'low';
  status: 'running' | 'done' | 'error';
}

export const INTENT_LABELS: Record<string, string> = {
  query_intelligence: 'Researching government-affairs intelligence',
  query_clients: 'Reviewing client records',
  query_engagement: 'Reviewing meetings and outreach',
  query_workflow: 'Checking workflows',
  generate_draft: 'Drafting',
  generate_briefing: 'Building a briefing',
  navigate: 'Navigating',
  general_question: 'Working on your question',
};
