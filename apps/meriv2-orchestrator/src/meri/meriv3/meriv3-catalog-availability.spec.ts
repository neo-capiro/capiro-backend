import {
  alreadyDisclosesCatalogAvailability,
  catalogAvailabilityObserverOf,
  createMeriCatalogAvailabilityObserver,
  deriveCatalogAvailabilityRelevance,
  managedCatalogOutcomeFor,
  meriCatalogAppName,
  meriCatalogAvailabilityInstruction,
  meriCatalogAvailabilityReleaseNote,
  nativeRecordsUnavailable,
  parseManagedCatalogAvailability,
  relevantUnavailableManagedApps,
  type MeriCatalogAvailabilityControl,
  type MeriCatalogAvailabilitySnapshot,
} from './meriv3-catalog-availability.js';

describe('meriv3-catalog-availability (Lane A / A1 bounded helper)', () => {
  describe('parseManagedCatalogAvailability', () => {
    test('accepts a valid partial envelope and derives fixed app names', () => {
      const availability = parseManagedCatalogAvailability({
        state: 'partial',
        complete: false,
        registryUnavailable: false,
        failures: [{ appId: 'hubspot', reason: 'needs_reauth', name: 'EVIL RAW NAME' }],
      });
      expect(availability).toEqual({
        state: 'partial',
        complete: false,
        registryUnavailable: false,
        failures: [{ appId: 'hubspot', name: 'HubSpot', reason: 'needs_reauth' }],
      });
    });

    test('accepts ok with an empty failures array', () => {
      expect(
        parseManagedCatalogAvailability({
          state: 'ok',
          complete: true,
          registryUnavailable: false,
          failures: [],
        }),
      ).toEqual({ state: 'ok', complete: true, registryUnavailable: false, failures: [] });
    });

    test('rejects an unknown availability state', () => {
      expect(
        parseManagedCatalogAvailability({
          state: 'healthy',
          complete: true,
          registryUnavailable: false,
        }),
      ).toBeNull();
    });

    test('rejects a non-boolean complete/registryUnavailable', () => {
      expect(
        parseManagedCatalogAvailability({ state: 'ok', complete: 'yes', registryUnavailable: false }),
      ).toBeNull();
      expect(
        parseManagedCatalogAvailability({ state: 'ok', complete: true, registryUnavailable: 1 }),
      ).toBeNull();
    });

    test('rejects a non-allowlisted appId or reason (never trusts raw metadata)', () => {
      expect(
        parseManagedCatalogAvailability({
          state: 'partial',
          complete: false,
          registryUnavailable: false,
          failures: [{ appId: 'salesforce', reason: 'unavailable' }],
        }),
      ).toBeNull();
      expect(
        parseManagedCatalogAvailability({
          state: 'partial',
          complete: false,
          registryUnavailable: false,
          failures: [{ appId: 'hubspot', reason: 'exploded' }],
        }),
      ).toBeNull();
    });

    test('rejects a missing envelope (legacy) as null, not a claim of ok', () => {
      expect(parseManagedCatalogAvailability(undefined)).toBeNull();
      expect(parseManagedCatalogAvailability({ schemas: [] })).toBeNull();
    });

    test('a missing (rolling-release) availability envelope is UNKNOWN, never ok', () => {
      // The API predating the additive envelope sends no `availability` at all;
      // absence is UNKNOWN completeness, distinct from a present-but-malformed one.
      expect(parseManagedCatalogAvailability(undefined)).toBeNull();
      expect(parseManagedCatalogAvailability(null)).toBeNull();
    });

    test('a present-but-malformed availability envelope is invalid and never ok/no_eligible', () => {
      // Missing required `failures` array.
      expect(
        parseManagedCatalogAvailability({
          state: 'ok',
          complete: true,
          registryUnavailable: false,
        }),
      ).toBeNull();
      // ok with complete=false is contradictory.
      expect(
        parseManagedCatalogAvailability({
          state: 'ok',
          complete: false,
          registryUnavailable: false,
          failures: [],
        }),
      ).toBeNull();
      // unavailable with complete=true is contradictory.
      expect(
        parseManagedCatalogAvailability({
          state: 'unavailable',
          complete: true,
          registryUnavailable: false,
          failures: [{ appId: 'hubspot', reason: 'unavailable' }],
        }),
      ).toBeNull();
      // ok carrying a failure is contradictory.
      expect(
        parseManagedCatalogAvailability({
          state: 'ok',
          complete: true,
          registryUnavailable: false,
          failures: [{ appId: 'hubspot', reason: 'unavailable' }],
        }),
      ).toBeNull();
      // partial with no failure is contradictory.
      expect(
        parseManagedCatalogAvailability({
          state: 'partial',
          complete: false,
          registryUnavailable: false,
          failures: [],
        }),
      ).toBeNull();
      // no_eligible with a registry outage is contradictory.
      expect(
        parseManagedCatalogAvailability({
          state: 'no_eligible',
          complete: true,
          registryUnavailable: true,
          failures: [],
        }),
      ).toBeNull();
    });

    test('a valid empty (ok + no schema) and a partial envelope are accepted distinctly', () => {
      expect(
        parseManagedCatalogAvailability({
          state: 'ok',
          complete: true,
          registryUnavailable: false,
          failures: [],
        }),
      ).toEqual({ state: 'ok', complete: true, registryUnavailable: false, failures: [] });
      expect(
        parseManagedCatalogAvailability({
          state: 'no_eligible',
          complete: true,
          registryUnavailable: false,
          failures: [],
        }),
      ).toEqual({ state: 'no_eligible', complete: true, registryUnavailable: false, failures: [] });
    });

    test('dedupes duplicate app failures to one bounded entry', () => {
      expect(
        parseManagedCatalogAvailability({
          state: 'partial',
          complete: false,
          registryUnavailable: false,
          failures: [
            { appId: 'hubspot', reason: 'registry_unavailable' },
            { appId: 'hubspot', reason: 'needs_reauth' },
          ],
        })?.failures,
      ).toEqual([{ appId: 'hubspot', name: 'HubSpot', reason: 'needs_reauth' }]);
    });

    test('maps a valid envelope + schema count to a bounded source outcome', () => {
      const ok = parseManagedCatalogAvailability({
        state: 'ok',
        complete: true,
        registryUnavailable: false,
        failures: [],
      });
      const noEligible = parseManagedCatalogAvailability({
        state: 'no_eligible',
        complete: true,
        registryUnavailable: false,
        failures: [],
      });
      const partial = parseManagedCatalogAvailability({
        state: 'partial',
        complete: false,
        registryUnavailable: false,
        failures: [{ appId: 'hubspot', reason: 'needs_reauth' }],
      });
      const unavailable = parseManagedCatalogAvailability({
        state: 'unavailable',
        complete: false,
        registryUnavailable: true,
        failures: [],
      });
      expect(ok && managedCatalogOutcomeFor(ok, 1)).toBe('usable');
      expect(ok && managedCatalogOutcomeFor(ok, 0)).toBe('empty');
      expect(noEligible && managedCatalogOutcomeFor(noEligible, 0)).toBe('empty');
      expect(partial && managedCatalogOutcomeFor(partial, 1)).toBe('usable');
      expect(unavailable && managedCatalogOutcomeFor(unavailable, 0)).toBe('unavailable');
    });
  });

  describe('observer', () => {
    test('rejects anything that is not a managed availability envelope', () => {
      expect(
        parseManagedCatalogAvailability({
          state: 'ok',
          complete: true,
          registryUnavailable: false,
          failures: 'none',
        }),
      ).toBeNull();
    });

    test('records and snapshots bounded per-source status', () => {
      const observer = createMeriCatalogAvailabilityObserver();
      observer.noteNative({ outcome: 'empty', count: 0 });
      observer.noteManaged({ outcome: 'auth_denied' });
      observer.noteAnalysis({ outcome: 'disabled' });
      observer.noteManagedAvailability({
        state: 'unavailable',
        complete: false,
        registryUnavailable: true,
        failures: [{ appId: 'krisp', name: 'Krisp', reason: 'registry_unavailable' }],
      });
      expect(observer.snapshot()).toEqual({
        native: { outcome: 'empty', count: 0 },
        managed: { outcome: 'auth_denied' },
        analysis: { outcome: 'disabled' },
        managedAvailability: {
          state: 'unavailable',
          complete: false,
          registryUnavailable: true,
          failures: [{ appId: 'krisp', name: 'Krisp', reason: 'registry_unavailable' }],
        },
      });
    });

    test('carries the observer on the SAME control object', () => {
      const observer = createMeriCatalogAvailabilityObserver();
      const control: MeriCatalogAvailabilityControl = { catalogAvailability: observer };
      expect(catalogAvailabilityObserverOf(control)).toBe(observer);
      expect(catalogAvailabilityObserverOf({})).toBeUndefined();
      expect(catalogAvailabilityObserverOf(undefined)).toBeUndefined();
    });

    test('records and snapshots current native canonical-read failures separately', () => {
      const observer = createMeriCatalogAvailabilityObserver();
      observer.noteNative({ outcome: 'usable', count: 3 });
      observer.noteNativeReadFailure('read_client_documents', 'failed');
      // A later, broader reason must not downgrade an already-recorded failure.
      observer.noteNativeReadFailure('read_client_documents', 'unavailable');
      observer.noteNativeReadFailure('', 'failed');
      expect(observer.snapshot()).toEqual({
        native: { outcome: 'usable', count: 3 },
        managed: undefined,
        analysis: undefined,
        managedAvailability: null,
        nativeDispatchFailures: [{ capability: 'read_client_documents', reason: 'failed' }],
      });
    });
  });

  describe('relevance (narrow)', () => {
    test('detects only explicitly named apps', () => {
      expect(deriveCatalogAvailabilityRelevance('Find Jane in HubSpot')).toEqual({
        requestedApps: ['hubspot'],
        nativeRequested: false,
      });
      expect(deriveCatalogAvailabilityRelevance('Compare Airtable and monday.com rows').requestedApps)
        .toEqual(['airtable', 'monday']);
      expect(deriveCatalogAvailabilityRelevance('What is the weather?').requestedApps).toEqual([]);
    });

    test('flags native record requests only on explicit phrasing', () => {
      expect(deriveCatalogAvailabilityRelevance('Look up our Capiro client records').nativeRequested)
        .toBe(true);
      expect(deriveCatalogAvailabilityRelevance('Say hello').nativeRequested).toBe(false);
    });

    test('a proper name or weekday alone is not a record request', () => {
      // A proper name (Capiro) or a date (Monday) alone must not mark the turn as
      // needing private records.
      expect(deriveCatalogAvailabilityRelevance('Write a poem about Capiro')).toEqual({
        requestedApps: [],
        nativeRequested: false,
      });
      expect(deriveCatalogAvailabilityRelevance('Help me prepare for Monday')).toEqual({
        requestedApps: [],
        nativeRequested: false,
      });
      // A real record request is still recognized.
      expect(deriveCatalogAvailabilityRelevance('Summarize our client records').nativeRequested).toBe(
        true,
      );
    });

    test('an ordinary client question is relevant through the real plan/intent/attempt signals', () => {
      // No literal "client records" phrasing, but the ACTUAL evidence plan
      // requires a client-record read this turn.
      expect(
        deriveCatalogAvailabilityRelevance('Why did the account activity change?', {
          planRequiresClientRecords: true,
        }).nativeRequested,
      ).toBe(true);
      // The real client-scoped retrieval intent (a record query, not a lookup).
      expect(
        deriveCatalogAvailabilityRelevance('What changed with our client this week?', {
          intentRequiresClientRecords: true,
        }).nativeRequested,
      ).toBe(true);
      // An actual attempted canonical client-record read.
      expect(
        deriveCatalogAvailabilityRelevance('Summarize the latest profile', {
          attemptedReads: ['get_client_context'],
        }).nativeRequested,
      ).toBe(true);
    });

    test('an authenticated clientId alone is never a record signal', () => {
      // The helper takes NO clientId; an unrelated/empty signal set stays
      // negative even for a creative question.
      expect(
        deriveCatalogAvailabilityRelevance('Write a poem about Capiro', {
          planRequiresClientRecords: false,
          intentRequiresClientRecords: false,
          attemptedReads: [],
        }),
      ).toEqual({ requestedApps: [], nativeRequested: false });
    });

    test('an unrelated attempted read does not make client records relevant', () => {
      expect(
        deriveCatalogAvailabilityRelevance('Search the public web for news', {
          attemptedReads: ['search_public_web'],
        }).nativeRequested,
      ).toBe(false);
    });
  });

  const snapshotWithHubSpotFailure = (): MeriCatalogAvailabilitySnapshot => ({
    native: { outcome: 'empty', count: 0 },
    managed: { outcome: 'usable', count: 1 },
    analysis: { outcome: 'disabled' },
    managedAvailability: {
      state: 'partial',
      complete: false,
      registryUnavailable: false,
      failures: [{ appId: 'hubspot', name: 'HubSpot', reason: 'needs_reauth' }],
    },
  });

  describe('instruction + release', () => {
    test('renders fixed source-specific guidance for a requested failed app', () => {
      const relevance = deriveCatalogAvailabilityRelevance('Find Jane in HubSpot');
      const instruction = meriCatalogAvailabilityInstruction(
        snapshotWithHubSpotFailure(),
        relevance,
      );
      expect(instruction).toContain('HubSpot');
      expect(instruction).not.toContain('Airtable');
      expect(instruction).toContain('must not');
    });

    test('is empty for a deliberate disabled/skipped source or an unrelated failure', () => {
      const relevance = deriveCatalogAvailabilityRelevance('What is the weather?');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'skipped' },
        managed: { outcome: 'skipped' },
        analysis: { outcome: 'disabled' },
        managedAvailability: null,
      };
      expect(meriCatalogAvailabilityInstruction(snapshot, relevance)).toBe('');
      expect(meriCatalogAvailabilityReleaseNote(snapshot, relevance)).toBe('');
    });

    test('does not doom an unrelated answer when a different app failed', () => {
      // Request names HubSpot; only Airtable failed. No blanket limitation.
      const relevance = deriveCatalogAvailabilityRelevance('Find Jane in HubSpot');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'usable', count: 2 },
        managed: { outcome: 'usable', count: 1 },
        analysis: { outcome: 'disabled' },
        managedAvailability: {
          state: 'partial',
          complete: false,
          registryUnavailable: false,
          failures: [{ appId: 'airtable', name: 'Airtable', reason: 'unavailable' }],
        },
      };
      expect(meriCatalogAvailabilityInstruction(snapshot, relevance)).toBe('');
      expect(meriCatalogAvailabilityReleaseNote(snapshot, relevance)).toBe('');
    });

    test('a deliberate no_eligible catalog is not treated as an outage', () => {
      const relevance = deriveCatalogAvailabilityRelevance('Find Jane in HubSpot');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'empty', count: 0 },
        managed: { outcome: 'empty', count: 0 },
        analysis: { outcome: 'disabled' },
        managedAvailability: {
          state: 'no_eligible',
          complete: true,
          registryUnavailable: false,
          failures: [],
        },
      };
      expect(meriCatalogAvailabilityInstruction(snapshot, relevance)).toBe('');
      expect(meriCatalogAvailabilityReleaseNote(snapshot, relevance)).toBe('');
    });

    test('an unavailable envelope naming only Airtable does not mark requested HubSpot down', () => {
      // The REAL producer marks state=unavailable when an eligible app failed
      // and no healthy tools were retained, with registryUnavailable=false and
      // the failed app named in `failures`. A requested app that is NOT named is
      // not unavailable.
      const relevance = deriveCatalogAvailabilityRelevance('Find Jane in HubSpot');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'empty', count: 0 },
        managed: { outcome: 'unavailable' },
        analysis: { outcome: 'disabled' },
        managedAvailability: {
          state: 'unavailable',
          complete: false,
          registryUnavailable: false,
          failures: [{ appId: 'airtable', name: 'Airtable', reason: 'unavailable' }],
        },
      };
      expect(relevantUnavailableManagedApps(snapshot, relevance)).toEqual([]);
      expect(meriCatalogAvailabilityInstruction(snapshot, relevance)).toBe('');
      expect(meriCatalogAvailabilityReleaseNote(snapshot, relevance)).toBe('');
    });

    test('a registry-unavailable envelope marks the requested app unavailable', () => {
      const relevance = deriveCatalogAvailabilityRelevance('Find Jane in HubSpot');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'empty', count: 0 },
        managed: { outcome: 'unavailable' },
        analysis: { outcome: 'disabled' },
        managedAvailability: {
          state: 'unavailable',
          complete: false,
          registryUnavailable: true,
          failures: [],
        },
      };
      expect(relevantUnavailableManagedApps(snapshot, relevance)).toEqual(['hubspot']);
      expect(meriCatalogAvailabilityReleaseNote(snapshot, relevance)).toContain('HubSpot');
    });

    test('unknown rolling metadata does not invent an app outage', () => {
      const relevance = deriveCatalogAvailabilityRelevance('Find Jane in HubSpot');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'empty', count: 0 },
        managed: { outcome: 'metadata_unknown', count: 1 },
        analysis: { outcome: 'disabled' },
        managedAvailability: null,
      };
      expect(meriCatalogAvailabilityInstruction(snapshot, relevance)).toBe('');
      expect(meriCatalogAvailabilityReleaseNote(snapshot, relevance)).toBe('');
    });

    test('a healthy initial catalog does not erase a current native read failure', () => {
      const relevance = deriveCatalogAvailabilityRelevance('Look up our Capiro client records');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'usable', count: 2 },
        managedAvailability: null,
        nativeDispatchFailures: [{ capability: 'read_client_documents', reason: 'failed' }],
      };
      expect(nativeRecordsUnavailable(snapshot, relevance)).toBe(true);
      const note = meriCatalogAvailabilityReleaseNote(snapshot, relevance);
      expect(note).toContain('Source note:');
      expect(note).toContain('not consulted');
      expect(note).toContain('read this request needed failed');
    });

    test('a seeded-evidence turn phrases the failed check as an additional live check', () => {
      const relevance = deriveCatalogAvailabilityRelevance('Look up our Capiro client records');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'auth_denied' },
        managedAvailability: null,
      };
      const note = meriCatalogAvailabilityReleaseNote(snapshot, relevance, {
        seededEvidencePresent: true,
      });
      expect(note).toContain('additional live Capiro client-record check');
      expect(note).not.toContain('were not consulted');
    });

    test('a current dispatch failure names the app even after a healthy catalog', () => {
      const relevance = deriveCatalogAvailabilityRelevance('Find Jane in HubSpot');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'empty', count: 0 },
        managed: { outcome: 'usable', count: 1 },
        analysis: { outcome: 'disabled' },
        managedAvailability: {
          state: 'ok',
          complete: true,
          registryUnavailable: false,
          failures: [],
        },
        managedDispatchFailures: [{ appId: 'hubspot', name: 'HubSpot', reason: 'unavailable' }],
      };
      expect(meriCatalogAvailabilityReleaseNote(snapshot, relevance)).toContain('HubSpot');
      expect(meriCatalogAvailabilityReleaseNote(snapshot, relevance)).toContain('were not consulted');
    });

    test('release note is a bounded truthful limitation for a requested unavailable source', () => {
      const relevance = deriveCatalogAvailabilityRelevance('Find Jane in HubSpot');
      const note = meriCatalogAvailabilityReleaseNote(snapshotWithHubSpotFailure(), relevance);
      expect(note).toContain('Source note:');
      expect(note).toContain('HubSpot');
      expect(note).toContain('were not consulted');
    });

    test('release note discloses missing native Capiro records when requested', () => {
      const relevance = deriveCatalogAvailabilityRelevance('Look up our Capiro client records');
      const snapshot: MeriCatalogAvailabilitySnapshot = {
        native: { outcome: 'auth_denied' },
        managedAvailability: null,
      };
      expect(meriCatalogAvailabilityReleaseNote(snapshot, relevance)).toContain(
        'Capiro client records could not be listed',
      );
    });

    test('alreadyDisclosesCatalogAvailability detects the release marker', () => {
      expect(alreadyDisclosesCatalogAvailability('Source note: HubSpot could not be reached.')).toBe(
        true,
      );
      expect(alreadyDisclosesCatalogAvailability('A normal answer.')).toBe(false);
    });

    test('fixed app names are allowlisted, never raw', () => {
      expect(meriCatalogAppName('google-drive')).toBe('Google Drive');
      expect(meriCatalogAppName('monday')).toBe('monday.com');
    });
  });
});
