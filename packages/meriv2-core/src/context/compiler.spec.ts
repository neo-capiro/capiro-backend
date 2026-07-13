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
    persistPacket: jest.fn(async (p: CompiledContextPacket) => {
      persisted.push(p);
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
  it('classifies by type, includes only requested layers, preserves layer order', async () => {
    const { compiler } = makeCompiler([
      row({ id: 'v1', type: 'user-voice', slug: 'voice', sections: [human('Style', 'Terse.')] }),
      row({ id: 'f1', type: 'firm-soul' }),
      row({ id: 'c1', type: 'client-soul', clientId: 'cl1' }), // NOT requested
    ]);
    const packet = await compiler.compile(req({}));

    // firm-identity requested before user-voice → firm renders first even
    // though the adapter returned voice first.
    expect(packet.rendered.map((r) => r.id)).toEqual(['f1', 'v1']);
    expect(packet.items.map((i) => i.layer)).toEqual(['firm-identity', 'user-voice']);
    // Unrequested layers are neither included nor recorded as exclusions.
    expect(packet.exclusions).toEqual([]);
    expect(packet.items.every((i) => i.rationale.length > 0)).toBe(true);
  });

  it('records superseded/revoked/empty rows as exclusions, never renders them', async () => {
    const { compiler } = makeCompiler([
      row({ id: 'ok', type: 'firm-soul' }),
      row({ id: 'gone', type: 'firm-compass', status: 'revoked' }),
      row({ id: 'old', type: 'firm-compass', status: 'superseded' }),
      row({ id: 'blank', type: 'user-voice', sections: [meri('Derived', 'x')] }),
    ]);
    const packet = await compiler.compile(req({}));

    expect(packet.rendered.map((r) => r.id)).toEqual(['ok']);
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: 'gone', reason: 'revoked' }),
      expect.objectContaining({ id: 'old', reason: 'superseded' }),
      expect.objectContaining({ id: 'blank', reason: 'empty' }),
    ]);
  });

  it('drops items past the char budget with an over-budget exclusion (never truncates)', async () => {
    const { compiler } = makeCompiler([
      row({ id: 'a', type: 'firm-soul', sections: [human('H', 'x'.repeat(50))] }),
      row({ id: 'b', type: 'firm-compass', sections: [human('H', 'y'.repeat(50))] }),
    ]);
    const packet = await compiler.compile(req({ charBudget: 60, layers: ['firm-identity'] }));

    expect(packet.rendered.map((r) => r.id)).toEqual(['a']);
    expect(packet.exclusions).toEqual([
      expect.objectContaining({ id: 'b', reason: 'over-budget' }),
    ]);
    // The included body is intact, not clipped to fit.
    expect(packet.rendered[0]!.body).toHaveLength(53); // 'H: ' + 50
  });

  it('fires persistPacket with the full packet and survives its failure', async () => {
    const { compiler, persisted } = makeCompiler([row({ id: 'f1' })]);
    const packet = await compiler.compile(req({ ref: { conversationId: 'conv-1' } }));
    // fire-and-forget: allow the microtask to settle
    await new Promise((r) => setImmediate(r));

    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.packetId).toBe(packet.packetId);
    expect(persisted[0]!.ref).toEqual({ conversationId: 'conv-1' });

    // A rejecting persistPacket must not reject compile().
    const failing = new ContextCompiler({
      loadSteeringRows: jest.fn().mockResolvedValue([row({})]),
      persistPacket: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(failing.compile(req({}))).resolves.toBeTruthy();
  });

  it('works without a persistPacket implementation', async () => {
    const compiler = new ContextCompiler({
      loadSteeringRows: jest.fn().mockResolvedValue([row({})]),
    });
    const packet = await compiler.compile(req({}));
    expect(packet.items).toHaveLength(1);
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
    expect(renderedLayer(packet, 'firm-identity').map((r) => r.id)).toEqual(['f1', 'f2']);
  });
});
