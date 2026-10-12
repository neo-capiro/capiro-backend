import { BadRequestException } from '@nestjs/common';
import {
  createNewsletterBlock,
  createNewsletterSection,
  defaultNewsletterStyles,
  type NewsletterBlock,
} from '@capiro/shared/newsletter';
import { renderNewsletterDesign } from '@capiro/shared/newsletter-render';
import { defaultNewsletterConfig } from '@capiro/shared/newsletter';
import { validateNewsletterDesign, validateNewsletterStyle } from './newsletter-validation.js';

function design(block = createNewsletterBlock('social')) {
  return {
    version: 1,
    styles: defaultNewsletterStyles(),
    sections: [createNewsletterSection('Social', [block])],
  };
}
describe('Social Follow persistence validation', () => {
  it('retains channel metadata, display and separate desktop/mobile settings', () => {
    const block = createNewsletterBlock('social', { linkedStyles: false });
    block.social!.iconStyle = 'color-white';
    block.social!.display = 'icon-text';
    block.social!.mobile = { layout: 'vertical', size: 'small', spacing: 12 };
    expect(validateNewsletterDesign(design(block)).sections[0]!.blocks[0]!).toEqual(block);
  });
  it('does not silently enable icons in a previously saved text-link block', () => {
    const block = createNewsletterBlock('social');
    delete block.social;
    const saved = validateNewsletterDesign(design(block));
    expect(saved.sections[0]!.blocks[0]!.social).toBeUndefined();
    expect(renderNewsletterDesign(saved, defaultNewsletterConfig())).not.toContain(
      'nl-social-icon',
    );
  });
  it.each([
    (b: NewsletterBlock) => {
      b.social!.iconStyle = '../../untrusted' as never;
    },
    (b: NewsletterBlock) => {
      b.social!.display = 'unknown' as never;
    },
    (b: NewsletterBlock) => {
      b.social!.desktop.size = '500' as never;
    },
    (b: NewsletterBlock) => {
      b.social!.mobile.layout = 'diagonal' as never;
    },
    (b: NewsletterBlock) => {
      b.social!.desktop.spacing = 0;
    },
    (b: NewsletterBlock) => {
      b.social!.desktop.spacing = 62;
    },
    (b: NewsletterBlock) => {
      b.social!.desktop.spacing = 13;
    },
    (b: NewsletterBlock) => {
      b.items[0]!.platform = '../../image' as never;
    },
    (b: NewsletterBlock) => {
      b.kind = 'paragraph';
    },
  ])('rejects invalid Social configuration %#', (edit) => {
    const block = createNewsletterBlock('social');
    edit(block);
    expect(() => validateNewsletterDesign(design(block))).toThrow(BadRequestException);
  });
  it.each(['inset', 'outset', 'groove', 'ridge'] as const)(
    'retains and renders the %s border style',
    (borderStyle) => {
      const block = createNewsletterBlock('social', { style: { borderStyle, borderWidth: 2 } });
      const saved = validateNewsletterDesign(design(block));
      expect(validateNewsletterStyle(block.style).borderStyle).toBe(borderStyle);
      expect(renderNewsletterDesign(saved, defaultNewsletterConfig())).toContain(
        `border-style:${borderStyle}`,
      );
    },
  );
});
