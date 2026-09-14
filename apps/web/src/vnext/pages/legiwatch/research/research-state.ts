type SavedResearch = { selectionId: string; draftId?: string };
export type ResearchDraftState = {
  analysis: string;
  pending: { hash: string; key: string } | null;
  saved: SavedResearch | null;
};
export function researchDraftKey(identity: string, params: URLSearchParams) {
  return (
    'legiwatch-research-draft:' +
    JSON.stringify([
      identity,
      ...[
        'jurisdiction',
        'session',
        'client',
        'folder',
        'left',
        'leftRevision',
        'right',
        'rightRevision',
        'rightSession',
      ].map((k) => params.get(k)),
    ])
  );
}
export function readResearchDraft(key: string): ResearchDraftState {
  const empty = { analysis: '', pending: null, saved: null };
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value.analysis !== 'string' || value.analysis.length > 30000) return empty;
    return {
      analysis: value.analysis,
      pending:
        value.pending &&
        typeof value.pending.hash === 'string' &&
        typeof value.pending.key === 'string'
          ? value.pending
          : null,
      saved:
        value.saved &&
        typeof value.saved.selectionId === 'string' &&
        (!value.saved.draftId || typeof value.saved.draftId === 'string')
          ? value.saved
          : null,
    };
  } catch {
    return empty;
  }
}
export function writeResearchDraft(key: string, value: ResearchDraftState) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Saving to Workspace remains available without local storage. */
  }
}
export function passageSourceUrl(source: string | null | undefined, locator: string | undefined) {
  try {
    const url = new URL(source ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    const page = /^page:(\d+)$/.exec(locator ?? '');
    if (page && /(?:\/PDF|\.pdf)$/i.test(url.pathname)) url.hash = 'page=' + page[1];
    return url.href;
  } catch {
    return undefined;
  }
}
