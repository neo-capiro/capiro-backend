import { normalizeLegiWatchPhase9Rollout } from './live-hearings-phase9-api.js';

describe('LegiWatch Phase 9 rollout normalization', () => {
  it('requires the complete CUTOVER contract before enabling the default', () => {
    expect(
      normalizeLegiWatchPhase9Rollout({
        phase: 'CUTOVER',
        productionDefault: true,
        killSwitchEngaged: false,
        liveHearingsV2DefaultEnabled: true,
        schedulesEnabled: true,
      }),
    ).toMatchObject({
      phase: 'CUTOVER',
      liveHearingsV2DefaultEnabled: true,
      forceLegacy: false,
    });

    expect(
      normalizeLegiWatchPhase9Rollout({
        phase: 'READY',
        productionDefault: true,
        killSwitchEngaged: false,
        liveHearingsV2DefaultEnabled: true,
      }).liveHearingsV2DefaultEnabled,
    ).toBe(false);
    expect(
      normalizeLegiWatchPhase9Rollout({
        phase: 'CUTOVER',
        productionDefault: true,
        killSwitchEngaged: true,
        liveHearingsV2DefaultEnabled: true,
      }).liveHearingsV2DefaultEnabled,
    ).toBe(false);
  });

  it('marks ROLLBACK as a server-authoritative forced legacy state', () => {
    expect(
      normalizeLegiWatchPhase9Rollout({
        phase: 'ROLLBACK',
        productionDefault: false,
        killSwitchEngaged: true,
        liveHearingsV2DefaultEnabled: false,
      }),
    ).toMatchObject({
      phase: 'ROLLBACK',
      forceLegacy: true,
      liveHearingsV2DefaultEnabled: false,
    });
  });

  it('fails unknown or malformed payloads closed', () => {
    expect(normalizeLegiWatchPhase9Rollout(null)).toMatchObject({
      phase: 'UNKNOWN',
      productionDefault: false,
      liveHearingsV2DefaultEnabled: false,
      forceLegacy: false,
    });
    expect(
      normalizeLegiWatchPhase9Rollout({
        phase: 'CUTOVER',
        productionDefault: 'yes',
        liveHearingsV2DefaultEnabled: 'yes',
      }).liveHearingsV2DefaultEnabled,
    ).toBe(false);
  });

  it('recognizes canary only in CANARY or READY', () => {
    expect(normalizeLegiWatchPhase9Rollout({ phase: 'CANARY', canary: true }).canary).toBe(true);
    expect(normalizeLegiWatchPhase9Rollout({ phase: 'SHADOW', canary: true }).canary).toBe(false);
  });
});
