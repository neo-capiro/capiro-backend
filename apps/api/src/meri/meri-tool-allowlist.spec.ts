import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { MERI_TOOL_NAMES } from '@capiro/shared';
import { configSchema } from '../config/config.schema.js';
import { assertMeriToolAllowed, parseMeriToolAllowlist } from './meri-tool-allowlist.js';

// The single exact list rendered into the preview Core task (MERI_TOOL_ALLOWLIST).
const preview = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../infra/cdk/lib/preview/first-chat-core-meri-tools.json'), 'utf8',
)) as { tools: string[]; excluded: Record<string, string> };

describe('exact Meri tool allowlist', () => {
  it('is unchanged (every registered tool) when unset', () => {
    expect(parseMeriToolAllowlist(undefined)).toBeNull();
    expect(parseMeriToolAllowlist('')).toBeNull();
    expect(() => assertMeriToolAllowed('anything', null)).not.toThrow();
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
