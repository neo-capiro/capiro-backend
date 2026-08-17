import {
  OUTREACH_REASONING_READ_TOOLS,
  sanitizeOutreachReasoningToolInput,
} from './outreach-reasoning-tools.js';

function walk(value: unknown, path: string[] = []): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const hits: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    const next = [...path, key];
    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf' || key === 'not') {
      hits.push(`${next.join('.')} is not permitted in OpenAI strict function schemas`);
    }
    hits.push(...walk(child, next));
  }
  return hits;
}

describe('Outreach reasoning OpenAI tool schemas', () => {
  it('never sends oneOf/anyOf that OpenAI rejects on strict function tools', () => {
    const violations = OUTREACH_REASONING_READ_TOOLS.flatMap((tool) =>
      walk(tool.parameters, [tool.name]).map((hit) => `${tool.name}: ${hit}`),
    );
    expect(violations).toEqual([]);
  });

  it('keeps every strict tool object additionalProperties=false with required covering all properties', () => {
    for (const tool of OUTREACH_REASONING_READ_TOOLS) {
      expect(tool.strict).toBe(true);
      const params = tool.parameters as {
        type?: string;
        additionalProperties?: unknown;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(params.type).toBe('object');
      expect(params.additionalProperties).toBe(false);
      const keys = Object.keys(params.properties ?? {}).sort();
      expect([...(params.required ?? [])].sort()).toEqual(keys);
    }
  });

  it('strips OpenAI-strict empty-string placeholders before Capiro validation', () => {
    expect(
      sanitizeOutreachReasoningToolInput('get_target_profile', {
        targetRef: { source: 'directory_member', id: 'member-1', clientId: '' },
      }),
    ).toEqual({
      targetRef: { source: 'directory_member', id: 'member-1' },
    });
    expect(
      sanitizeOutreachReasoningToolInput('search_targets', {
        query: '',
        clientId: '',
        sources: ['directory_member'],
        limit: 10,
      }),
    ).toEqual({
      query: null,
      clientId: null,
      sources: ['directory_member'],
      limit: 10,
    });
    expect(
      sanitizeOutreachReasoningToolInput('search_memory', {
        query: 'NDAA',
        clientId: '',
        intendedClass: 'campaign_fact',
        scope: { kind: 'campaign', targetKey: '', groupRef: '' },
        limit: 8,
      }),
    ).toEqual({
      query: 'NDAA',
      clientId: null,
      intendedClass: 'campaign_fact',
      scope: { kind: 'campaign' },
      limit: 8,
    });
  });
});
