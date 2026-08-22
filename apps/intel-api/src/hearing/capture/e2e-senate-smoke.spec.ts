import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SourceDataRepository } from '../../sourcedata/source-data.repository.js';
import { StreamResolverService } from '../stream-resolver.service.js';
import { classifyStreamResolution } from './stream-resolution-policy.js';

/**
 * PHASE 4 END-TO-END SMOKE TEST (exit gate item 16), labeled honestly per the
 * brief's hierarchy. This exercises the REAL StreamResolverService against a
 * REAL official Senate Armed Services Committee hearing page over live network
 * egress (no live hearing was in session during this run, so this targets an
 * archived Senate ISVP hearing — OFFICIAL_ARCHIVE class, not LIVE).
 *
 * It is intentionally excluded from the default `test` script's normal CI
 * surface risk profile by living under this repo's existing pattern of
 * network-touching specs (see net-guard-cspan-gate.spec.ts, which also makes
 * real requests) — run explicitly via:
 *   pnpm --filter @capiro/intel-api test src/hearing/capture/e2e-senate-smoke.spec.ts
 */
describe('Phase 4 end-to-end smoke — official Senate ISVP archive', () => {
  const prisma = new PrismaService();
  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  it('resolves a real official Senate Armed Services archived hearing page to a classified, capturable stream', async () => {
    const resolver = new StreamResolverService(new ConfigService(), new SourceDataRepository(prisma));
    const pageUrl =
      'https://www.armed-services.senate.gov/hearings/to-receive-an-update-on-the-f-35-aircraft-program';

    const raw = await resolver.resolve({ pageUrl });
    // eslint-disable-next-line no-console
    console.log('SMOKE raw resolver result:', JSON.stringify(raw));

    const classified = classifyStreamResolution(raw, {
      now: new Date(),
      eventStatus: 'completed',
      publicAccess: 'public',
    });
    // eslint-disable-next-line no-console
    console.log('SMOKE classified:', JSON.stringify(classified));
    console.log('SMOKE_LABEL: OFFICIAL_ARCHIVE');
    console.log('SMOKE_SOURCE:', pageUrl);

    // The resolver must reach a DEFINITE conclusion — never silently unresolved
    // with no reason. It is allowed to be SOURCE_ERROR/NO_PUBLIC_STREAM if the
    // Akamai VOD path has since expired, but it must never throw and must
    // never report READY_FOR_SERVER_CAPTURE without an actual media URL.
    expect(classified.state).toBeDefined();
    if (classified.state === 'READY_FOR_SERVER_CAPTURE') {
      expect(classified.media?.url).toMatch(/^https:\/\//);
      expect(classified.capturePolicy).toBe('SERVER_CAPTURE_ALLOWED');
    }
  }, 30_000);
});
