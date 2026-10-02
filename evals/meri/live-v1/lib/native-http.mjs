/** Fixed client identification required by the existing application edge. */
export function nativeMeriCaptureHeaders(bearer, tenantSlug) {
  if (
    typeof bearer !== 'string' ||
    !bearer ||
    /[\r\n]/u.test(bearer) ||
    !/^meri-foundation-20260928-t[12]$/u.test(tenantSlug ?? '')
  )
    throw new Error('MERI_CAPTURE_HTTP_IDENTITY_INVALID');
  return {
    'User-Agent': 'Capiro-Meri-Authorized-QA/1.0',
    authorization: `Bearer ${bearer}`,
    'x-capiro-tenant': tenantSlug,
  };
}
