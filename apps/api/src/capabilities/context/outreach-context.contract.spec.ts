import {
  contextKeyForSelection,
  createManualContextLocator,
  createResolvedContextRefV1,
  normalizeContextSelectionV1,
  normalizeResolvedContextRefsV1,
  outreachContextSelectionV1Schema,
  outreachResolvedContextRefV1Schema,
} from './outreach-context.contract.js';

const manual = createManualContextLocator({
  id: '00000000-0000-4000-8000-000000000501',
  title: '  Positioning guidance  ',
  text: '  Lead with the policy impact.\r\nKeep it short.  ',
  sourceLabel: '  user  ',
});

describe('Outreach governed context contract', () => {
  it('creates deterministic content-addressed context keys', () => {
    const a = normalizeContextSelectionV1({
      locator: manual,
      contextClass: 'writing_guidance',
      scope: { kind: 'campaign' },
    });
    const b = normalizeContextSelectionV1({
      locator: { ...manual, title: 'Positioning guidance', text: 'Lead with the policy impact.\nKeep it short.' },
      contextClass: 'writing_guidance',
      scope: { kind: 'campaign' },
    });
    expect(contextKeyForSelection(a)).toBe(contextKeyForSelection(b));
  });

  it('requires target-specific context to have exact target scope', () => {
    expect(() =>
      outreachContextSelectionV1Schema.parse({
        locator: manual,
        contextClass: 'target_specific',
        scope: { kind: 'campaign' },
      }),
    ).toThrow();
  });

  it('requires group-safe context to have explicit group scope', () => {
    expect(() =>
      outreachContextSelectionV1Schema.parse({
        locator: manual,
        contextClass: 'group_safe',
        scope: { kind: 'campaign' },
      }),
    ).toThrow();
  });

  it('requires writing guidance snapshots to be explicitly usable as guidance', () => {
    const selection = normalizeContextSelectionV1({
      locator: manual,
      contextClass: 'writing_guidance',
      scope: { kind: 'campaign' },
    });
    const resolved = createResolvedContextRefV1({
      ...selection,
      title: 'Positioning guidance',
      summary: 'Lead with the policy impact.',
      clientId: null,
      verificationClass: 'user_supplied',
      sensitivity: 'normal',
      instructionsAllowed: true,
      usableAsEvidence: false,
      usableAsWritingGuidance: true,
      sourceSnapshot: { system: 'user', version: null, lastVerifiedAt: null },
    });
    expect(resolved.usableAsWritingGuidance).toBe(true);
    expect(() =>
      outreachResolvedContextRefV1Schema.parse({
        ...resolved,
        usableAsWritingGuidance: false,
      }),
    ).toThrow();
  });

  it('deduplicates resolved context by canonical context key', () => {
    const selection = normalizeContextSelectionV1({
      locator: manual,
      contextClass: 'campaign_fact',
      scope: { kind: 'campaign' },
    });
    const resolved = createResolvedContextRefV1({
      ...selection,
      title: 'Campaign fact',
      summary: 'User supplied.',
      clientId: null,
      verificationClass: 'user_supplied',
      sensitivity: 'normal',
      instructionsAllowed: false,
      usableAsEvidence: false,
      usableAsWritingGuidance: false,
      sourceSnapshot: { system: 'user', version: null, lastVerifiedAt: null },
    });
    expect(normalizeResolvedContextRefsV1([resolved, resolved])).toHaveLength(1);
  });
});
