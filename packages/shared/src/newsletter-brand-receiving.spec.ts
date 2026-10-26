import {
  defaultNewsletterBrandKit,
  parseNewsletterBrandKit,
  parseNewsletterFont,
  type NewsletterBrandKit,
  type NewsletterFont,
  type NewsletterReceiveResult,
} from './newsletter.js';

const id = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const time = '2026-10-26T10:00:00.000Z';
const url = `https://synthetic.example.test:8443/preview/workspace-api/newsletters/assets/file/${'a'.repeat(64)}`;
const font = (format: NewsletterFont['format'] = 'woff2'): NewsletterFont => ({
  assetId: id,
  name: 'Synthetic Firm Sans',
  family: `CapiroFont-${id}`,
  format,
  url,
});
/** Exact service output: persisted payload plus row revision/ISO instant, not an unsaved factory. */
const kit = (): NewsletterBrandKit => ({
  ...defaultNewsletterBrandKit(),
  revision: 4,
  updatedAt: time,
});
function accepted<T>(result: NewsletterReceiveResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe('current brand/font public receiving', () => {
  it('admits initialized empty kit metadata and explicit null primary choices without inventing a reset receipt', () => {
    const value = kit();
    expect(accepted(parseNewsletterBrandKit(value))).toEqual(value);
    expect(parseNewsletterBrandKit(defaultNewsletterBrandKit()).ok).toBe(false);
    for (const input of [null, undefined, [], {}, { message: 'Not available' }])
      expect(parseNewsletterBrandKit(input).ok).toBe(false);
    value.primaryButtonId = '';
    expect(accepted(parseNewsletterBrandKit(value)).primaryButtonId).toBe('');
  });

  it('receives a full CAS update with references and binds only an explicitly captured returned revision', () => {
    const value = kit();
    value.logos = [
      { assetId: id, name: 'Firm logo', url, link: 'https://firm.example.test', alt: 'Firm' },
    ];
    value.primaryLogoId = id;
    value.primaryButtonId = value.buttons[0]!.id;
    value.fonts.uploaded = [font()];
    value.fonts.heading = `${font().family}, Arial, sans-serif`;
    expect(accepted(parseNewsletterBrandKit(value, { revision: 4 }))).toEqual(value);
    expect(parseNewsletterBrandKit(value, { revision: 5 })).toEqual({
      ok: false,
      error: { code: 'identity_mismatch', path: '$.revision' },
    });
    for (const expected of [null, {}, { revision: 0 }, { revision: 4, ownerId: 'invented' }])
      expect(parseNewsletterBrandKit(value, expected as never).ok).toBe(false);
  });

  it.each(['truetype', 'opentype', 'woff', 'woff2'] as const)(
    'admits standalone %s upload metadata without claiming bytes, kit attachment or request identity',
    (format) => {
      const value = font(format);
      expect(accepted(parseNewsletterFont(value))).toEqual(value);
      expect(accepted(parseNewsletterBrandKit(kit())).fonts.uploaded).toEqual([]);
      expect(parseNewsletterFont({ ...value, family: `CapiroFont-${other}` })).toEqual({
        ok: false,
        error: { code: 'identity_mismatch', path: '$.family' },
      });
    },
  );

  it('preserves JSON additions as inert metadata and takes an independent snapshot', () => {
    const value = { ...kit(), future: { label: 'preserved', values: [null, true, 2] } };
    const result = accepted(parseNewsletterBrandKit(value)) as typeof value;
    expect(result).toEqual(value);
    result.future.values.push(3);
    expect(value.future.values).toEqual([null, true, 2]);
    const uploaded = { ...font(), future: { verified: false } };
    expect(accepted(parseNewsletterFont(uploaded))).toEqual(uploaded);
  });

  it('rejects malformed known fields, dangling/duplicate references and out-of-bounds collections', () => {
    const invalid = [
      { ...kit(), revision: 1.5 },
      { ...kit(), updatedAt: 'not an instant' },
      { ...kit(), primaryLogoId: id },
      { ...kit(), primaryButtonId: 'not-in-kit' },
      { ...kit(), colors: { primary: ['red'], secondary: [] } },
      { ...kit(), buttons: [{ ...kit().buttons[0], shape: 'circle' }] },
      { ...kit(), buttons: [kit().buttons[0], kit().buttons[0]] },
      { ...kit(), fonts: { ...kit().fonts, body: 'x; color:red', uploaded: [] } },
      { ...kit(), fonts: { ...kit().fonts, uploaded: [font(), font()] } },
      { ...kit(), colors: { primary: Array(21).fill('#ffffff'), secondary: [] } },
      { ...kit(), fonts: { ...kit().fonts, uploaded: null } },
    ];
    for (const value of invalid) expect(parseNewsletterBrandKit(value).ok).toBe(false);
    for (const value of [
      null,
      {},
      { ...font(), format: 'svg' },
      { ...font(), name: 'n'.repeat(201) },
      { ...font(), assetId: other },
    ])
      expect(parseNewsletterFont(value).ok).toBe(false);
  });

  it('checks managed URL syntax without claiming the origin is trusted', () => {
    expect(
      accepted(
        parseNewsletterFont({
          ...font(),
          url: url.replace('synthetic.example.test', 'other.example.test'),
        }),
      ).url,
    ).toContain('other.example.test');
    for (const value of [
      'javascript:alert(1)',
      'file:///tmp/font',
      'https://example.test/not-a-managed-asset',
      `${url}?secret=x`,
      `${url}#fragment`,
      url.replace('https://', 'https://user:pass@'),
    ])
      expect(parseNewsletterFont({ ...font(), url: value }).ok).toBe(false);
  });

  it('never invokes accessors and refuses cyclic, non-JSON, proxy and hostile binding input', () => {
    let getters = 0;
    const accessor = { ...kit() };
    Object.defineProperty(accessor, 'revision', {
      enumerable: true,
      get() {
        getters++;
        return 4;
      },
    });
    const expected = Object.defineProperty({}, 'revision', {
      enumerable: true,
      get() {
        getters++;
        return 4;
      },
    });
    const cycle: Record<string, unknown> = { ...kit() };
    cycle.self = cycle;
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('untrusted');
        },
      },
    );
    for (const value of [
      accessor,
      cycle,
      throwing,
      { ...kit(), future: BigInt(1) },
      { ...kit(), future: new Date() },
      { ...kit(), future: undefined },
    ])
      expect(parseNewsletterBrandKit(value).ok).toBe(false);
    expect(parseNewsletterBrandKit(kit(), expected as never).ok).toBe(false);
    expect(getters).toBe(0);
    for (const value of [accessor, cycle, throwing])
      expect(parseNewsletterFont(value).ok).toBe(false);
  });
});
