import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { GOOGLE_USERINFO_URL, GoogleOAuthService } from './google-oauth.service.js';

/**
 * ML-25: the mailbox identity bound to a Google connection comes from the
 * provider's verified statement about the access token — the OpenID Connect
 * UserInfo endpoint Google documents under "Obtaining user profile information"
 * in its OIDC guide — and never from the unsigned `id_token` payload that the
 * token endpoint also returns. These cases exercise that contract and its
 * refusals; the callback wiring that calls it (including the decoy `id_token`
 * the a1 fixture returns) is covered by mailbox-oauth.a1.spec.ts.
 *
 * Only the transport is substituted: the request, the claim checks and the
 * refusals are the production code paths. Values are synthetic.
 */
type VerifiedIdentity = { sub: string; email: string; name: string | null };
/** The private identity lookup is the contract under test here. */
type IdentityService = {
  lookupVerifiedGoogleIdentity(accessToken: string): Promise<VerifiedIdentity>;
};

const ACCESS_TOKEN = 'synthetic-access-token-value';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

/** A service instance with just the transport replaced, so the real parsing runs. */
function service(fetchImpl: typeof fetch): IdentityService {
  jest.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);
  return Object.create(GoogleOAuthService.prototype) as unknown as IdentityService;
}

const respond =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

/** Await a refusal and hand back the thrown error, so message sanitization is testable. */
const refusal = async (lookup: Promise<unknown>): Promise<Error> => {
  try {
    await lookup;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the identity lookup to refuse');
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Google verified mailbox identity', () => {
  test('pins the userinfo_endpoint from the OpenID Connect discovery document', () => {
    // Google publishes `userinfo_endpoint` as this URL; the source hard-codes it
    // like its other three Google endpoints, so this is the doc-contract witness.
    expect(GOOGLE_USERINFO_URL).toBe(USERINFO_URL);
  });

  test('binds the identity from the verified UserInfo response, not the id_token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const lookup = service(async (input, init) => {
      calls.push({ url: String(input), init: init as RequestInit });
      return new Response(
        JSON.stringify({
          sub: ' 1234567890 ',
          email: ' Mailbox@Example.INVALID ',
          email_verified: true,
          name: ' Mailbox Owner ',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    await expect(lookup.lookupVerifiedGoogleIdentity(ACCESS_TOKEN)).resolves.toEqual({
      sub: '1234567890',
      email: 'mailbox@example.invalid',
      name: 'Mailbox Owner',
    });
    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    expect(request.url).toBe(USERINFO_URL);
    expect(request.init?.method).toBe('GET');
    expect((request.init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
  });

  for (const [label, profile] of [
    [
      'an address Google has not verified',
      { sub: '1', email: 'a@example.invalid', email_verified: false },
    ],
    ['an omitted verification flag', { sub: '1', email: 'a@example.invalid' }],
    ['a missing subject', { email: 'a@example.invalid', email_verified: true }],
    ['a blank address', { sub: '1', email: '   ', email_verified: true }],
    ['a null body', null],
  ] as Array<[string, unknown]>) {
    test(`refuses ${label}`, async () => {
      const lookup = service(respond(profile));
      await expect(lookup.lookupVerifiedGoogleIdentity(ACCESS_TOKEN)).rejects.toThrow(
        BadRequestException,
      );
    });
  }

  test('refuses a failed lookup with the provider status, never the provider body', async () => {
    const lookup = service(
      respond({ error: 'invalid_token', error_description: 'synthetic-provider-detail' }, 401),
    );
    const failure = await refusal(lookup.lookupVerifiedGoogleIdentity(ACCESS_TOKEN));
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect(failure.message).toMatch(/identity lookup failed \(401\)/);
    expect(failure.message).not.toMatch(/synthetic-provider-detail/);
  });

  test('refuses a 200 whose body is not JSON as an unreadable provider response', async () => {
    // A proxy/captive-portal style 200 with a non-JSON body must produce a typed,
    // sanitized provider refusal rather than an unclassified parse exception.
    const lookup = service(
      async () =>
        new Response('<html>synthetic-not-json-provider-body</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const failure = await refusal(lookup.lookupVerifiedGoogleIdentity(ACCESS_TOKEN));
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect(failure.message).toMatch(/unreadable response/);
    expect(failure.message).not.toMatch(/synthetic-not-json-provider-body/);
  });
});
