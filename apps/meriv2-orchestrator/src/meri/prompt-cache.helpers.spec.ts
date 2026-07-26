import {
  applyToolCacheControl,
  buildSystemBlocks,
  flattenSystemParts,
  parseCacheEnabledFlag,
} from './prompt-cache.helpers.js';

describe('buildSystemBlocks', () => {
  it('puts a single cache breakpoint on the static base block when caching is enabled', () => {
    const blocks = buildSystemBlocks({ base: 'BASE PROMPT', dynamic: 'ctx', cacheEnabled: true });
    expect(blocks).toEqual([
      { type: 'text', text: 'BASE PROMPT', cache_control: { type: 'ephemeral' } },
      // Leading '\n' — Anthropic concatenates adjacent system blocks with no
      // implicit separator, so this must supply the one flattenSystemParts adds.
      { type: 'text', text: '\nctx' },
    ]);
    // The dynamic block must never carry a breakpoint (it varies per turn).
    expect(blocks[1]!.cache_control).toBeUndefined();
  });

  it('renders identically to flattenSystemParts once the block texts are concatenated', () => {
    const parts = { base: 'BASE PROMPT', dynamic: 'per-turn ctx' };
    const blocks = buildSystemBlocks({ ...parts, cacheEnabled: true });
    expect(blocks.map((b) => b.text).join('')).toBe(flattenSystemParts(parts));
  });

  it('omits all cache_control when caching is disabled', () => {
    const blocks = buildSystemBlocks({ base: 'BASE', dynamic: 'ctx', cacheEnabled: false });
    expect(blocks.every((b) => b.cache_control === undefined)).toBe(true);
  });

  it('emits only the base block when the dynamic tail is empty or whitespace', () => {
    expect(buildSystemBlocks({ base: 'BASE', dynamic: '', cacheEnabled: true })).toHaveLength(1);
    expect(buildSystemBlocks({ base: 'BASE', dynamic: '   \n ', cacheEnabled: true })).toHaveLength(
      1,
    );
    expect(buildSystemBlocks({ base: 'BASE', cacheEnabled: true })).toHaveLength(1);
  });

  it('preserves base text byte-for-byte so the cached prefix is stable across turns', () => {
    const base = 'You are Meri.\n- rule one\n- rule two';
    const a = buildSystemBlocks({ base, dynamic: 'turn-1 context', cacheEnabled: true });
    const b = buildSystemBlocks({ base, dynamic: 'turn-2 different context', cacheEnabled: true });
    expect(a[0]).toEqual(b[0]); // identical cached base block => cache hit
  });

  it('does not attach a breakpoint to an empty base', () => {
    const blocks = buildSystemBlocks({ base: '', dynamic: 'ctx', cacheEnabled: true });
    expect(blocks[0]!.cache_control).toBeUndefined();
  });
});

describe('applyToolCacheControl', () => {
  const tools = [
    { name: 'a', description: 'A', input_schema: {} },
    { name: 'b', description: 'B', input_schema: {} },
    { name: 'c', description: 'C', input_schema: {} },
  ];

  it('marks only the last tool when caching is enabled', () => {
    const out = applyToolCacheControl(tools, true);
    expect(out[0]!.cache_control).toBeUndefined();
    expect(out[1]!.cache_control).toBeUndefined();
    expect(out[2]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks no tool when caching is disabled', () => {
    const out = applyToolCacheControl(tools, false);
    expect(out.every((t) => (t as { cache_control?: unknown }).cache_control === undefined)).toBe(
      true,
    );
  });

  it('never mutates the input array or its elements', () => {
    const input = [{ name: 'x', description: 'X', input_schema: {} }];
    const out = applyToolCacheControl(input, true);
    expect(out[0]).not.toBe(input[0]); // shallow clone
    expect((input[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  it('handles an empty tool list', () => {
    expect(applyToolCacheControl([], true)).toEqual([]);
  });

  it('preserves extra fields already on the tool (e.g. A7 strict) when cloning', () => {
    const strictTools = [{ name: 'a', description: 'A', input_schema: {}, strict: true }];
    const out = applyToolCacheControl(strictTools, true);
    expect(out[0]).toEqual({
      name: 'a',
      description: 'A',
      input_schema: {},
      strict: true,
      cache_control: { type: 'ephemeral' },
    });
  });
});

describe('flattenSystemParts', () => {
  it('passes a plain string through unchanged', () => {
    expect(flattenSystemParts('sys')).toBe('sys');
  });

  it('joins base + dynamic with a single newline', () => {
    expect(flattenSystemParts({ base: 'BASE', dynamic: 'ctx' })).toBe('BASE\nctx');
  });

  it('returns base alone when dynamic is empty/whitespace/absent', () => {
    expect(flattenSystemParts({ base: 'BASE', dynamic: '' })).toBe('BASE');
    expect(flattenSystemParts({ base: 'BASE', dynamic: '   ' })).toBe('BASE');
    expect(flattenSystemParts({ base: 'BASE' })).toBe('BASE');
  });
});

describe('parseCacheEnabledFlag', () => {
  it('returns the default when unset', () => {
    expect(parseCacheEnabledFlag(undefined, true)).toBe(true);
    expect(parseCacheEnabledFlag(undefined, false)).toBe(false);
  });

  it.each(['false', 'FALSE', '0', 'no', 'NO', 'off', ' Off '])(
    'disables on %j regardless of the default',
    (raw) => {
      expect(parseCacheEnabledFlag(raw, true)).toBe(false);
    },
  );

  it.each(['true', '1', 'yes', 'on', 'anything-else'])('enables on %j', (raw) => {
    expect(parseCacheEnabledFlag(raw, false)).toBe(true);
  });
});
