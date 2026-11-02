import { newsletterAssetOrigin } from './newsletter-asset-origin.js';

/**
 * Newsletter asset links must point at the API that issues and later resolves the token,
 * while the public URL stays the rendering origin for static `/newsletter/` resources.
 * Every asset URL the service builds — upload results, the library listing, image revisions,
 * brand logo/font URLs and the stored-design-image authority baseline — comes from this one
 * origin, so these cases pin the whole split without touching another writer.
 */
const firstChat = 'https://first-chat-preview.app-dev.capiro.ai';
const app = 'https://app.capiro.ai';
const read = (env: Record<string, string | undefined>) => ({
  get: (key: string) => env[key],
});

describe('newsletter asset origin', () => {
  it('prefers an explicit API_PUBLIC_URL over the static rendering origin', () => {
    expect(newsletterAssetOrigin(read({ API_PUBLIC_URL: firstChat, WEB_PUBLIC_URL: app }))).toBe(
      firstChat,
    );
  });

  it('keeps the previous WEB_PUBLIC_URL origin when API_PUBLIC_URL is absent or empty', () => {
    expect(newsletterAssetOrigin(read({ WEB_PUBLIC_URL: app }))).toBe(app);
    expect(newsletterAssetOrigin(read({ API_PUBLIC_URL: '', WEB_PUBLIC_URL: app }))).toBe(app);
    expect(newsletterAssetOrigin(read({ API_PUBLIC_URL: undefined }))).toBe(app);
    expect(newsletterAssetOrigin(read({}))).toBe(app);
  });

  it('normalises trailing slashes so stored absolute URLs never double a separator', () => {
    expect(newsletterAssetOrigin(read({ API_PUBLIC_URL: `${firstChat}//` }))).toBe(firstChat);
    expect(newsletterAssetOrigin(read({ WEB_PUBLIC_URL: `${app}/` }))).toBe(app);
  });

  it('keeps the effective issuer origin identical to the retained first-chat binding', () => {
    // The retained cohort binds WEB_PUBLIC_URL to the first-chat host; adding API_PUBLIC_URL
    // with that same host changes nothing about where an issued token resolves.
    expect(
      newsletterAssetOrigin(read({ API_PUBLIC_URL: firstChat, WEB_PUBLIC_URL: app })),
    ).toBe(newsletterAssetOrigin(read({ WEB_PUBLIC_URL: firstChat })));
  });
});
