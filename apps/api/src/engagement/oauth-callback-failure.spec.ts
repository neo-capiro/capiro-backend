/**
 * The OAuth callback failure vocabulary.
 *
 * A connect that fails after the provider redirect currently leaves nothing
 * behind: the controllers redirect one generic reason and log nothing, and the
 * provider's error code is never stored. These are the pure classifiers that
 * turn a thrown error into one stable reason, the sentence persisted on the
 * connection, and a log detail that cannot carry credentials.
 */
import {
  oauthCallbackFailureReason,
  oauthFailureLogDetail,
  oauthFailureMessage,
} from './oauth-callback-failure.js';

describe('oauthCallbackFailureReason', () => {
  it('classifies missing granted permissions from our own admission check', () => {
    expect(
      oauthCallbackFailureReason(
        new Error('Microsoft did not return the required account and permissions'),
      ),
    ).toBe('required_permissions_missing');
  });

  it('classifies administrator consent refusals', () => {
    expect(
      oauthCallbackFailureReason(
        new Error('AADSTS65001: The user or administrator has not consented'),
      ),
    ).toBe('consent_required');
  });

  it('classifies scope rejections', () => {
    expect(oauthCallbackFailureReason(new Error('AADSTS70011: invalid_scope'))).toBe(
      'scope_rejected',
    );
    expect(oauthCallbackFailureReason(new Error('invalid_scope: Bad Request'))).toBe(
      'scope_rejected',
    );
  });

  it('classifies a spent or expired authorization code', () => {
    expect(oauthCallbackFailureReason(new Error('invalid_grant: AADSTS70008'))).toBe(
      'authorization_code_rejected',
    );
    expect(oauthCallbackFailureReason(new Error('invalid_grant: Bad Request'))).toBe(
      'authorization_code_rejected',
    );
  });

  it('classifies rejected app credentials separately from a user problem', () => {
    expect(oauthCallbackFailureReason(new Error('invalid_client AADSTS700016'))).toBe(
      'client_configuration_rejected',
    );
  });

  it('classifies our own state refusal', () => {
    expect(
      oauthCallbackFailureReason(
        new Error('OAuth attempt is invalid or expired; restart the flow'),
      ),
    ).toBe('state_invalid_or_expired');
  });

  it('falls back to a token-exchange failure without inventing a cause', () => {
    expect(oauthCallbackFailureReason(new Error('socket hang up'))).toBe('token_exchange_failed');
    expect(oauthCallbackFailureReason(undefined)).toBe('token_exchange_failed');
    expect(oauthCallbackFailureReason({})).toBe('token_exchange_failed');
  });
});

describe('oauthFailureMessage', () => {
  it('names the provider and never leaks the raw error', () => {
    const message = oauthFailureMessage('Microsoft 365', 'consent_required');
    expect(message).toContain('Microsoft 365');
    expect(message).toContain('administrator');
    expect(message).not.toContain('AADSTS');
    expect(message.toLowerCase()).not.toContain('undefined');
  });

  it('tells the user what to do for each reason', () => {
    expect(oauthFailureMessage('Google Workspace', 'scope_rejected')).toMatch(/reconnect/i);
    expect(oauthFailureMessage('Google Workspace', 'authorization_code_rejected')).toMatch(
      /retry/i,
    );
    expect(oauthFailureMessage('Microsoft 365', 'required_permissions_missing')).toMatch(
      /permission/i,
    );
    expect(oauthFailureMessage('Microsoft 365', 'client_configuration_rejected')).toMatch(
      /administrator/i,
    );
    expect(oauthFailureMessage('Microsoft 365', 'state_invalid_or_expired')).toMatch(/expired/i);
  });

  it('gives a generic but actionable sentence for an unattributable failure', () => {
    const message = oauthFailureMessage('Microsoft 365', 'token_exchange_failed');
    expect(message).toMatch(/could not be completed/i);
    expect(message).toMatch(/retry|contact/i);
  });
});

describe('oauthFailureLogDetail', () => {
  it('keeps the provider error code and drops the round-tripped credentials', () => {
    const detail = oauthFailureLogDetail(
      new Error(
        'invalid_grant: AADSTS70008: The provided authorization code or refresh token has expired. ' +
          'request body code=0.AX4Aabc123&refresh_token=secret-refresh&state=eyJhbGciOi and more text',
      ),
    );
    expect(detail).toContain('authorization_code_rejected');
    expect(detail).toContain('AADSTS70008');
    expect(detail).not.toContain('0.AX4Aabc123');
    expect(detail).not.toContain('secret-refresh');
    expect(detail).not.toContain('eyJhbGciOi');
  });

  it('redacts tokens in a JSON error body too, with or without spaces around the colon', () => {
    const detail = oauthFailureLogDetail(
      new Error(
        'invalid_grant: AADSTS70008 token exchange body {"error":"invalid_grant","refresh_token":"0.ARefreshSecret","access_token" : "eyJAccessSecret",' +
          '"id_token":"eyJIdSecret","client_secret":"cs-secret","code":"0.AX4ACodeSecret","state":"st\\"ate-secret","error_description":"kept"}',
      ),
      1000,
    );
    expect(detail).toContain('authorization_code_rejected');
    expect(detail).toContain('AADSTS70008');
    expect(detail).toContain('"error_description":"kept"');
    expect(detail).toContain('"refresh_token":"<redacted>"');
    expect(detail).toContain('"access_token" : "<redacted>"');
    for (const secret of ['RefreshSecret', 'AccessSecret', 'IdSecret', 'cs-secret', 'CodeSecret', 'ate-secret']) expect(detail).not.toContain(secret);
  });

  it('bounds the message length so one failure cannot flood the log', () => {
    const detail = oauthFailureLogDetail(new Error('x'.repeat(2000)));
    expect(detail.length).toBeLessThanOrEqual(320);
  });

  it('names the thrown class when there is no message', () => {
    const error = new Error('');
    error.name = 'ServerError';
    expect(oauthFailureLogDetail(error)).toContain('ServerError');
  });
});
