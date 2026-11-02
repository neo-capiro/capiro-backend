/**
 * Origin for newsletter asset links.
 *
 * Asset links belong to the API that issues and later resolves the token, which is a
 * different purpose from the public URL used to render static `/newsletter/` pages. An
 * explicit API_PUBLIC_URL wins; a deployment that does not set one keeps the previous
 * WEB_PUBLIC_URL origin, so its effective issuer origin is unchanged.
 */
export function newsletterAssetOrigin(
  env: { get(key: string): unknown },
  fallback = 'https://app.capiro.ai',
): string {
  const configured = (env.get('API_PUBLIC_URL') as string | undefined) ||
    (env.get('WEB_PUBLIC_URL') as string | undefined) ||
    fallback;
  return String(configured).replace(/\/+$/, '');
}
