/**
 * Contract tests for the Phase 1 orgless browser acceptance path (M9 / NC8).
 *
 * The browser harness itself needs Chrome and a live stack, so the behavioral guarantees that
 * can be checked statically are checked here: that an organization is optional, that the
 * orgless path never fabricates organization state, that the acceptance-only token shim
 * cannot reach the product bundle, that a skipped browser proof cannot report a pass, and
 * that NC8 cannot pass without being measured.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import {
  assertSoleActiveMembership,
  type ActiveMembershipRow,
} from './engagement-phase1-sole-membership.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

const BROWSER_PARITY = 'apps/web/scripts/engagement-phase1-browser-parity.mjs';
const LOCAL_RUNNER = 'scripts/run-engagement-phase1-local.mjs';
const POST_RUNNER = 'scripts/run-engagement-phase1-post-acceptance.mjs';
const POST_VERIFIER = 'apps/web/scripts/engagement-phase1-post-acceptance.mjs';

function membership(overrides: Partial<ActiveMembershipRow> = {}): ActiveMembershipRow {
  return {
    tenantId: 'ea000000-0000-4000-8000-000000000001',
    slug: 'phase0-engagement-baseline',
    clerkOrgId: null,
    role: 'user_admin',
    ...overrides,
  };
}

/** Comments describe what the code must not do, so assertions run against code only. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Body of `createActor`, split into its organization and orgless halves, comments removed. */
function createActorSections(): { org: string; orgless: string } {
  const source = readRepoFile(BROWSER_PARITY);
  const start = source.indexOf('async function createActor');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\nasync function main(', start);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  const marker = body.indexOf('Orgless mode:');
  expect(marker).toBeGreaterThan(-1);
  return {
    org: stripComments(body.slice(0, marker)),
    orgless: stripComments(body.slice(marker)),
  };
}

describe('sole active tenant membership precondition', () => {
  it('fails when the fixture user has zero active memberships', () => {
    expect(() => assertSoleActiveMembership([])).toThrow(/found 0/);
    expect(() => assertSoleActiveMembership([])).toThrow(/cannot\s+resolve a tenant/);
  });

  it('fails when the fixture user has multiple active memberships', () => {
    const rows = [membership(), membership({ slug: 'second-tenant' })];
    expect(() => assertSoleActiveMembership(rows)).toThrow(/found 2/);
    expect(() => assertSoleActiveMembership(rows)).toThrow(/fallback does not fire/);
    expect(() => assertSoleActiveMembership(rows)).toThrow(/second-tenant/);
  });

  it('passes with exactly one active membership and never requires clerk_org_id', () => {
    const result = assertSoleActiveMembership([membership()]);
    expect(result.activeMemberships).toBe(1);
    expect(result.tenantSlug).toBe('phase0-engagement-baseline');
    expect(result.clerkOrgIdRequired).toBe(false);
    expect(result.tenantClerkOrgIdPresent).toBe(false);
  });

  it('still passes when the sole tenant happens to carry a clerk_org_id', () => {
    const result = assertSoleActiveMembership([membership({ clerkOrgId: 'org_live_123' })]);
    expect(result.activeMemberships).toBe(1);
    expect(result.tenantClerkOrgIdPresent).toBe(true);
    expect(result.clerkOrgIdRequired).toBe(false);
  });
});

describe('organization id is optional for browser acceptance', () => {
  it('resolves the org id through an optional lookup, not a required one', () => {
    const source = readRepoFile(BROWSER_PARITY);
    expect(source).toMatch(/const ORG_ID = optionalAny\(/);
    expect(source).not.toMatch(/const ORG_ID = requiredAny\(/);
  });

  it('derives an explicit orgless mode from the absent org id', () => {
    expect(readRepoFile(BROWSER_PARITY)).toMatch(/const ORGLESS = !ORG_ID;/);
  });

  it('keeps the session cookie required', () => {
    expect(readRepoFile(BROWSER_PARITY)).toMatch(/const COOKIE = requiredAny\(/);
  });
});

describe('orgless mode never fabricates organization state', () => {
  it('never calls setActive on the orgless path', () => {
    const { org, orgless } = createActorSections();
    expect(orgless).not.toContain('setActive');
    // The organization-based path is preserved unchanged.
    expect(org).toContain('setActive');
  });

  it('never waits for Clerk.organization on the orgless path', () => {
    const { orgless } = createActorSections();
    expect(orgless).not.toContain('organization?.id ===');
  });

  it('asserts the session genuinely has no active organization', () => {
    const { orgless } = createActorSections();
    expect(orgless).toMatch(/requires a session with no active organization/);
  });

  it('installs the token shim for every new document so navigations keep it', () => {
    const { orgless } = createActorSections();
    expect(orgless).toContain('Page.addScriptToEvaluateOnNewDocument');
  });
});

describe('orgless mode uses the default session token', () => {
  it('requests a template-free token for the harness bearer file', () => {
    const source = readRepoFile(BROWSER_PARITY);
    const block = source.slice(
      source.indexOf('const bearerToken = await page.evaluate('),
      source.indexOf('await writeFile(TOKEN_FILE'),
    );
    expect(block).toContain('ORGLESS');
    expect(block).toMatch(/getToken\(\)/);
    // The organization path still uses the capiro template.
    expect(block).toContain("template: 'capiro'");
    // Orgless branch of the ternary comes first, so the default call precedes the template.
    expect(block.indexOf('getToken()')).toBeLessThan(block.indexOf("template: 'capiro'"));
  });

  it('delegates the capiro template to the default token only when no org is active', () => {
    const source = readRepoFile(BROWSER_PARITY);
    const shim = source.slice(
      source.indexOf('function orglessTokenShimSource()'),
      source.indexOf('function requestHost('),
    );
    expect(shim).toMatch(/options\.template === 'capiro'/);
    expect(shim).toMatch(/hasOrg/);
    expect(shim).toMatch(/return original\(\);/);
    // Every other invocation keeps original behavior.
    expect(shim).toMatch(/return original\(options\);/);
  });
});

describe('the acceptance token shim cannot reach the product bundle', () => {
  it('is absent from every file under apps/web/src', () => {
    const root = path.join(REPO_ROOT, 'apps/web/src');
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) continue;
        const source = readFileSync(full, 'utf8');
        if (
          source.includes('__capiroAcceptanceOrglessTokenShim') ||
          source.includes('__capiroAcceptanceShimmed')
        ) {
          offenders.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('lives only in the acceptance harness', () => {
    expect(readRepoFile(BROWSER_PARITY)).toContain('__capiroAcceptanceOrglessTokenShim');
  });
});

describe('a skipped browser proof cannot report a passing M9 result', () => {
  it.each([LOCAL_RUNNER, POST_RUNNER])(
    '%s writes a skipped marker with unmeasured claims',
    (relative) => {
      const source = readRepoFile(relative);
      expect(source).toContain('ENGAGEMENT_PHASE1_BROWSER_SKIPPED');
      expect(source).toContain('browserProofPerformed: false');
      expect(source).not.toContain('everySurfaceLoaded: true');
      expect(source).not.toContain('everySurfaceCalledMainApi: true');
      expect(source).not.toContain('shadowRequests: []');
    },
  );

  it('derives browserProofPerformed from the observed marker', () => {
    const source = readRepoFile(POST_VERIFIER);
    expect(source).toMatch(
      /const browserProofPerformed\s*=\s*\n?\s*browserEvidence\.marker === 'ENGAGEMENT_PHASE1_BROWSER_COMPLETE'/,
    );
    expect(source).toContain('browserResponsesVerified: browserProofPerformed');
    expect(source).not.toContain('browserResponsesVerified: true');
  });

  it('rejects an unrecognized browser marker instead of treating it as a pass', () => {
    expect(readRepoFile(POST_VERIFIER)).toMatch(/Unrecognized browser evidence marker/);
  });

  it('stops the authoritative closeout when the browser proof was not performed', () => {
    const source = readRepoFile('scripts/verify-engagement-phase1-local.mjs');
    expect(source).toContain('finalSummary.browserProofPerformed === false');
    expect(source).toMatch(/INCOMPLETE \(not failed\)/);
  });
});

describe('an unusable session cookie fails fast and self-diagnoses', () => {
  function cookieCheckSource(): string {
    const source = readRepoFile(BROWSER_PARITY);
    return source.slice(
      source.indexOf('function assertSessionCookieUsable('),
      source.indexOf('function orglessTokenShimSource('),
    );
  }

  it('runs the precheck before spending a browser launch', () => {
    const source = readRepoFile(BROWSER_PARITY);
    const precheck = source.indexOf('const cookieState = assertSessionCookieUsable(COOKIE)');
    const launch = source.indexOf('chromeLauncher.launch(');
    expect(precheck).toBeGreaterThan(-1);
    expect(precheck).toBeLessThan(launch);
  });

  it('accepts either the long-lived client cookie or an unexpired session JWT', () => {
    const check = cookieCheckSource();
    expect(check).toContain('__client=');
    expect(check).toContain('__clerk_db_jwt=');
    expect(check).toContain('__session=');
    expect(check).toMatch(/!clientCookie && sessionState !== 'valid'/);
  });

  it('treats an expired session cookie as unusable', () => {
    expect(cookieCheckSource()).toMatch(/expired at/);
  });

  it('never interpolates the cookie value into diagnostics', () => {
    const check = cookieCheckSource();
    // Names and a derived state are reported; the raw value never is.
    expect(check).toContain('names.join');
    expect(check).not.toMatch(/\$\{value\}/);
    expect(check).not.toMatch(/\$\{header\}/);
    expect(check).not.toMatch(/console\.log\(.*value/);
  });

  it('captures Clerk page state when the session never appears', () => {
    const source = readRepoFile(BROWSER_PARITY);
    expect(source).toContain('clerkPresent: Boolean(window.Clerk)');
    expect(source).toContain('hasUser: Boolean(window.Clerk?.user)');
    expect(source).toMatch(/Clerk session never became available/);
  });
});

describe('NC8 cannot pass without being measured', () => {
  it('reports unmeasured when no browser ran', () => {
    const source = readRepoFile(LOCAL_RUNNER);
    const control = source.slice(
      source.indexOf('async function nc8Control('),
      source.indexOf('async function writeNegativeControlEvidence('),
    );
    expect(control).toContain('browser.browserProofPerformed === false');
    expect(control).toContain('measured: false');
    expect(control).toContain('passed: null');
  });

  it('derives measured and passed from the rehearsal result, never hardcoded', () => {
    const source = readRepoFile(LOCAL_RUNNER);
    const control = source.slice(
      source.indexOf('async function nc8Control('),
      source.indexOf('async function writeNegativeControlEvidence('),
    );
    expect(control).toContain('measured: rehearsal?.measured === true');
    expect(control).toContain('passed: cleanRun && rehearsal?.passed === true');
  });

  it('fails the run when the injected violation is not rejected', () => {
    const source = readRepoFile(LOCAL_RUNNER);
    const rehearsal = source.slice(
      source.indexOf('async function rehearseNc8('),
      source.indexOf('async function nc8Control('),
    );
    expect(rehearsal).toContain('ENGAGEMENT_PHASE1_NC8_REHEARSAL');
    expect(rehearsal).toMatch(/if \(!rejected\)/);
    expect(rehearsal).toMatch(/failed to prove shadow-routing detection/);
    // Derived from the observed exit code, not asserted.
    expect(rehearsal).toContain('verifierExitCode: code');
  });

  it('treats an undetected injection inside the verifier as a failure', () => {
    const source = readRepoFile(BROWSER_PARITY);
    expect(source).toMatch(/NC8 rehearsal emitted shadow-service traffic but the routing/);
  });

  it('keeps the rehearsal out of normal runs and out of the passing evidence directory', () => {
    const browser = readRepoFile(BROWSER_PARITY);
    expect(browser).toMatch(
      /NC8_REHEARSAL = process\.env\.ENGAGEMENT_PHASE1_NC8_REHEARSAL === '1'/,
    );
    const runner = readRepoFile(LOCAL_RUNNER);
    expect(runner).toContain("path.join(EVIDENCE, 'nc8-rehearsal')");
  });
});
