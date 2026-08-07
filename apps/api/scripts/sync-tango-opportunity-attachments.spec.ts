import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverAttachmentLinks,
  parseArgs,
  runAttachmentSync,
  type AttachmentSyncDeps,
} from './sync-tango-opportunity-attachments.js';
import type {
  ArchiveOutcome,
  AttachmentCandidate,
} from '../src/funding-opportunities/opportunity-attachment.service.js';

/**
 * Attachment discovery and the archive run (P29).
 *
 * The guards themselves live in `opportunity-attachment.spec.ts`. This file is
 * about the two things only the RUN can get wrong: reading SAM.gov's own stored
 * payload honestly, and never re-attempting a refusal.
 */

const BODY = new TextEncoder().encode('%PDF-1.7 synthetic');

function makeDeps(
  over: {
    opportunities?: Array<{ id: string; raw: unknown }>;
    fetchable?: AttachmentCandidate[];
    outcome?: ArchiveOutcome;
  } = {},
) {
  const upserted: unknown[] = [];
  const recorded: Array<{ id: string; outcome: ArchiveOutcome }> = [];
  const fetchableQueries: number[] = [];
  const deps: AttachmentSyncDeps = {
    readOpportunities: async () =>
      over.opportunities ?? [{ id: 'sam-1', raw: { resourceLinks: ['https://sam.gov/a.pdf'] } }],
    upsertMetadata: async (links) => {
      upserted.push(...links);
      return [];
    },
    readFetchable: async (limit) => {
      fetchableQueries.push(limit);
      return (
        over.fetchable ?? [
          {
            id: 'att-1',
            sourceUrl: 'https://sam.gov/a.pdf',
            fileName: 'a.pdf',
            declaredMimeType: 'application/pdf',
            declaredSizeBytes: 100,
          },
        ]
      );
    },
    recordOutcome: async (id, outcome) => {
      recorded.push({ id, outcome });
    },
    transport: {
      fetch: async () => ({
        finalUrl: 'https://sam.gov/a.pdf',
        status: 200,
        contentType: 'application/pdf',
        body: BODY,
        declaredLength: BODY.byteLength,
        uncompressedBytes: null,
        redirects: [],
      }),
    },
    archive: {
      exists: async () => false,
      put: async () => ({ versionId: 'v1' }),
    },
    bucket: 'bucket',
    prefix: 'opportunity-attachments',
  };
  return { deps, upserted, recorded, fetchableQueries };
}

// ── Discovery ────────────────────────────────────────────────────────────────

describe('attachment links come from SAM.gov’s own stored payload', () => {
  test('a string array yields one candidate per URL', () => {
    const result = discoverAttachmentLinks([
      { id: 'sam-1', raw: { resourceLinks: ['https://sam.gov/a.pdf', 'https://sam.gov/b.pdf'] } },
    ]);
    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toMatchObject({ samOpportunityId: 'sam-1', sourceUrl: 'https://sam.gov/a.pdf' });
  });

  test('an object entry is read ONLY through a real `url` key, never guessed at', () => {
    // A heuristic scan for "the field that looks like a URL" is a guess that
    // reads like a fact.
    const result = discoverAttachmentLinks([
      {
        id: 'sam-1',
        raw: {
          resourceLinks: [
            { url: 'https://sam.gov/a.pdf', name: 'Statement of Work.pdf', mimeType: 'application/pdf', size: 900 },
            { href: 'https://sam.gov/guessed.pdf' },
          ],
        },
      },
    ]);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({
      fileName: 'Statement of Work.pdf',
      declaredMimeType: 'application/pdf',
      declaredSizeBytes: 900,
    });
    expect(result.malformed).toBe(1);
  });

  test('a MISSING resourceLinks key is `noLinksField`, NOT "no attachments"', () => {
    // SAM.gov omits the key for records ingested before it existed. A zero that
    // meant "none" would tell a reader a 300-page package was not there.
    const result = discoverAttachmentLinks([{ id: 'sam-1', raw: { noticeId: 'x' } }]);
    expect(result.noLinksField).toBe(1);
    expect(result.emptyLinks).toBe(0);
    expect(result.links).toHaveLength(0);
  });

  test('an EMPTY resourceLinks array is a real "none", counted separately', () => {
    const result = discoverAttachmentLinks([{ id: 'sam-1', raw: { resourceLinks: [] } }]);
    expect(result.emptyLinks).toBe(1);
    expect(result.noLinksField).toBe(0);
  });

  test('a non-array resourceLinks is malformed, not silently skipped', () => {
    expect(discoverAttachmentLinks([{ id: 'sam-1', raw: { resourceLinks: 'nope' } }]).malformed).toBe(1);
  });

  test('the same URL on the same notice is not counted twice', () => {
    const result = discoverAttachmentLinks([
      { id: 'sam-1', raw: { resourceLinks: ['https://sam.gov/a.pdf', 'https://sam.gov/a.pdf'] } },
    ]);
    expect(result.links).toHaveLength(1);
  });

  test('the same URL on DIFFERENT notices is two candidates', () => {
    // One Q&A document attached to two notices is two attachment records that
    // happen to archive to one object — deduplication belongs at the archive
    // key, not here.
    const result = discoverAttachmentLinks([
      { id: 'sam-1', raw: { resourceLinks: ['https://sam.gov/a.pdf'] } },
      { id: 'sam-2', raw: { resourceLinks: ['https://sam.gov/a.pdf'] } },
    ]);
    expect(result.links).toHaveLength(2);
  });

  test('a filename is NEVER derived from the URL', () => {
    // SAM.gov download URLs end in an opaque id; deriving one would present a
    // uuid as the document's name.
    const result = discoverAttachmentLinks([
      { id: 'sam-1', raw: { resourceLinks: ['https://sam.gov/api/files/9f2a-bb31/download'] } },
    ]);
    expect(result.links[0]!.fileName).toBeNull();
  });

  test('a null or non-object raw is counted, never crashed on', () => {
    const result = discoverAttachmentLinks([
      { id: 'a', raw: null },
      { id: 'b', raw: 'string' },
      { id: 'c', raw: [] },
    ]);
    expect(result.noLinksField).toBe(3);
  });
});

// ── The run ──────────────────────────────────────────────────────────────────

describe('the run is dry by default and separates discovery from archiving', () => {
  test('no flags means a default cap, no commit, and not discover-only', () => {
    // A DEFAULT cap, unlike every other sync in this program: those walk
    // metadata, this one moves bytes.
    expect(parseArgs([])).toEqual({ commit: false, discoverOnly: false, limit: 50 });
  });

  test('a dry run reports what it WOULD do and writes nothing', async () => {
    const { deps, upserted, recorded } = makeDeps();
    const summary = await runAttachmentSync(deps, { commit: false, discoverOnly: false, limit: 10 });
    expect(summary.linksDiscovered).toBe(1);
    expect(upserted).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  test('--discover-only writes metadata and fetches NOTHING', async () => {
    const { deps, upserted, recorded, fetchableQueries } = makeDeps();
    await runAttachmentSync(deps, { commit: true, discoverOnly: true, limit: 10 });
    expect(upserted).toHaveLength(1);
    expect(fetchableQueries).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  test('a committed run archives and records the outcome', async () => {
    const { deps, recorded } = makeDeps();
    const summary = await runAttachmentSync(deps, { commit: true, discoverOnly: false, limit: 10 });
    expect(summary).toMatchObject({ attempted: 1, archived: 1, refused: 0, failed: 0 });
    expect(summary.bytes).toBe(BODY.byteLength);
    expect(recorded[0]!.outcome.status).toBe('archived');
  });

  test('a refusal is counted as refused, not as failed', async () => {
    const { deps, recorded } = makeDeps({
      fetchable: [
        {
          id: 'att-bad',
          sourceUrl: 'https://169.254.169.254/latest/meta-data/',
          fileName: null,
          declaredMimeType: null,
          declaredSizeBytes: null,
        },
      ],
    });
    const summary = await runAttachmentSync(deps, { commit: true, discoverOnly: false, limit: 10 });
    expect(summary).toMatchObject({ refused: 1, failed: 0, archived: 0 });
    expect(recorded[0]!.outcome).toMatchObject({
      status: 'refused',
      failureReason: 'private_network_host',
    });
  });

  test('the discovery counters survive into the summary', async () => {
    const { deps } = makeDeps({
      opportunities: [
        { id: 'a', raw: { resourceLinks: ['https://sam.gov/a.pdf'] } },
        { id: 'b', raw: {} },
        { id: 'c', raw: { resourceLinks: [] } },
        { id: 'd', raw: { resourceLinks: [{ href: 'x' }] } },
      ],
    });
    const summary = await runAttachmentSync(deps, { commit: false, discoverOnly: false, limit: 10 });
    expect(summary).toMatchObject({
      opportunitiesScanned: 4,
      linksDiscovered: 1,
      noLinksField: 1,
      emptyLinks: 1,
      malformedLinks: 1,
    });
  });
});

// ── Structural ───────────────────────────────────────────────────────────────

describe('a refusal is never re-attempted, and a failure is', () => {
  const source = readFileSync(join(__dirname, 'sync-tango-opportunity-attachments.ts'), 'utf8');

  test('the fetchable predicate admits metadata_only and failed, and NOT refused', () => {
    // Retrying an SSRF attempt on a schedule is the attack working, slowly.
    expect(source).toMatch(/status: \{ in: \['metadata_only', 'failed'\] \}/);
    expect(source).not.toMatch(/in: \[[^\]]*'refused'/);
  });

  test('an existing row keeps its status — discovery never resets a refusal', () => {
    expect(source).toMatch(/if \(existing\) continue;/);
  });

  test('a failure CLEARS the archive location, so a stale key cannot look citable', () => {
    expect(source).toMatch(/archiveBucket: null,[\s\S]{0,120}archiveKey: null/);
  });

  test('redirects are followed MANUALLY, so every hop reaches the guard', () => {
    // `fetch`'s own follow mode would chase a 302 to the metadata service
    // before any Capiro code saw the target.
    expect(source).toMatch(/redirect: 'manual'/);
    expect(source).toMatch(/checkHop\(target\)/);
  });

  test('the archive write is private and encrypted', () => {
    expect(source).toMatch(/ServerSideEncryption: 'AES256'/);
    expect(source).toMatch(/ACL: 'private'/);
  });

  test('an archiving run refuses to start with no bucket configured', () => {
    // Fetching megabytes with nowhere to put them is worse than not starting.
    expect(source).toMatch(/refusing to fetch with nowhere to archive/);
  });

  test('it records why the provider is not the source of attachment links', () => {
    // The installed SDK's only attachment-shaped method is a semantic SEARCH,
    // which cannot enumerate one solicitation's documents.
    expect(source).toMatch(/searchOpportunityAttachments/);
    expect(source).toMatch(/NO attachment ENUMERATION/);
  });
});
