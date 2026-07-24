import {
  PeChangeDetectorService,
  materialityBand,
  normalizePeCode,
  peAlertTitle,
  severityForMateriality,
} from '../src/tracker/pe-change-detector.service.js';
import type { SourcePeDelta } from '../src/sourcedata/source-data.repository.js';

/**
 * Program Element alert emitter (Release R4, §4.3).
 *
 * The contract: a PE funding movement reaches a client's feed ONLY because that
 * client's own watchlist names the PE, the alert states the movement without
 * paraphrasing it, and no Policy Portfolio is involved.
 */

function delta(over: Partial<SourcePeDelta> = {}): SourcePeDelta {
  return {
    deltaId: 'd-1',
    peCode: '0603270A',
    peTitle: 'Electronic Warfare Technology',
    assertedFy: 2027,
    deltaType: 'mark_vs_request',
    fromRef: 'request',
    toRef: 'hacDMark',
    amountFrom: '100.00',
    amountTo: '120.00',
    deltaAbs: '20.00',
    deltaPct: 20,
    explanation: 'The Committee recommends an increase of $20,000,000 for EW prototyping.',
    materialityScore: 0.8,
    computedAt: new Date('2026-07-20T00:00:00Z'),
    ...over,
  };
}

describe('pure helpers', () => {
  it('normalizes a PE code on case and surrounding whitespace only', () => {
    expect(normalizePeCode('  0603270a ')).toBe('0603270A');
    // Interior characters are NOT stripped — a PE code is an identifier.
    expect(normalizePeCode('0603270A/X')).toBe('0603270A/X');
  });

  it('maps materiality to severity in the pipeline bands', () => {
    expect(severityForMateriality(0.9)).toBe('critical');
    expect(severityForMateriality(0.7)).toBe('critical');
    expect(severityForMateriality(0.5)).toBe('notable');
    expect(severityForMateriality(0.45)).toBe('notable');
    expect(severityForMateriality(0.44)).toBe('info');
    expect(materialityBand(0.8)).toBe('high');
    expect(materialityBand(0.5)).toBe('medium');
    expect(materialityBand(0.1)).toBe('low');
  });

  it('states the PE, the change type, and the exact movement in the title', () => {
    expect(peAlertTitle(delta())).toBe(
      'FY2027 Committee mark vs request: 0603270A Electronic Warfare Technology ($100M → $120M)',
    );
  });

  it('omits the movement rather than inventing one when an amount is missing', () => {
    const t = peAlertTitle(delta({ amountTo: null }));
    expect(t).not.toContain('→');
    expect(t).toContain('0603270A');
  });

  it('falls back to the raw delta type for an unknown type', () => {
    expect(peAlertTitle(delta({ deltaType: 'some_new_type' }))).toContain('some_new_type');
  });

  it('formats a billion-scale movement in $B', () => {
    expect(peAlertTitle(delta({ amountFrom: '1200.00', amountTo: '1500.00' }))).toContain(
      '($1.2B → $1.5B)',
    );
  });
});

describe('runDetectionCycle', () => {
  /** Fake prisma: `withSystem` serves the watchlist-term scan, `withTenant` the alerts. */
  function makePrisma(
    terms: Array<{ tenantId: string; watchlistId: string; value: string; topicLabel: string | null }>,
    opts: { existingAlert?: boolean } = {},
  ) {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRawUnsafe: async () => terms,
      intelAlert: {
        findFirst: async () => (opts.existingAlert ? { id: 'existing' } : null),
        create: async (a: { data: Record<string, unknown> }) => {
          created.push(a.data);
          return {};
        },
      },
    };
    return {
      created,
      prisma: {
        withSystem: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
        withTenant: async <T>(_t: string, fn: (t: typeof tx) => Promise<T>) => fn(tx),
      },
    };
  }

  function makeSource(deltas: SourcePeDelta[]) {
    return { getRecentPeDeltas: async () => deltas };
  }

  const watcher = {
    tenantId: 't1',
    watchlistId: 'wl:client-1',
    value: '0603270A',
    topicLabel: 'Electronic warfare',
  };

  it('writes one alert per watching client', async () => {
    const { prisma, created } = makePrisma([watcher]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    const r = await svc.runDetectionCycle();
    expect(r).toEqual({ scanned: 1, matchedClients: 1, alertsWritten: 1, skippedDedup: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(
      expect.objectContaining({
        tenantId: 't1',
        clientId: 'client-1',
        sourceType: 'program_element',
        sourceRef: '0603270A',
        kind: 'pe_funding_change',
        changeType: 'mark_vs_request',
        severity: 'critical',
        materiality: 'high',
        status: 'new',
      }),
    );
  });

  it('deep-links the alert to Program Element 360 and keeps the delta provenance', async () => {
    const { prisma, created } = makePrisma([watcher]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    await svc.runDetectionCycle();
    const ev = created[0]!.evidence as {
      programElement: { href: string; peCode: string; deltaMillions: number | null };
      sourceDeltaId: string;
      actionText: string;
    };
    expect(ev.programElement.href).toBe('/program-elements/0603270A');
    expect(ev.programElement.peCode).toBe('0603270A');
    expect(ev.programElement.deltaMillions).toBe(20);
    expect(ev.sourceDeltaId).toBe('d-1');
    // The explanation is quoted verbatim, never a generated summary.
    expect(ev.actionText).toBe(
      'The Committee recommends an increase of $20,000,000 for EW prototyping.',
    );
  });

  it('explains WHY the client is being told, naming their own watchlist topic', async () => {
    const { prisma, created } = makePrisma([watcher]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    await svc.runDetectionCycle();
    expect(created[0]!.whyItMatters).toBe(
      '0603270A is on this client\'s watchlist under "Electronic warfare".',
    );
  });

  it('does NOT alert a client whose watchlist does not name the PE', async () => {
    const { prisma, created } = makePrisma([{ ...watcher, value: '0605888N' }]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    const r = await svc.runDetectionCycle();
    expect(r.matchedClients).toBe(0);
    expect(created).toEqual([]);
  });

  it('matches case-insensitively but never fuzzily (a prefix is not a match)', async () => {
    const lower = makePrisma([{ ...watcher, value: '0603270a' }]);
    const svcLower = new PeChangeDetectorService(
      lower.prisma as never,
      makeSource([delta()]) as never,
    );
    expect((await svcLower.runDetectionCycle()).alertsWritten).toBe(1);

    const prefix = makePrisma([{ ...watcher, value: '060327' }]);
    const svcPrefix = new PeChangeDetectorService(
      prefix.prisma as never,
      makeSource([delta()]) as never,
    );
    expect((await svcPrefix.runDetectionCycle()).alertsWritten).toBe(0);
  });

  it('fans one delta out to every watching client', async () => {
    const { prisma, created } = makePrisma([
      watcher,
      { ...watcher, watchlistId: 'wl:client-2', topicLabel: null },
    ]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    const r = await svc.runDetectionCycle();
    expect(r.matchedClients).toBe(2);
    expect(created.map((c) => c.clientId)).toEqual(['client-1', 'client-2']);
  });

  it('alerts a client ONCE even when two topics name the same PE', async () => {
    const { prisma, created } = makePrisma([
      watcher,
      { ...watcher, topicLabel: 'Another topic' },
    ]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    await svc.runDetectionCycle();
    expect(created).toHaveLength(1);
  });

  it('skips a watchlist id that is not the client convention', async () => {
    const { prisma, created } = makePrisma([{ ...watcher, watchlistId: 'policy:pf-1' }]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    const r = await svc.runDetectionCycle();
    expect(r.matchedClients).toBe(0);
    expect(created).toEqual([]);
  });

  it('is idempotent: an existing alert inside the window is skipped, not duplicated', async () => {
    const { prisma, created } = makePrisma([watcher], { existingAlert: true });
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    const r = await svc.runDetectionCycle();
    expect(r).toEqual(
      expect.objectContaining({ alertsWritten: 0, skippedDedup: 1 }),
    );
    expect(created).toEqual([]);
  });

  it('does nothing when no delta is in the window', async () => {
    const { prisma, created } = makePrisma([watcher]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([]) as never);
    expect(await svc.runDetectionCycle()).toEqual({
      scanned: 0,
      matchedClients: 0,
      alertsWritten: 0,
      skippedDedup: 0,
    });
    expect(created).toEqual([]);
  });

  it('does nothing when no client watches any PE (no watchlist terms at all)', async () => {
    const { prisma, created } = makePrisma([]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    const r = await svc.runDetectionCycle();
    expect(r.scanned).toBe(1);
    expect(r.alertsWritten).toBe(0);
    expect(created).toEqual([]);
  });

  it('records a low-materiality movement as info, not notable', async () => {
    const { prisma, created } = makePrisma([watcher]);
    const svc = new PeChangeDetectorService(
      prisma as never,
      makeSource([delta({ materialityScore: 0.31 })]) as never,
    );
    await svc.runDetectionCycle();
    expect(created[0]!.severity).toBe('info');
    expect(created[0]!.materiality).toBe('low');
  });

  it('recommends opening the line-level PE dossier rather than giving advice', async () => {
    const { prisma, created } = makePrisma([watcher]);
    const svc = new PeChangeDetectorService(prisma as never, makeSource([delta()]) as never);
    await svc.runDetectionCycle();
    expect(created[0]!.recommendedAction).toBe(
      'Review Program Element 0603270A for FY2027.',
    );
  });
});
