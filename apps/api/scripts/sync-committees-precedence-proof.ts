/**
 * Disposable-DB proof for the generic congress_gov > community url
 * precedence rule in sync-committees.ts. Not a jest unit test — this drives
 * the REAL main() against a real Postgres instance with a MOCKED community
 * feed (stale jslc00/jspr00 urls) and a mocked congress.gov cross-check, to
 * prove end-to-end that:
 *
 *   1. a congress_gov-verified url survives a subsequent stale-community sync
 *   2. a community-only committee (never congress_gov-verified) still gets
 *      its url from the community feed, unchanged behavior
 *   3. zero-hearing / obscure committees remain in the directory (isCurrent)
 *
 * Run: DATABASE_URL=<disposable-pg> ./node_modules/.bin/tsx scripts/sync-committees-precedence-proof.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STALE_JSLC00_URL = 'https://cha.house.gov/jointcommittees/joint-committee-library';
const AUTHORITATIVE_JSLC00_URL = 'https://cha.house.gov/joint-committee-on-library';
const STALE_JSPR00_URL = 'https://cha.house.gov/jointcommittees/joint-committee-on-printing';
const AUTHORITATIVE_JSPR00_URL = 'https://cha.house.gov/joint-committee-on-printing';

/** Unique 4-uppercase-letter thomas_id from an index (base-26), matching the
 * real shape membershipKeyToSystemCode requires (^[A-Z]{4}(\d{2})?$). */
function paddingThomasId(i: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let n = i;
  let out = '';
  for (let k = 0; k < 4; k++) {
    out = letters[n % 26] + out;
    n = Math.floor(n / 26);
  }
  return out;
}

async function main() {
  console.log('=== SETUP: seed pre-existing congress_gov-verified rows ===');
  await prisma.congressCommittee.upsert({
    where: { systemCode: 'jslc00' },
    create: {
      systemCode: 'jslc00',
      thomasId: 'JSLC',
      name: 'Joint Committee of Congress on the Library',
      chamber: 'joint',
      url: AUTHORITATIVE_JSLC00_URL,
      urlSource: 'congress_gov',
      urlVerifiedAt: new Date(),
      isCurrent: true,
    },
    update: {
      url: AUTHORITATIVE_JSLC00_URL,
      urlSource: 'congress_gov',
      urlVerifiedAt: new Date(),
      isCurrent: true,
    },
  });
  await prisma.congressCommittee.upsert({
    where: { systemCode: 'jspr00' },
    create: {
      systemCode: 'jspr00',
      thomasId: 'JSPR',
      name: 'Joint Committee on Printing',
      chamber: 'joint',
      url: AUTHORITATIVE_JSPR00_URL,
      urlSource: 'congress_gov',
      urlVerifiedAt: new Date(),
      isCurrent: true,
    },
    update: {
      url: AUTHORITATIVE_JSPR00_URL,
      urlSource: 'congress_gov',
      urlVerifiedAt: new Date(),
      isCurrent: true,
    },
  });
  // A committee that has NEVER been congress_gov-verified — proves community
  // data still flows through for the normal (non-regressed) case.
  await prisma.congressCommittee.upsert({
    where: { systemCode: 'hsag00' },
    create: {
      systemCode: 'hsag00',
      thomasId: 'HSAG',
      name: 'Committee on Agriculture',
      chamber: 'house',
      url: 'https://agriculture.house.gov/old-path',
      urlSource: 'community',
      isCurrent: true,
    },
    update: {},
  });
  // A zero-hearing / obscure committee that must remain in the directory
  // (isCurrent) purely because it's present in the community feed, even
  // though it will never be touched by the congress_gov cross-check cap.
  await prisma.congressCommittee.upsert({
    where: { systemCode: 'jocp00' },
    create: {
      systemCode: 'jocp00',
      thomasId: 'JOCP',
      name: 'Congressional Oversight Panel',
      chamber: 'joint',
      url: null,
      isCurrent: true,
    },
    update: {},
  });

  const before = await prisma.congressCommittee.findMany({
    where: { systemCode: { in: ['jslc00', 'jspr00', 'hsag00', 'jocp00'] } },
    select: { systemCode: true, url: true, urlSource: true, isCurrent: true },
    orderBy: { systemCode: 'asc' },
  });
  console.log('BEFORE:', JSON.stringify(before, null, 2));

  console.log('=== RUN: mocked sync-committees.ts main() logic ===');
  // Mock fetch: community feed returns STALE urls for jslc00/jspr00 (the
  // exact regression condition) + the unrelated fixture rows, unchanged.
  const originalFetch = global.fetch;
  (global as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('committees-current.json')) {
      const body = [
        {
          type: 'joint',
          name: 'Joint Committee of Congress on the Library',
          url: STALE_JSLC00_URL,
          thomas_id: 'JSLC',
        },
        {
          type: 'joint',
          name: 'Joint Committee on Printing',
          url: STALE_JSPR00_URL,
          thomas_id: 'JSPR',
        },
        {
          type: 'house',
          name: 'Committee on Agriculture',
          url: 'https://agriculture.house.gov/new-community-path',
          thomas_id: 'HSAG',
        },
        {
          type: 'joint',
          name: 'Congressional Oversight Panel',
          url: null,
          thomas_id: 'JOCP',
        },
        // Pad to satisfy the >=100 magnitude guard, with valid 4-letter ids.
        ...Array.from({ length: 120 }, (_, i) => ({
          type: 'house',
          name: `Padding Committee ${i}`,
          url: null,
          thomas_id: paddingThomasId(i),
        })),
      ];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (u.includes('committee-membership-current.json')) {
      // Satisfy the >=500 membership magnitude guard with padding rows keyed
      // to the SAME padding thomas_ids the committees feed just registered.
      const membership: Record<string, unknown[]> = {};
      for (let i = 0; i < 520; i++) {
        const key = paddingThomasId(i % 120);
        membership[key] = membership[key] ?? [];
        (membership[key] as unknown[]).push({
          bioguide: `B${i.toString().padStart(6, '0')}`,
          party: 'majority',
          rank: 1,
          title: null,
        });
      }
      return new Response(JSON.stringify(membership), { status: 200 });
    }
    // congress.gov cross-check calls: return 404 for ALL of them this run,
    // simulating "cross-check unavailable this cycle" — the scenario that
    // must NOT be able to revert an already-verified row.
    if (u.includes('api.congress.gov')) {
      return new Response('not found', { status: 404 });
    }
    throw new Error(`unexpected fetch in proof harness: ${u}`);
  }) as typeof fetch;

  try {
    delete (require.cache as Record<string, unknown>)[require.resolve('./sync-committees')];
    process.env.COMMITTEES_URL = 'https://unitedstates.github.io/congress-legislators/committees-current.json';
    process.env.COMMITTEE_MEMBERSHIP_URL =
      'https://unitedstates.github.io/congress-legislators/committee-membership-current.json';
    process.env.CONGRESS_API_KEY = 'fake-key-for-proof';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./sync-committees') as { main: () => Promise<void> };
    await mod.main();
  } finally {
    (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  const after = await prisma.congressCommittee.findMany({
    where: { systemCode: { in: ['jslc00', 'jspr00', 'hsag00', 'jocp00'] } },
    select: { systemCode: true, url: true, urlSource: true, isCurrent: true },
    orderBy: { systemCode: 'asc' },
  });
  console.log('AFTER:', JSON.stringify(after, null, 2));

  const jslc00 = after.find((r) => r.systemCode === 'jslc00');
  const jspr00 = after.find((r) => r.systemCode === 'jspr00');
  const hsag00 = after.find((r) => r.systemCode === 'hsag00');
  const jocp00 = after.find((r) => r.systemCode === 'jocp00');

  const proofs = {
    jslc00_survived_authoritative_url: jslc00?.url === AUTHORITATIVE_JSLC00_URL,
    jslc00_still_congress_gov_sourced: jslc00?.urlSource === 'congress_gov',
    jspr00_survived_authoritative_url: jspr00?.url === AUTHORITATIVE_JSPR00_URL,
    jspr00_still_congress_gov_sourced: jspr00?.urlSource === 'congress_gov',
    hsag00_took_new_community_url: hsag00?.url === 'https://agriculture.house.gov/new-community-path',
    hsag00_stayed_community_sourced: hsag00?.urlSource === 'community',
    jocp00_remains_in_directory: jocp00?.isCurrent === true,
  };
  console.log('PROOF_RESULT:', JSON.stringify(proofs, null, 2));
  const allPass = Object.values(proofs).every(Boolean);
  console.log(allPass ? 'ALL_PROOFS_PASSED' : 'PROOF_FAILED');
  if (!allPass) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
