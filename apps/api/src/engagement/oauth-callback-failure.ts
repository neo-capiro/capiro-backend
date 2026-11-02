/**
 * OAuth callback failure classification.
 *
 * A connect that fails after the provider redirect used to leave nothing
 * behind: the callback controllers redirect one generic reason and log nothing,
 * and no provider code is ever stored. Without a stable vocabulary every future
 * "connection failed" is unexplainable after the fact (the load balancers keep
 * no access logs, so the callback query string is gone too).
 *
 * Nothing here serializes provider bytes: reasons are a fixed enum, the stored
 * sentence never contains the provider's error text, and the log detail scrubs
 * anything that round-tripped through the request (code / state / tokens).
 */

export type OAuthCallbackFailureReason =
  | 'missing_code_or_state'
  | 'state_invalid_or_expired'
  | 'consent_required'
  | 'scope_rejected'
  | 'authorization_code_rejected'
  | 'client_configuration_rejected'
  | 'required_permissions_missing'
  | 'token_exchange_failed';

/** Ordered: the first matching signature wins. */
const SIGNATURES: ReadonlyArray<readonly [OAuthCallbackFailureReason, RegExp]> = [
  // Our own state fence refusal happens before any provider call.
  ['state_invalid_or_expired', /oauth attempt is invalid or expired/i],
  // The app registration itself is wrong — an administrator's problem, not the user's.
  [
    'client_configuration_rejected',
    /invalid_client|unauthorized_client|AADSTS700016|AADSTS7000215|AADSTS700027/i,
  ],
  // The grant exists but a human (usually a tenant admin) must approve it.
  [
    'consent_required',
    /AADSTS65001|consent_required|admin_consent_required|AADSTS90094|InteractionRequiredAuthError/i,
  ],
  // The provider refused one of the requested scopes.
  ['scope_rejected', /invalid_scope|insufficient_scope|AADSTS70011|AADSTS650053|AADSTS65004/i],
  // The authorization code was already used or outlived its few minutes.
  ['authorization_code_rejected', /invalid_grant|AADSTS70008|AADSTS54005|AADSTS50196/i],
  // Our own post-exchange admission: the account or the grant came back short.
  [
    'required_permissions_missing',
    /did not return the required account and permissions|did not grant|needs all requested permissions|missing (?:google )?grants|did not return an access token/i,
  ],
];

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  return '';
}

export function oauthCallbackFailureReason(error: unknown): OAuthCallbackFailureReason {
  const message = messageOf(error);
  for (const [reason, pattern] of SIGNATURES) {
    if (pattern.test(message)) return reason;
  }
  return 'token_exchange_failed';
}

/**
 * The sentence persisted on the connection (and therefore shown in Settings).
 * Fixed per reason: no provider text, no account data.
 */
export function oauthFailureMessage(
  provider: 'Microsoft 365' | 'Google Workspace',
  reason: OAuthCallbackFailureReason,
): string {
  switch (reason) {
    case 'missing_code_or_state':
      return `${provider} returned no authorization code. Start the connection again.`;
    case 'state_invalid_or_expired':
      return `The ${provider} sign-in expired before it was used. Start the connection again.`;
    case 'consent_required':
      return `${provider} sign-in needs administrator consent for the Capiro app. Ask your ${provider} administrator to approve it, then reconnect.`;
    case 'scope_rejected':
      return `${provider} did not grant the requested mail and calendar permissions. Reconnect and approve every permission on the consent screen.`;
    case 'authorization_code_rejected':
      return `${provider} sign-in expired or was already used. Retry the connection.`;
    case 'client_configuration_rejected':
      return `${provider} rejected Capiro's application credentials. An administrator must review the app registration before this account can connect.`;
    case 'required_permissions_missing':
      return `${provider} did not return the account and permissions Capiro requires. Reconnect and approve all permissions.`;
    case 'token_exchange_failed':
    default:
      return `${provider} sign-in could not be completed. Retry the connection; if it keeps failing, contact support with the time it failed.`;
  }
}

const CREDENTIAL_PAIR =
  /(\b(?:code|access_token|refresh_token|id_token|client_secret|client_assertion|assertion|state)=)[^&\s"',]+/gi;

/** One safe log line: reason, provider error code, scrubbed message, bounded. */
export function oauthFailureLogDetail(error: unknown, limit = 240): string {
  const reason = oauthCallbackFailureReason(error);
  const name = error instanceof Error && error.name ? error.name : 'Error';
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const scrubbed = raw.replace(CREDENTIAL_PAIR, '$1<redacted>').replace(/\s+/g, ' ').trim();
  return `${reason} (${name}): ${scrubbed.slice(0, limit)}`;
}
