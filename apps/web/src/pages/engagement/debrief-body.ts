/**
 * Plain-text debrief body parsing — UI-free, extracted verbatim from
 * `meeting-actions.tsx` so the shared Meetings drawer (DebriefTab, rendered on
 * BOTH app.capiro.ai and the vNext os.capiro.ai surface) can consume it
 * without transitively importing that file's AntD components. meeting-actions
 * re-exports these names, so its existing importers are unchanged.
 */

export interface DebriefDraftState {
  recap: string;
  actionItems: string[];
  notes: string;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionText(body: string, start: string, end?: string): string {
  const startPattern = new RegExp(`(?:^|\\n)${escapeRegExp(start)}\\s*\\n`, 'i');
  const startMatch = body.match(startPattern);
  if (!startMatch || startMatch.index === undefined) return '';
  const contentStart = startMatch.index + startMatch[0].length;
  const rest = body.slice(contentStart);
  if (!end) return rest.trim();
  const endPattern = new RegExp(`\\n${escapeRegExp(end)}\\s*\\n`, 'i');
  const endMatch = rest.match(endPattern);
  return (endMatch?.index === undefined ? rest : rest.slice(0, endMatch.index)).trim();
}

/** Parse the plain-text debrief body into its Recap / Action Items / Notes sections. */
export function parseDebriefBody(body: string): DebriefDraftState {
  const fallback = { recap: body.trim(), actionItems: [], notes: '' };
  if (!body.trim()) return { recap: '', actionItems: [], notes: '' };
  const recap = sectionText(body, 'Recap', 'Action Items');
  const actionItems = sectionText(body, 'Action Items', 'Notes');
  const notes = sectionText(body, 'Notes');
  if (!recap && !actionItems && !notes) return fallback;
  return {
    recap: recap || fallback.recap,
    actionItems: splitLines(actionItems.replace(/^- /gm, '')),
    notes,
  };
}
