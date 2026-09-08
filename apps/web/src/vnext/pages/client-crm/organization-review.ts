import type { ClientPerson } from '../../adapters/legacy/useClientOrganizationModel.js';

/** A matching title is a review signal, never proof that either contact is wrong. */
export function leadershipTitleConflicts(people: ClientPerson[]): Set<string> {
  const titles = new Map<string, ClientPerson[]>();
  for (const person of people) {
    const title = person.title?.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!title || /\b(former|previous|retired|emeritus)\b/.test(title)) continue;
    if (!/\b(president|ceo|cfo|coo|cto|chief executive officer|chief financial officer|chief operating officer|chief technology officer)\b/.test(title)) continue;
    // A department may have several VPs. Preserve scoped president/CEO titles.
    if (/\b(vice president|vp|svp|evp)\b/.test(title)) continue;
    titles.set(title, [...(titles.get(title) ?? []), person]);
  }
  return new Set([...titles.values()].filter((group) => new Set(group.map((person) => person.id)).size > 1)
    .flatMap((group) => group.map((person) => person.id)));
}

export function contactAddedLabel(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? 'Record date unavailable' : `Contact added ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}
