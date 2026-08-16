export interface GoldenPersonSeedFixture {
  id: string;
  canonicalName: string;
  aliases: readonly string[];
  identifiers: readonly { type: string; value: string }[];
}

/**
 * Shared seed shape for the two golden Jane Smith cases. Both people expose the
 * same exact alias so a name-only lookup is ambiguous, while only the intended
 * Example Defense person owns the exact email used by person_exact_email.
 */
export const JANE_SMITH_GOLDEN_FIXTURES: readonly GoldenPersonSeedFixture[] = [
  {
    id: '51a8f604-f8ec-4e89-8ee7-86b37c1b0c01',
    canonicalName: 'Jane Smith — Example Defense',
    aliases: ['Jane Smith'],
    identifiers: [
      { type: 'email', value: 'jane.smith@example.com' },
    ],
  },
  {
    id: '51a8f604-f8ec-4e89-8ee7-86b37c1b0c02',
    canonicalName: 'Jane Smith — Other Defense',
    aliases: ['Jane Smith'],
    identifiers: [],
  },
] as const;
