import { ContextCompiler, renderHumanSections, renderedBody, renderedLayer } from './compiler';
import type { CompiledContextPacket, ContextRequest, SteeringRow } from './contract';

const human = (heading: string, body: string) => ({ owner: 'human', heading, body });
const meri = (heading: string, body: string) => ({ owner: 'meri', heading, body });

const row = (over: Partial<SteeringRow>): SteeringRow => ({
  id: 'id-x',
  type: 'firm-soul',
  slug: 'firm',
  title: null,
  clientId: null,
  status: 'active',
  sections: [human('H', 'B')],
  ...over,
});

const req = (over: Partial<ContextRequest>): ContextRequest => ({
  tenantId: 't1',
  userId: 'u1',
  surface: 'chat',
  layers: ['firm-identity', 'user-voice'],
  ...over,
});

function makeCompiler(rows: SteeringRow[]) {
  const persisted: CompiledContextPacket[] = [];
  const compiler = new ContextCompiler({
    loadSteeringRows: jest.fn().mockResolvedValue(rows),
    persistPacket: jest.fn(async (packet: CompiledContextPacket) => {
      persisted.push(structuredClone(packet));
    }),
  });
  return { compiler, persisted };
}

describe('renderHumanSections (the ONE shared renderer)', () => {
  it('renders only human-owned sections, "Heading: body" joined by newline', () => {
    expect(
      renderHumanSections([
        human('Who we are', 'A defense firm.'),
        meri('Derived', 'model text'),
        human('Empty', '   '),
        human('Style', 'Direct.'),
      ]),
    ).toBe('Who we are: A defense firm.\nStyle: Direct.');
  });

  it('is defensive about non-array input', () => {
    expect(renderHumanSections(null)).toBe('');
    expect(renderHumanSections({ not: 'an array' })).toBe('');
  });
});

describe('ContextCompiler.compile', () => {
  it('classifies by type, includes only requested layers, and preserves requested layer order', async () => {
    const { compiler } = makeCompiler([
      row({ id: 'v1', type: 'user-voice', slug: 'voice', sections: [human('Style', 'Terse.')] }),
      row({ id: 'f1', type: 'firm-soul' }),
      row({ id: 'c1', type: 'client-soul', clientId: 'cl1' }),
    ]);
    const packet = await compiler.compile(req({}));

    expect(packet.rendered.map((item) => item.id)).toEqual(['f1', 'v1']);
    expect(packet.items.map((item) => item.layer)).toEqual(['firm-identity', 'user-voice']);
    expect(packet.exclusions).toEqual([]);
    expect(packet.items.every((item) => item.rationale.length > 0)).toBe(true);
    // Every included item carries a full SHA-256 of the exact body that was rendered.
    expect(packet.items).toHaveLength(2);
    expect(packet.items.every((item) => /^[a-f0-9]{64}$/.test(item.contentHash))).toBe(true);
    expect(packet.traceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records revoked, superseded, expired, and empty rows as explicit exclusions', async () => {
    const { compiler } = makeCompiler([
      row({ id: 'ok', type: 'firm-soul' }),
      row({ id: 'gone', type: 'firm-compass', status: 'revoked' }),
      row({ id: 'old', type: 'firm-compass', status: 'superseded' }),
      row({ id: 'stale', type: 'firm-compass', expiresAt: '2020-01-01T00:00:00.000Z' }),
      row({ id: 'blank', type: 'user-voice', sections: [meri('Derived', 'x')] }),
    ]);
    const packet = await compiler.compile(req({}));

    expect(packet.rendered.map((item) => item.id)).toEqual(['ok']);
    // Every excluded row is traced with its exact reason. Ordering follows the
    // compiler's deterministic sort rather than the adapter's row order, so the
    // reason MAPPING is asserted rather than a positional list.
    expect(Object.fromEntries(packet.exclusions.map((item) => [item.id, item.reason]))).toEqual({
      gone: 'revoked',
      old: 'superseded',
      stale: 'expired',
      blank: 'empty',
    });
    expect(packet.exclusions).toHaveLength(4);
  });

  it('preserves complete sections under a budget and traces omitted section labels', async () => {
    const { compiler } = makeCompiler([
      row({
        id: 'a',
        type: 'firm-soul',
        sections: [human('Short', 'keep'), human('Long', 'x'.repeat(80))],
      }),
      row({ id: 'b', type: 'firm-compass', sections: [human('Other', 'y'.repeat(80))] }),
    ]);
    const packet = await compiler.compile(req({ charBudget: 30, layers: ['firm-identity'] }));

    expect(packet.rendered).toEqual([expect.objectContaining({ id: 'a', body: 'Short: keep' })]);
    expect(packet.items[0]).toEqual(expect.objectContaining({ omittedSections: ['Long'] }));
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: 'b', reason: 'over-budget' }),
    ]);
  });

  it('is byte-deterministic for shuffled adapter input apart from id/time', async () => {
    const rows = [
      row({ id: '3', type: 'user-voice', slug: 'voice-b', updatedAt: '2026-01-01T00:00:00Z' }),
      row({ id: '1', type: 'firm-compass', slug: 'firm', updatedAt: '2026-02-01T00:00:00Z' }),
      row({ id: '2', type: 'firm-soul', slug: 'firm', updatedAt: '2026-03-01T00:00:00Z' }),
      row({ id: '4', type: 'user-profile', slug: 'voice-a', updatedAt: '2026-01-01T00:00:00Z' }),
    ];
    const snapshots: Array<
      Pick<CompiledContextPacket, 'items' | 'exclusions' | 'rendered' | 'traceHash'>
    > = [];
    for (const order of [rows, [...rows].reverse(), [rows[2]!, rows[0]!, rows[3]!, rows[1]!]]) {
      const packet = await makeCompiler(order).compiler.compile(req({}));
      snapshots.push({
        items: packet.items,
        exclusions: packet.exclusions,
        rendered: packet.rendered,
        traceHash: packet.traceHash,
      });
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  });

  it('awaits persistence and only advertises a durable packet after success', async () => {
    const { compiler, persisted } = makeCompiler([row({ id: 'f1' })]);
    const packet = await compiler.compile(req({ ref: { conversationId: 'conv-1' } }));

    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.packetId).toBe(packet.packetId);
    expect(persisted[0]!.ref).toEqual({ conversationId: 'conv-1' });
    expect(packet.persisted).toBe(true);

    const failing = new ContextCompiler({
      loadSteeringRows: jest.fn().mockResolvedValue([row({})]),
      persistPacket: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(failing.compile(req({}))).resolves.toEqual(
      expect.objectContaining({ persisted: false }),
    );
    await expect(failing.compile(req({ persistence: 'required' }))).rejects.toThrow('db down');
  });

  it('works without a persistPacket implementation without fabricating durability', async () => {
    const compiler = new ContextCompiler({
      loadSteeringRows: jest.fn().mockResolvedValue([row({})]),
    });
    const packet = await compiler.compile(req({}));
    expect(packet.items).toHaveLength(1);
    expect(packet.persisted).toBe(false);
  });
});

describe('composition helpers', () => {
  it('renderedBody / renderedLayer pull from the packet', async () => {
    const { compiler } = makeCompiler([
      row({ id: 'f1', type: 'firm-soul', sections: [human('Who', 'Us.')] }),
      row({ id: 'f2', type: 'firm-compass', sections: [human('Where', 'Up.')] }),
      row({ id: 'v1', type: 'user-voice', slug: 'voice', sections: [human('Style', 'Calm.')] }),
    ]);
    const packet = await compiler.compile(req({}));

    expect(renderedBody(packet, 'user-voice')).toBe('Style: Calm.');
    expect(renderedBody(packet, 'client-soul')).toBeUndefined();
    // Firm Soul precedes Firm Compass — the canonical rank, not alphabetical type.
    expect(renderedLayer(packet, 'firm-identity').map((item) => item.id)).toEqual(['f1', 'f2']);
  });

  it('renders soul before compass for both firm and client layers', async () => {
    const { compiler } = makeCompiler([
      // Deliberately supplied compass-first, to prove the compiler re-orders.
      row({ id: 'fc', type: 'firm-compass', sections: [human('Where', 'Up.')] }),
      row({ id: 'fs', type: 'firm-soul', sections: [human('Who', 'Us.')] }),
      row({
        id: 'cc',
        type: 'client-compass',
        clientId: 'cl1',
        sections: [human('Framing', 'X.')],
      }),
      row({ id: 'cs', type: 'client-soul', clientId: 'cl1', sections: [human('Identity', 'Y.')] }),
    ]);
    const packet = await compiler.compile(
      req({ clientId: 'cl1', layers: ['firm-identity', 'client-steering'] }),
    );

    expect(renderedLayer(packet, 'firm-identity').map((item) => item.id)).toEqual(['fs', 'fc']);
    expect(renderedLayer(packet, 'client-steering').map((item) => item.id)).toEqual(['cs', 'cc']);
  });
});
