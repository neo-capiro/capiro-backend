import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  applyNewsletterBrandKit,
  defaultNewsletterBrandKit,
  defaultNewsletterConfig,
  governmentAffairsNewsletter,
  visitNewsletterBlocks,
  type NewsletterFont,
} from '@capiro/shared/newsletter';
import { newsletterFontCss, renderNewsletterDesign } from '@capiro/shared/newsletter-render';
import { NewsletterService } from './newsletter.service.js';
import { newsletterFontFormat, validateNewsletterFonts } from './newsletter-brand-validation.js';
import { validateNewsletterDesign } from './newsletter-validation.js';

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', clerkUserId: 'owner' };
const assetId = '22222222-2222-4222-8222-222222222222';
const font: NewsletterFont = {
  assetId,
  name: 'Firm Sans',
  family: `CapiroFont-${assetId}`,
  url: 'https://app.capiro.ai/font',
  format: 'woff',
};
const scope = { tenantId: ctx.tenantId, ownerId: ctx.clerkUserId };
function fixture() {
  const kit = defaultNewsletterBrandKit();
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const brand = {
    upsert: jest.fn().mockResolvedValue({ payload: kit, revision: 1, updatedAt: new Date() }),
    updateMany,
    findUnique: jest.fn(async () => ({
      payload: updateMany.mock.calls[0]![0].data.payload,
      revision: 2,
      updatedAt: new Date(),
    })),
  };
  const asset = {
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  };
  const document = {
    create: jest.fn(async ({ data }) => ({
      ...data,
      id: assetId,
      revision: 1,
      status: 'draft',
      updatedAt: new Date(),
    })),
  };
  const prisma = {
    wsNewsletterBrandKit: brand,
    wsNewsletterAsset: asset,
    wsNewsletterDocument: document,
    $transaction: jest.fn(async (fn) => fn({ wsNewsletterBrandKit: brand })),
  };
  const service = new NewsletterService(
    prisma as never,
    {} as never,
    {} as never,
    { get: () => 'https://app.capiro.ai' } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { kit, brand, asset, document, prisma, service };
}
describe('newsletter Brand Kit', () => {
  it('scopes the kit and every selected asset to tenant and owner and derives asset URLs', async () => {
    const f = fixture();
    f.kit.logos = [
      {
        assetId,
        name: 'Firm logo',
        url: 'https://untrusted.example/ignored',
        link: 'https://firm.example',
        alt: 'Firm',
      },
    ];
    f.kit.primaryLogoId = assetId;
    f.kit.fonts.uploaded = [font];
    f.asset.findFirst
      .mockResolvedValueOnce({ id: assetId, token: 'logo-token', mimeType: 'image/png' })
      .mockResolvedValueOnce({ id: assetId, token: 'font-token', mimeType: 'font/woff2' });
    const result = await f.service.saveBrandKit(ctx, f.kit);
    expect(f.asset.findFirst.mock.calls.map(([arg]) => arg.where)).toEqual([
      { id: assetId, ...scope, mimeType: { in: ['image/png', 'image/jpeg'] } },
      { id: assetId, ...scope },
    ]);
    expect(f.brand.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...scope, revision: 1 } }),
    );
    expect(result.revision).toBe(2);
    expect(result.logos[0]!.url).toBe(
      'https://app.capiro.ai/workspace-api/newsletters/assets/file/logo-token',
    );
    expect(result.fonts.uploaded[0]).toMatchObject({
      family: font.family,
      format: 'woff2',
      url: 'https://app.capiro.ai/workspace-api/newsletters/assets/file/font-token',
    });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    await f.service.brandKit(ctx);
    expect(f.brand.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId_ownerId: scope } }),
    );
  });
  it('rejects a foreign asset before saving and rejects stale revisions without returning a success', async () => {
    const f = fixture();
    f.kit.fonts.uploaded = [font];
    f.asset.findFirst.mockResolvedValue(null);
    await expect(f.service.saveBrandKit(ctx, f.kit)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.brand.updateMany).not.toHaveBeenCalled();
    f.kit.fonts.uploaded = [];
    f.brand.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.saveBrandKit(ctx, f.kit)).rejects.toBeInstanceOf(ConflictException);
    expect(f.brand.findUnique).not.toHaveBeenCalled();
  });
  it('applies primary logo and button to new builtin documents and keeps a font snapshot', async () => {
    const f = fixture();
    f.kit.logos = [
      {
        assetId,
        name: 'Logo',
        url: 'https://firm.example/logo.png',
        link: 'https://firm.example',
        alt: 'Firm',
      },
    ];
    f.kit.primaryLogoId = assetId;
    f.kit.fonts.uploaded = [font];
    f.kit.fonts.heading = `${font.family}, Arial, sans-serif`;
    f.kit.buttons[0]!.background = '#123456';
    f.kit.primaryButtonId = f.kit.buttons[0]!.id;
    const doc = await f.service.create(ctx, {});
    visitNewsletterBlocks(doc.design, (block) => {
      if (block.kind === 'logo')
        expect(block).toMatchObject({
          imageUrl: 'https://firm.example/logo.png',
          url: 'https://firm.example',
          text: '',
        });
      if (block.kind === 'button') expect(block.style.background).toBe('#123456');
    });
    f.kit.fonts.uploaded.length = 0;
    expect(doc.design.fonts).toEqual([font]);
    expect(renderNewsletterDesign(doc.design, defaultNewsletterConfig())).toContain(
      `@font-face{font-family:'${font.family}'`,
    );
  });
  it('keeps custom fonts on saved sections after kit removal and prevents CSS injection', () => {
    const design = governmentAffairsNewsletter();
    design.sections[0]!.fonts = [font];
    const validated = validateNewsletterDesign(design);
    expect(validated.sections[0]!.fonts).toEqual([font]);
    expect(renderNewsletterDesign(validated, defaultNewsletterConfig())).toContain(
      "format('woff')",
    );
    expect(newsletterFontCss([{ ...font, family: "x';}body{display:none}" }])).toBe('');
    expect(newsletterFontCss([{ ...font, url: 'javascript:alert(1)' }])).toBe('');
    expect(() =>
      validateNewsletterFonts([
        { ...font, family: 'CapiroFont-33333333-3333-4333-8333-333333333333' },
      ]),
    ).toThrow(BadRequestException);
    const css = newsletterFontCss([
      { ...font, url: "https://firm.example/font');}</style><script>x</script>" },
    ]);
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('<script>');
  });
  it('validates font container bounds and rejects arbitrary files before storing bytes', async () => {
    const f = fixture();
    const ttf = Buffer.alloc(32);
    ttf.writeUInt32BE(0x10000, 0);
    ttf.writeUInt16BE(1, 4);
    ttf.writeUInt32BE(28, 20);
    ttf.writeUInt32BE(4, 24);
    expect(newsletterFontFormat(ttf)).toBe('truetype');
    f.asset.create.mockImplementation(async ({ data }) => ({ ...data, id: assetId }));
    expect(
      await f.service.uploadFont(ctx, { buffer: ttf, originalname: 'Firm.ttf' }),
    ).toMatchObject({ assetId, family: font.family, format: 'truetype' });
    expect(f.asset.create.mock.calls[0]![0].data).toMatchObject({
      ...scope,
      mimeType: 'font/ttf',
      file: ttf,
    });
    ttf.writeUInt32BE(33, 20);
    expect(newsletterFontFormat(ttf)).toBeNull();
    const before = f.asset.create.mock.calls.length;
    await expect(
      f.service.uploadFont(ctx, { buffer: Buffer.from('<svg/>'), originalname: 'fake.woff' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.asset.create).toHaveBeenCalledTimes(before);
  });
});
