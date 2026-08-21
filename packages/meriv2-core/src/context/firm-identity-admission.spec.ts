import { describe, expect, it, jest } from '@jest/globals';
import { ContextCompiler } from './compiler.js';
import { applyContextSurfacePolicy } from './surface-policy.js';
import type {
  CompiledContextPacket,
  CompiledContextPacketV2,
  ContextRequest,
  ContextSurface,
  SteeringRow,
} from './contract.js';

/**
 * Why this file exists.
 *
 * In production, `firm-identity` was absent from essentially every governed
 * ContextPacket across every surface. The institutional layer that is supposed
 * to make Capiro behave like one firm-aware system was effectively missing.
 *
 * It was NOT a layer-mapping, scope-selection, budget, or compiler-policy
 * defect, and the source rows were not missing. `firm-soul` / `firm-compass`
 * existed, `status = 'active'`, `slug = 'firm'`, unexpired, correctly classified
 * `institutional_authoritative` / scope `firm`, and every governed operation
 * explicitly requested the layer. They were excluded because
 * `governed_status = 'pending_review'`: the
 * `20260729010000_memory_governance_context_v2` migration deliberately mapped
 * every legacy `status='active'` row to `pending_review` ("records the v2 state
 * without making a pending legacy row active"), and the governed lifecycle was
 * then armed for exactly the two tenants that own firm identity content.
 *
 * So the pipeline was correct and the DATA was unapproved. These tests pin that
 * distinction in both directions, because the two look identical from a packet
 * that only reports item counts:
 *
 *   - an ELIGIBLE firm identity record must reach the packet, on every surface
 *     that requests it, without violating budget, authority, wall or user scope;
 *   - an unapproved one must be excluded VISIBLY, with reason `unapproved`,
 *     never dropped silently.
 *
 * If someone "fixes" the missing layer by loosening the governed gate, the
 * second half of this file fails. If a future refactor breaks admission of
 * approved institutional memory, the first half fails.
 */

const human = (heading: string, body: string) => ({ owner: 'human', heading, body });

/** An APPROVED firm-identity record: every governed gate satisfied. */
const approvedFirmIdentity = (over: Partial<SteeringRow> = {}): SteeringRow => ({
  id: 'firm-soul-1',
  type: 'firm-soul',
  slug: 'firm',
  title: 'Firm Soul',
  clientId: null,
  ownerUserId: null,
  visibility: 'tenant',
  status: 'active',
  legacyStatus: 'active',
  governedStatus: 'active',
  expiresAt: null,
  updatedAt: '2026-08-01T00:00:00.000Z',
  confirmedAt: '2026-08-01T00:00:00.000Z',
  authority: 'human',
  memoryClass: 'institutional_authoritative',
  governedAuthority: 'firm_approved',
  sourceType: 'firm_playbook',
  sourceId: 'source-1',
  sourceRef: 'memory-file:firm-soul',
  sourceContentHash: 'a'.repeat(64),
  sourceVersion: 'v3',
  assertedByUserId: 'author-1',
  approvedByUserId: 'approver-1',
  approvedAt: '2026-08-01T00:00:00.000Z',
  asOf: '2026-08-01T00:00:00.000Z',
  conflictStatus: 'none',
  sensitivity: 'normal',
  instructionsAllowed: false,
  sections: [human('Identity', 'Capiro is a government-affairs operating platform.')],
  ...over,
});

/** A user-voice record, which needs no human approval, as the live comparison. */
const userVoice = (over: Partial<SteeringRow> = {}): SteeringRow =>
  approvedFirmIdentity({
    id: 'user-voice-1',
    type: 'user-voice',
    slug: 'user-1',
    title: 'User Voice',
    ownerUserId: 'user-1',
    visibility: 'user',
    memoryClass: 'user_preference',
    governedAuthority: 'user_asserted',
    approvedByUserId: null,
    approvedAt: null,
    sections: [human('Voice', 'Prefers short, concrete sentences.')],
    ...over,
  });

const request = (over: Partial<ContextRequest> = {}): ContextRequest =>
  applyContextSurfacePolicy({
    tenantId: 'tenant-1',
    effectiveTenantId: 'tenant-1',
    actorUserId: 'actor-1',
    userId: 'user-1',
    clientId: 'client-a',
    surface: 'ga-chat',
    traceId: 'trace-1',
    selectedItemIds: [],
    allowedSensitivities: ['normal'],
    ethicalWallAllowed: true,
    ...over,
  });

function compilerFor(rows: SteeringRow[]) {
  return new ContextCompiler({
    loadSteeringRows: jest.fn<() => Promise<SteeringRow[]>>().mockResolvedValue(rows),
    loadGovernedSteeringRows: jest.fn<() => Promise<SteeringRow[]>>().mockResolvedValue(rows),
    persistPacket: jest.fn(async () => undefined),
  });
}

async function compile(rows: SteeringRow[], over: Partial<ContextRequest> = {}) {
  const packet = (await compilerFor(rows).compile(request(over))) as CompiledContextPacket;
  expect(packet.version).toBe(2);
  return packet as CompiledContextPacketV2;
}

const layersOf = (packet: CompiledContextPacketV2) => packet.items.map((item) => item.layer);

describe('eligible firm identity reaches governed packets', () => {
  // The surfaces behind Meri, Workspace, Strategy and Meetings generation.
  const SURFACES: ContextSurface[] = [
    'chat',
    'ga-chat',
    'strategy',
    'workspace-gen',
    'workspace-editor',
    'outreach',
    'memo',
    'research',
  ];

  it.each(SURFACES)('%s admits an approved firm identity record', async (surface) => {
    const packet = await compile([approvedFirmIdentity()], {
      surface,
      layers: ['firm-identity'],
      clientId: null,
    });
    expect(layersOf(packet)).toContain('firm-identity');
    expect(packet.health.missingRequiredLayers).not.toContain('firm-identity');
    expect(packet.exclusions).toHaveLength(0);
  });

  it('reaches the packet alongside user voice without displacing it', async () => {
    const packet = await compile([approvedFirmIdentity(), userVoice()], {
      layers: ['firm-identity', 'user-voice'],
      clientId: null,
    });
    // The live symptom was user-voice present and firm-identity absent. Both
    // must coexist, so a passing "user-voice is there" check can never again be
    // mistaken for a healthy institutional layer.
    expect(layersOf(packet)).toEqual(expect.arrayContaining(['firm-identity', 'user-voice']));
    expect(packet.exclusions).toHaveLength(0);
  });

  it('stays inside the token budget rather than buying admission with overflow', async () => {
    const packet = await compile([approvedFirmIdentity(), userVoice()], {
      layers: ['firm-identity', 'user-voice'],
      clientId: null,
      tokenBudget: 400,
      budgetUnit: 'tokens',
    });
    expect(layersOf(packet)).toContain('firm-identity');
    expect(packet.usedTokens).toBeLessThanOrEqual(400);
  });

  it('does not need instruction authority to be admitted', async () => {
    // `instructionsAllowed: false` is the production value on every firm row.
    // Admission and instruction authority are separate decisions; conflating
    // them would be a tempting and wrong way to "fix" the missing layer.
    const packet = await compile([approvedFirmIdentity({ instructionsAllowed: false })], {
      layers: ['firm-identity'],
      clientId: null,
    });
    expect(layersOf(packet)).toContain('firm-identity');
  });

  it('is firm-scoped: it survives a request with no client and ignores the wall', async () => {
    const packet = await compile([approvedFirmIdentity()], {
      layers: ['firm-identity'],
      clientId: null,
      ethicalWallAllowed: false,
    });
    // The ethical wall governs CLIENT memory. Firm identity is not client-scoped,
    // so a walled or absent client must not remove the institutional layer.
    expect(layersOf(packet)).toContain('firm-identity');
  });

  it('is not user-scoped: another actor still receives it', async () => {
    const packet = await compile([approvedFirmIdentity()], {
      layers: ['firm-identity'],
      clientId: null,
      userId: 'someone-else',
      actorUserId: 'someone-else',
    });
    expect(layersOf(packet)).toContain('firm-identity');
  });
});

describe('unapproved firm identity is excluded visibly, not silently', () => {
  it('a pending_review record is excluded with reason unapproved', async () => {
    // This is the exact production state: correctly classified, correctly
    // sourced, status active, slug firm, unexpired -- and never approved.
    const packet = await compile([approvedFirmIdentity({ governedStatus: 'pending_review' })], {
      layers: ['firm-identity'],
      clientId: null,
    });
    expect(layersOf(packet)).not.toContain('firm-identity');
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ layer: 'firm-identity', reason: 'unapproved' }),
    ]);
    // A requested layer that produced nothing must degrade packet health, so an
    // absent institutional layer is never reported as a healthy packet.
    expect(packet.health.missingRequiredLayers).toContain('firm-identity');
    expect(packet.health.status).not.toBe('healthy');
  });

  it('an unclassified legacy record is excluded and says so', async () => {
    // The second production shape (the dualsight tenant): never classified at
    // all, so it fails on class as well as on approval.
    const packet = await compile(
      [
        approvedFirmIdentity({
          governedStatus: 'pending_review',
          memoryClass: 'legacy_unclassified',
          governedAuthority: 'legacy_unclassified',
          sourceType: 'unknown',
          sourceId: null,
          sourceRef: null,
        }),
      ],
      { layers: ['firm-identity'], clientId: null },
    );
    expect(layersOf(packet)).not.toContain('firm-identity');
    expect(packet.exclusions.length).toBeGreaterThan(0);
    expect(packet.exclusions[0]?.layer).toBe('firm-identity');
  });

  it('approving the record is what admits it -- nothing else changes', async () => {
    const pending = await compile([approvedFirmIdentity({ governedStatus: 'pending_review' })], {
      layers: ['firm-identity'],
      clientId: null,
    });
    const approved = await compile([approvedFirmIdentity()], {
      layers: ['firm-identity'],
      clientId: null,
    });
    // Same row, one field apart. This is the whole production finding in one
    // assertion: the pipeline was never broken, the data was unapproved.
    expect(layersOf(pending)).not.toContain('firm-identity');
    expect(layersOf(approved)).toContain('firm-identity');
  });
});
