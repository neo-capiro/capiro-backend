const FORBIDDEN_PUBLIC_KEY_FRAGMENTS = [
  'tenant',
  'client',
  'customer',
  'watchlist',
  'workspace',
  'clerkuser',
  'userid',
  'useremail',
  'subscriptionid',
  'autorecordrule',
  'matterid',
  'issueids',
  'memoryid',
  'confidential',
  'ethicalwall',
] as const;

export class PublicHearingBoundaryError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'PublicHearingBoundaryError';
  }
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function forbiddenFragment(key: string): string | undefined {
  const normalized = normalizedKey(key);
  return FORBIDDEN_PUBLIC_KEY_FRAGMENTS.find((fragment) => normalized.includes(fragment));
}

function inspect(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`, seen));
    return;
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const fragment = forbiddenFragment(key);
    const nextPath = path ? `${path}.${key}` : key;
    if (fragment) {
      throw new PublicHearingBoundaryError(
        `Public hearing payload contains tenant/private field "${key}"`,
        nextPath,
      );
    }
    inspect(item, nextPath, seen);
  }
}

/**
 * Enforces the global-public side of the Live Hearings data boundary.
 *
 * Global transcript/insight records may contain only facts derived from a public
 * proceeding. Tenant subscriptions, client matches, watchlists, private matter
 * identifiers, user identity, and confidential memory belong in the separate
 * tenant relevance rail.
 */
export function assertPublicHearingBoundary(value: unknown): void {
  inspect(value, '$', new WeakSet<object>());
}

export function isPublicHearingBoundarySafe(value: unknown): boolean {
  try {
    assertPublicHearingBoundary(value);
    return true;
  } catch {
    return false;
  }
}
