import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { MERI_TOOL_NAMES } from '@capiro/shared';
import { configSchema, validateConfig } from '../config/config.schema.js';
import { assertMeriToolAllowed, parseMeriToolAllowlist } from './meri-tool-allowlist.js';

// The single exact list rendered into the preview Core task (MERI_TOOL_ALLOWLIST).
const preview = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../infra/cdk/lib/preview/first-chat-core-meri-tools.json'), 'utf8',
)) as { tools: string[]; excluded: Record<string, string> };

describe('exact Meri tool allowlist', () => {
  it('is unchanged (every registered tool) when unset in the standard profile', () => {
    expect(parseMeriToolAllowlist(undefined)).toBeNull();
    expect(parseMeriToolAllowlist('')).toBeNull();
    expect(() => assertMeriToolAllowed('anything', null, undefined)).not.toThrow();
    expect(() => assertMeriToolAllowed('anything', null, 'standard')).not.toThrow();
  });

  it('fails closed at the route in the first-chat-preview profile without a list', () => {
    expect(() => assertMeriToolAllowed('search_federal_grants', null, 'first-chat-preview')).toThrow(NotFoundException);
  });

  describe('startup validation', () => {
    const base = {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://x:y@localhost:5432/capiro',
      CLERK_SECRET_KEY: 'sk_test_synthetic', CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_synthetic',
    };
    it('keeps the standard profile default and optional list', () => {
      expect(validateConfig(base).CORE_DEPLOYMENT_PROFILE).toBe('standard');
      expect(validateConfig(base).MERI_TOOL_ALLOWLIST).toBeUndefined();
    });
    it('refuses the preview profile without an exact non-empty list', () => {
      expect(() => validateConfig({ ...base, CORE_DEPLOYMENT_PROFILE: 'first-chat-preview' })).toThrow(/requires an exact, non-empty MERI_TOOL_ALLOWLIST/);
      expect(() => validateConfig({ ...base, CORE_DEPLOYMENT_PROFILE: 'first-chat-preview', MERI_TOOL_ALLOWLIST: '' })).toThrow();
      expect(() => validateConfig({ ...base, CORE_DEPLOYMENT_PROFILE: 'first-chat-preview', MERI_TOOL_ALLOWLIST: 'x,,y' })).toThrow();
      expect(validateConfig({ ...base, CORE_DEPLOYMENT_PROFILE: 'first-chat-preview', MERI_TOOL_ALLOWLIST: preview.tools.join(',') })
        .MERI_TOOL_ALLOWLIST).toBe(preview.tools.join(','));
    });
    it('rejects an unknown profile', () => {
      expect(() => validateConfig({ ...base, CORE_DEPLOYMENT_PROFILE: 'preview' })).toThrow();
    });
  });

  it('allows only listed names and answers unlisted ones like an unknown tool', () => {
    const allowlist = parseMeriToolAllowlist('search_federal_grants,create_task');
    expect(() => assertMeriToolAllowed('search_federal_grants', allowlist)).not.toThrow();
    expect(() => assertMeriToolAllowed('create_task', allowlist)).not.toThrow();
    for (const name of ['send_email', 'create_client', 'SEARCH_FEDERAL_GRANTS', 'search_federal_grants ', '']) {
      expect(() => assertMeriToolAllowed(name, allowlist)).toThrow(NotFoundException);
    }
  });

  it.each(['a', 'Search', 'x,,y', 'x, y', 'x,y,', 'x/y', 'dup_one,dup_one'])('refuses a malformed list %j', (raw) => {
    expect(() => parseMeriToolAllowlist(raw)).toThrow();
  });

  it('pins the preview list to registered Core tool names, without the Florida tool fallback', () => {
    expect(preview.tools.length).toBeGreaterThan(0);
    expect([...preview.tools].sort()).toEqual(preview.tools);
    expect(new Set(preview.tools).size).toBe(preview.tools.length);
    expect(preview.tools.filter((name) => !MERI_TOOL_NAMES.includes(name))).toEqual([]);
    expect(preview.tools).not.toContain('get_florida_budget_project');
    expect(Object.keys(preview.excluded)).toEqual(['get_florida_budget_project']);
    const raw = preview.tools.join(',');
    expect(parseMeriToolAllowlist(raw)?.size).toBe(preview.tools.length);
    expect(configSchema.shape.MERI_TOOL_ALLOWLIST.safeParse(raw).success).toBe(true);
  });
});
