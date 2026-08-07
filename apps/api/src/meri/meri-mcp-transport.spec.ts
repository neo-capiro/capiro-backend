import { describe, expect, test } from '@jest/globals';
import { stdioCommandAllowed, tokenHeaderFor } from './meri-mcp-transport.js';
import { MCP_ALLOWED_TOKEN_HEADERS } from './meri-mcp.catalog.js';

describe('stdio command allowlist (F6a security boundary)', () => {
  test('refuses everything when no allowlist is configured (default)', () => {
    expect(stdioCommandAllowed('node', undefined)).toBe(false);
    expect(stdioCommandAllowed('node', '')).toBe(false);
  });

  test('allows only exact allowlisted commands', () => {
    const csv = '/usr/local/bin/mcp-files, /usr/local/bin/mcp-git';
    expect(stdioCommandAllowed('/usr/local/bin/mcp-files', csv)).toBe(true);
    expect(stdioCommandAllowed('/usr/local/bin/mcp-git', csv)).toBe(true);
    expect(stdioCommandAllowed('/usr/local/bin/mcp-files --evil', csv)).toBe(false);
    expect(stdioCommandAllowed('/bin/sh', csv)).toBe(false);
    // No prefix/substring tricks.
    expect(stdioCommandAllowed('/usr/local/bin/mcp', csv)).toBe(false);
  });
});

/**
 * The static-token header (P39).
 *
 * Before this phase every token went out as `Authorization: Bearer <token>`.
 * MakeGov/Tango's MCP endpoint authenticates on `X-Tango-API-Key` instead, and
 * the tempting fix — letting a connector name its own header — would let anyone
 * who can add one aim a decrypted secret at an arbitrary header. The header set
 * is closed, lives in the catalog, and is re-checked here.
 */
describe('static-token header is catalog-owned and allowlisted (P39)', () => {
  test('the default is unchanged: Authorization with the Bearer scheme', () => {
    expect(tokenHeaderFor('abc', undefined)).toEqual({ Authorization: 'Bearer abc' });
    expect(tokenHeaderFor('abc', null)).toEqual({ Authorization: 'Bearer abc' });
    expect(tokenHeaderFor('abc', 'Authorization')).toEqual({ Authorization: 'Bearer abc' });
  });

  test('an allowlisted API-key header carries the RAW key, with no scheme prefix', () => {
    // `X-Tango-API-Key: Bearer abc` fails auth in a way that looks like a bad
    // key, which is a long afternoon.
    expect(tokenHeaderFor('abc', 'X-Tango-API-Key')).toEqual({ 'X-Tango-API-Key': 'abc' });
  });

  test('ANY header outside the allowlist falls back to the safe default', () => {
    for (const attempt of [
      'Cookie',
      'X-Forwarded-For',
      'x-tango-api-key', // case matters: the allowlist is exact
      'X-Tango-API-Key ', // trailing space
      'Authorization: Bearer',
      '',
      'X-Evil',
    ]) {
      expect(tokenHeaderFor('abc', attempt)).toEqual({ Authorization: 'Bearer abc' });
    }
  });

  test('a non-string header cannot smuggle anything through', () => {
    for (const attempt of [42, {}, [], true, Symbol('x')] as unknown[]) {
      expect(tokenHeaderFor('abc', attempt as string)).toEqual({ Authorization: 'Bearer abc' });
    }
  });

  test('no token means no auth header at all', () => {
    expect(tokenHeaderFor(null, 'X-Tango-API-Key')).toBeUndefined();
    expect(tokenHeaderFor('', 'X-Tango-API-Key')).toBeUndefined();
    expect(tokenHeaderFor(undefined, undefined)).toBeUndefined();
  });

  test('every produced header name is one of the allowlisted two — swept', () => {
    const attempts = [
      undefined,
      null,
      'Authorization',
      'X-Tango-API-Key',
      'X-Api-Key',
      'Proxy-Authorization',
      '../../etc/passwd',
    ];
    for (const attempt of attempts) {
      const headers = tokenHeaderFor('abc', attempt);
      if (!headers) continue;
      for (const name of Object.keys(headers)) {
        expect(MCP_ALLOWED_TOKEN_HEADERS as readonly string[]).toContain(name);
      }
    }
  });
});
