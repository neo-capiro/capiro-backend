import {
  createNewsletterBlock,
  createNewsletterSection,
  defaultNewsletterConfig,
  defaultNewsletterSocialShare,
  defaultNewsletterStyles,
  type NewsletterBlock,
  type NewsletterSocialSharePlatform,
} from '@capiro/shared/newsletter';
import {
  newsletterPlainText,
  newsletterSocialShareTarget,
  newsletterSocialShareUrl,
  renderNewsletterDesign,
} from '@capiro/shared/newsletter-render';
import { validateNewsletterDesign } from './newsletter-validation.js';
import { NewsletterService } from './newsletter.service.js';

const publicUrl = 'https://www.congress.gov/search?q=policy%20brief&sort=date#updates';
function block() {
  const value = createNewsletterBlock('social');
  value.social!.mode = 'share';
  value.social!.display = 'icon-text';
  value.social!.share = {
    ...defaultNewsletterSocialShare(),
    source: 'custom',
    customUrl: publicUrl,
  };
  return value;
}
function design(value: NewsletterBlock) {
  return {
    version: 1 as const,
    styles: defaultNewsletterStyles(),
    sections: [createNewsletterSection('Body', [value])],
  };
}
const service: NewsletterService = Object.create(NewsletterService.prototype);

describe('Social Share persistence and capability separation', () => {
  it('retains inactive Follow destinations, Share rows and independent mode display choices', () => {
    const value = block();
    value.social!.followDisplay = 'icon';
    value.social!.shareDisplay = 'text';
    value.social!.share!.items.reverse();
    expect(validateNewsletterDesign(design(value)).sections[0]!.blocks[0]).toEqual(value);
  });
  it.each(['facebook', 'linkedin', 'pinterest', 'twitter', 'instapaper'] as const)(
    'encodes the exact public destination for %s',
    (platform) => {
      const link = new URL(newsletterSocialShareUrl(platform, publicUrl));
      expect(link.protocol).toBe('https:');
      if (platform === 'twitter')
        expect(link.searchParams.get('text')).toBe(`Newsletter: ${publicUrl}`);
      else expect(link.searchParams.get(platform === 'facebook' ? 'u' : 'url')).toBe(publicUrl);
      if (platform === 'pinterest') expect(link.searchParams.get('media')).toBe('Newsletter');
      if (platform === 'instapaper') expect(link.searchParams.get('title')).toBe('Newsletter');
    },
  );
  it.each([
    'javascript:alert(1)',
    'mailto:policy@example.com',
    'https://user:secret@example.com/news',
    '*|ARCHIVE|*',
    'https://app.capiro.ai/api/engagement/newsletter-public/recipient-token/archive',
    'https://app.capiro.ai/engagement/%6Eewsletter-public/recipient-token/preferences',
  ])('rejects an unsafe destination without embedding it into a provider URL: %s', (url) => {
    expect(newsletterSocialShareTarget(url)).toBe('');
    expect(newsletterSocialShareUrl('facebook', url)).toBe('');
    const value = block();
    value.social!.share!.customUrl = url;
    expect(() => validateNewsletterDesign(design(value))).toThrow();
    const html = renderNewsletterDesign(design(value), defaultNewsletterConfig());
    expect(html).not.toContain('href=');
    expect(html).not.toContain('recipient-token');
  });
  it('withholds campaign links even with a live recipient archive URL, and blocks staging', () => {
    const value = block();
    value.social!.share!.source = 'campaign';
    const html = renderNewsletterDesign(design(value), defaultNewsletterConfig(), {
      liveMergeTags: true,
      archiveUrl: 'https://app.capiro.ai/engagement/newsletter-public/recipient-token/archive',
    });
    expect(html).not.toContain('href=');
    expect(html).not.toContain('recipient-token');
    expect(html).toContain('aria-disabled="true"');
    expect(service.checks(design(value), defaultNewsletterConfig())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `share-${value.id}`, severity: 'error' }),
      ]),
    );
  });
  it('renders custom sharing and plain text without inactive profile links, and passes the sharing check', () => {
    const value = block();
    const html = renderNewsletterDesign(design(value), defaultNewsletterConfig());
    expect((html.match(/href=/g) || []).length).toBe(2);
    expect(html).not.toContain('href="https://instagram.com/"');
    expect(newsletterPlainText(design(value), defaultNewsletterConfig())).toContain(
      'sharing/share-offsite',
    );
    expect(newsletterPlainText(design(value), defaultNewsletterConfig())).not.toContain(
      'instagram.com',
    );
    expect(
      service
        .checks(design(value), defaultNewsletterConfig())
        .some((check) => check.id === `share-${value.id}`),
    ).toBe(false);
  });
  it('withholds forwarding links and blocks the excluded channel from staging', () => {
    const value = block();
    value.social!.share!.items = [{ platform: 'forward', label: 'Forward briefing' }];
    expect(renderNewsletterDesign(design(value), defaultNewsletterConfig())).not.toContain('href=');
    expect(service.checks(design(value), defaultNewsletterConfig())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Finish social sharing',
          detail:
            'Forwarding is not enabled. Remove this channel or choose another channel before staging.',
        }),
      ]),
    );
  });
  it.each([
    (value: NewsletterBlock) => {
      value.social!.mode = 'unknown' as never;
    },
    (value: NewsletterBlock) => {
      value.social!.share!.source = 'profile' as never;
    },
    (value: NewsletterBlock) => {
      value.social!.share!.items[0]!.platform = '../../image' as NewsletterSocialSharePlatform;
    },
    (value: NewsletterBlock) => {
      value.social!.share!.items.push(value.social!.share!.items[0]!);
    },
    (value: NewsletterBlock) => {
      delete value.social!.share;
    },
    (value: NewsletterBlock) => {
      value.social!.followDisplay = 'unknown' as never;
    },
  ])('rejects invalid Share settings %#', (edit) => {
    const value = block();
    edit(value);
    expect(() => validateNewsletterDesign(design(value))).toThrow();
  });
});
