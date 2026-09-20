export interface MondayBoardQueryScope {
  explicit: boolean;
  invalid: boolean;
  boardIds: string[];
}

const VALID_BOARD_ID = /^\d{1,24}$/;
const MONDAY_BOARD_URL = /https:\/\/[a-z0-9-]+\.monday\.com\/(?:boards?|workspaces\/\d+\/boards?)\/(\d+)(?:\b|\/)/gi;
const LABELLED_BOARD_ID = /\b(?:monday(?:\.com)?\s+)?board(?:\s+id)?\s*(?:is|[:#=-])?\s*(\d+)\b/gi;

/**
 * Extract an exact request-local monday board scope without treating unrelated
 * numbers in a natural-language query as connector authorization.
 */
export function mondayBoardScopeFromQuery(value: string | null | undefined): MondayBoardQueryScope {
  const query = value?.trim() ?? '';
  if (!query) return { explicit: false, invalid: false, boardIds: [] };

  const candidates: string[] = [];
  for (const match of query.matchAll(MONDAY_BOARD_URL)) candidates.push(match[1]!);
  for (const match of query.matchAll(LABELLED_BOARD_ID)) candidates.push(match[1]!);
  if (/^\d+$/.test(query)) candidates.push(query);
  if (!candidates.length) return { explicit: false, invalid: false, boardIds: [] };

  const invalid = candidates.some((id) => !VALID_BOARD_ID.test(id));
  const boardIds = [...new Set(candidates.filter((id) => VALID_BOARD_ID.test(id)))];
  return { explicit: true, invalid, boardIds };
}
