import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import {
  FUNDING_OPPORTUNITIES_TANGO_MCP_FEATURE,
  MCP_ALLOWED_TOKEN_HEADERS,
  MCP_CATALOG,
  catalogTokenHeader,
  getCatalogEntry,
  isAllowedTokenHeader,
} from './meri-mcp.catalog.js';

/**
 * The curated MCP connector library, and P39's research-only Tango entry.
 *
 * Four properties carry the phase:
 *   1. Only a CATALOG entry can name a token header, and only from a closed set.
 *   2. The Tango entry is research-only, read-only, and flag-gated.
 *   3. A disabled connector registers no tools — the flag hides the entry
 *      rather than greying it out.
 *   4. The connector cannot reach deterministic scoring, alerts or artifacts.
 *      Asserted against the Funding Opportunities source, not against a comment.
 */

const TANGO = 'makegov-tango';

describe('P39 — only the catalog names a token header, from a closed set', () => {
  test('the allowlist is exactly the two headers, and Authorization is explicit', () => {
    // Authorization is listed rather than treated as "the absent case", so this
    // set enumerates every header a decrypted token can ever reach.
    expect([...MCP_ALLOWED_TOKEN_HEADERS]).toEqual(['Authorization', 'X-Tango-API-Key']);
  });

  test('isAllowedTokenHeader is exact — no case folding, no trimming', () => {
    expect(isAllowedTokenHeader('X-Tango-API-Key')).toBe(true);
    expect(isAllowedTokenHeader('Authorization')).toBe(true);
    for (const bad of ['x-tango-api-key', 'X-Tango-API-Key ', 'X-Api-Key', '', null, 42, {}]) {
      expect(isAllowedTokenHeader(bad)).toBe(false);
    }
  });

  test('ONLY the curated Tango entry uses the API-key header', () => {
    const withHeader = MCP_CATALOG.filter((e) => e.tokenHeader != null);
    expect(withHeader.map((e) => e.id)).toEqual([TANGO]);
    expect(withHeader[0]!.tokenHeader).toBe('X-Tango-API-Key');
  });

  test('every declared tokenHeader in the catalog is inside the allowlist', () => {
    for (const entry of MCP_CATALOG) {
      if (entry.tokenHeader == null) continue;
      expect(MCP_ALLOWED_TOKEN_HEADERS as readonly string[]).toContain(entry.tokenHeader);
    }
  });

  test('catalogTokenHeader resolves by catalog id and returns null for anything else', () => {
    expect(catalogTokenHeader(TANGO)).toBe('X-Tango-API-Key');
    // A custom (catalog-less) connector, an unknown id, and a real entry with
    // no declared header all get the bearer default.
    expect(catalogTokenHeader(null)).toBeNull();
    expect(catalogTokenHeader(undefined)).toBeNull();
    expect(catalogTokenHeader('')).toBeNull();
    expect(catalogTokenHeader('an-invented-connector')).toBeNull();
    expect(catalogTokenHeader('tavily')).toBeNull();
  });

  test('an arbitrary custom connector cannot choose a sensitive header', () => {
    // The mechanism, restated as a test: the ONLY input to catalogTokenHeader is
    // a catalog id. There is no path from a tenant-editable value to a header
    // name, because the function has no parameter that could carry one.
    expect(catalogTokenHeader('Cookie')).toBeNull();
    expect(catalogTokenHeader('X-Tango-API-Key')).toBeNull();
    expect(catalogTokenHeader.length).toBe(1);
  });
});

describe('P39 — the Tango entry is research-only, read-only and flag-gated', () => {
  const entry = getCatalogEntry(TANGO)!;

  test('it exists, is verified, tenant-scoped, and points at the documented endpoint', () => {
    expect(entry).toBeDefined();
    expect(entry.verified).toBe(true);
    expect(entry.defaultScope).toBe('tenant');
    expect(entry.transport).toBe('http');
    expect(entry.endpoint).toBe('https://govcon.dev/mcp');
    expect(entry.authType).toBe('token');
  });

  test('the endpoint is HTTPS — a token in the clear is not a research tradeoff', () => {
    expect(entry.endpoint?.startsWith('https://')).toBe(true);
  });

  test('exactly the five read-only tools the plan names, and every one is read-only', () => {
    expect(entry.suggestedTools.map((t) => t.name)).toEqual([
      'resolve',
      'search',
      'search_opportunities',
      'get_details',
      'fetch_api_docs',
    ]);
    expect(entry.suggestedTools.every((t) => t.readOnly === true)).toBe(true);
    // No write verb anywhere in the seeded set.
    for (const tool of entry.suggestedTools) {
      expect(tool.name).not.toMatch(/create|update|delete|send|post|write|subscribe/i);
    }
  });

  test('it is gated on its own flag, not on an existing one', () => {
    expect(entry.requiresFeature).toBe(FUNDING_OPPORTUNITIES_TANGO_MCP_FEATURE);
    expect(FUNDING_OPPORTUNITIES_TANGO_MCP_FEATURE).toBe('funding_opportunities_tango_mcp');
    // Not folded into the inbox or the Meri flag: this is the one capability in
    // the program that sends a request to a provider at READ time.
    expect(entry.requiresFeature).not.toBe('funding_opportunities');
    expect(entry.requiresFeature).not.toBe('funding_opportunities_meri_v2');
  });

  test('it is the ONLY flagged entry, so no other connector quietly acquired a gate', () => {
    expect(MCP_CATALOG.filter((e) => e.requiresFeature).map((e) => e.id)).toEqual([TANGO]);
  });

  test('its copy says research-only rather than implying a data source', () => {
    const copy = `${entry.description} ${entry.longDescription} ${entry.setupNote ?? ''}`;
    expect(copy).toMatch(/research/i);
    expect(copy).toMatch(/RESEARCH ONLY|Never a production data source/i);
    // And it says where production facts actually come from.
    expect(copy).toMatch(/Capiro’s own synchronized tables|normalized/i);
  });
});

describe('P39 — the amended scope note, and the boundary it claims', () => {
  const source = readFileSync(join(__dirname, 'meri-mcp.catalog.ts'), 'utf8');

  test('the "no government connectors" rationale is amended rather than deleted', () => {
    // The original exclusion still holds and still explains itself; the
    // amendment says why one entry is not a contradiction.
    expect(source).toContain('government / legislative / regulatory data');
    expect(source).toContain('SCOPE NOTE AMENDED');
    expect(source).toContain('RESEARCH-ONLY additive procurement');
  });

  test('deterministic Funding Opportunities code holds no MCP dependency', () => {
    // The claim the amended note makes, checked against the code it is about
    // rather than asserted in prose. Scoring, the recommendation engine, the
    // inbox and the assessment must not be able to reach a connector.
    const foDir = join(__dirname, '..', 'funding-opportunities');
    const files = [
      'opportunity-recommendation.ts',
      'funding-opportunities.service.ts',
      'funding-opportunity-inbox.service.ts',
      'government-landscape.service.ts',
      'opportunity-action-plan.ts',
      'meri-opportunity-tools.adapter.ts',
      'meri-opportunity-assessment.service.ts',
    ];
    for (const file of files) {
      const text = readFileSync(join(foDir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(text).not.toContain('meri-mcp');
      expect(text).not.toContain('McpService');
      expect(text).not.toContain('callTool');
    }
  });

  test('the catalog itself imports no product service — it is data', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('@nestjs/common');
    expect(code).not.toContain('PrismaService');
    expect(code).not.toMatch(/^import /m);
  });
});

describe('P39 — catalog invariants that already held, re-checked with the new entry', () => {
  test('ids are unique and kebab-case', () => {
    const ids = MCP_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test('every entry has a name, a description and a brand tile', () => {
    for (const entry of MCP_CATALOG) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(entry.brand.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(entry.brand.glyph.length).toBeGreaterThan(0);
    }
  });

  test('an http entry either carries an endpoint or asks the admin for one', () => {
    for (const entry of MCP_CATALOG) {
      if (entry.transport !== 'http') continue;
      expect(entry.endpoint != null || entry.requiresEndpointInput === true).toBe(true);
      if (entry.endpoint) expect(entry.endpoint.startsWith('https://')).toBe(true);
    }
  });

  test('getCatalogEntry is exact and refuses an unknown id', () => {
    expect(getCatalogEntry(TANGO)?.id).toBe(TANGO);
    expect(getCatalogEntry('nope')).toBeUndefined();
  });
});
