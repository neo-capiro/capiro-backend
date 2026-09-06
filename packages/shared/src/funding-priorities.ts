/** Concrete projects/outcomes a client wants to fund, stored in intakeData. */
export const MAX_FUNDING_PRIORITIES = 20;
export const MAX_FUNDING_PRIORITY_LENGTH = 120;

/**
 * Defensive reader for existing JSON. Writers validate the bounds before saving;
 * old or malformed intake data must never break matching or create unbounded work.
 */
export function normalizeFundingPriorities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const priorities: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const phrase = entry.trim().replace(/\s+/g, ' ');
    if (!phrase || phrase.length > MAX_FUNDING_PRIORITY_LENGTH) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    priorities.push(phrase);
    if (priorities.length === MAX_FUNDING_PRIORITIES) break;
  }
  return priorities;
}

/** Read only the explicit priority list; legacy fundingAsk is a different field. */
export function fundingPrioritiesFromIntake(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return normalizeFundingPriorities((value as Record<string, unknown>).fundingPriorities);
}
