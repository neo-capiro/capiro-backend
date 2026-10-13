import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Security and privacy contract for Advocacy History (product spec section
 * 28). Complements the DB-level RLS rehearsal at
 * prisma/security-rehearsals/advocacy-history-tenant-isolation.sql (which
 * proves cross-tenant/cross-client isolation against a REAL Postgres,
 * running as the actual non-superuser application role — see that file's
 * header for why role choice matters and how a superuser connection
 * produces a false-positive "leak").
 *
 * This spec covers what a real-Postgres rehearsal can't: that every
 * mutation endpoint is actually WIRED to an admin role check in the
 * NestJS layer (not just that the DB row is tenant-scoped), and that the
 * service layer never reads a private body into the advocacy tables.
 */
describe('Advocacy History security & privacy contract', () => {
  const controller = readFileSync(
    resolve(process.cwd(), 'src/clients/client-advocacy-matter.controller.ts'),
    'utf8',
  );
  const service = readFileSync(resolve(process.cwd(), 'src/clients/client-advocacy-matter.service.ts'), 'utf8');
  const outcomeApplication = readFileSync(
    resolve(process.cwd(), 'src/clients/client-profile-fill-outcome-application.ts'),
    'utf8',
  );

  /** Every @Post/@Patch decorator line in the controller, in source order,
   *  paired with whether an @Roles('user_admin') decorator immediately
   *  follows it. Reflects the controller's real decorator ORDER instead of
   *  a handful of individually-named regexes, so a newly added mutation
   *  endpoint can't silently ship unguarded and go unnoticed. */
  function mutationEndpoints(): Array<{ route: string; adminGated: boolean }> {
    const lines = controller.split('\n');
    const endpoints: Array<{ route: string; adminGated: boolean }> = [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i]!.match(/^\s*@(Post|Patch)\(([^)]*)\)/);
      if (!match) continue;
      const route = `${match[1]}(${match[2]})`;
      const adminGated = /@Roles\('user_admin'\)/.test(lines[i + 1] ?? '');
      endpoints.push({ route, adminGated });
    }
    return endpoints;
  }

  it('gates EVERY mutation endpoint (Post/Patch) behind user_admin — including the bare create endpoint', () => {
    const endpoints = mutationEndpoints();
    expect(endpoints.length).toBeGreaterThanOrEqual(15); // 1 create + 1 update + 1 merge + 3 record corrections + 4 private-evidence links + 5 public-source links
    const ungated = endpoints.filter((e) => !e.adminGated);
    expect(ungated).toEqual([]); // fails loudly with the exact unguarded route(s) if any mutation ships without @Roles('user_admin')
  });

  it('does NOT gate the two read endpoints behind user_admin — any standard_user with tenant/client access may read', () => {
    expect(controller).toMatch(/@Get\(\)[\s\S]{0,10}list\(/);
    expect(controller).toMatch(/@Get\(':matterId'\)[\s\S]{0,30}get\(/);
    // Neither read handler's own decorator block should carry a per-method
    // @Roles override — they inherit the class-level @Roles('standard_user').
    const getBlock = controller.slice(controller.indexOf('@Get()'), controller.indexOf('@Post()'));
    expect(getBlock).not.toContain("@Roles('user_admin')");
  });

  it('every mutation requires RolesGuard at the class level (defense in depth even if a method decorator were ever missing)', () => {
    expect(controller).toContain('@UseGuards(RolesGuard)');
    expect(controller).toMatch(/@UseGuards\(RolesGuard\)\s*\n\s*@Roles\('standard_user'\)\s*\n\s*export class ClientAdvocacyMatterController/);
  });

  it('never reads a mail message body (bodyText/bodyHtmlS3Key) when linking a mail thread', () => {
    expect(service).toMatch(/linkMailThread[\s\S]{0,1500}/);
    const linkMailThreadBody = service.slice(service.indexOf('async linkMailThread'), service.indexOf('async linkOutreach'));
    expect(linkMailThreadBody).not.toContain('bodyText');
    expect(linkMailThreadBody).not.toContain('bodyHtmlS3Key');
  });

  it('never reads a meeting note/debrief body (bodyCiphertext) when linking a meeting — approvedDebriefId is a reference, not content', () => {
    const linkMeetingBody = service.slice(service.indexOf('async linkMeeting'), service.indexOf('async linkMailThread'));
    expect(linkMeetingBody).not.toContain('bodyCiphertext');
    expect(linkMeetingBody).not.toContain('iv:');
    expect(linkMeetingBody).not.toContain('authTag');
    expect(linkMeetingBody).toContain('approvedDebriefId');
  });

  it('never reads a rendered outreach email body when linking an outreach record', () => {
    const linkOutreachBody = service.slice(service.indexOf('async linkOutreach'), service.indexOf('async linkStrategy'));
    expect(linkOutreachBody).not.toContain('renderedBody');
    expect(linkOutreachBody).not.toContain('renderedSubject');
    expect(linkOutreachBody).not.toContain('.body,');
  });

  it('never ingests a raw hearing transcript or testimony document body — only reference metadata', () => {
    const linkTestimonyBody = service.slice(service.indexOf('async linkTestimony'), service.indexOf('async linkFaraRecord'));
    expect(linkTestimonyBody).toContain('organization: null');
    expect(linkTestimonyBody).toContain('documentUrl: null');
  });

  it('only a SHARED meeting is linkable — a still-private meeting can never enter Advocacy History via linkMeeting', () => {
    expect(service).toMatch(/linkMeeting[\s\S]{0,800}visibility: 'shared'/);
  });

  it('a not_advocacy correction requires review (admin action) and is excluded from Matter rollups — canonical mutation gated behind human decision', () => {
    expect(service).toMatch(/markRecordNotAdvocacy[\s\S]{0,1200}not_advocacy = true/);
    expect(controller).toMatch(/@Post\('records\/:recordId\/not-advocacy'\)[\s\S]{0,60}@Roles\('user_admin'\)/);
  });

  it('Meri never auto-writes a canonical successful/partially_successful/unsuccessful outcome status without confirmOutcome or existing evidence', () => {
    expect(service).toContain('confirmOutcome');
    expect(service).toMatch(/OUTCOME_STATUSES[\s\S]{0,1600}hasOutcomeEvidence[\s\S]{0,600}confirmOutcome/);
  });

  it('outcome links always carry causationClaimed:false — never an unconditional causal claim', () => {
    expect(outcomeApplication).toContain("linkType: 'outcome_event'");
    expect(outcomeApplication).toContain('causationClaimed: false');
    expect(service).toMatch(/linkStrategy[\s\S]{0,3000}causationClaimed: false/);
  });

  it('a human correction (matter_locked) is authoritative — automatic re-clustering cannot silently overwrite it', () => {
    expect(service).toMatch(/assignMatterForRecord[\s\S]{0,2000}matter_locked/);
  });

  it('every direct-evidence and public-source link scopes its lookup to the acting client — no cross-client parameter injection', () => {
    // Each link* method must call assertClient/assertMatterBelongsToClient
    // (or getMatterIdentifiers, which folds the same check in) BEFORE
    // touching the source table, for every one of the 9 new link methods.
    const methodNames = [
      'linkMeeting', 'linkMailThread', 'linkOutreach', 'linkStrategy',
      'linkRegulatoryDocket', 'linkRegulatoryDocument', 'linkHearing', 'linkTestimony', 'linkFaraRecord',
    ];
    for (const name of methodNames) {
      const start = service.indexOf(`async ${name}(`);
      expect(start).toBeGreaterThan(-1);
      const body = service.slice(start, start + 600);
      const hasClientScopeCheck =
        body.includes('assertClient(ctx, clientId)') || body.includes('getMatterIdentifiers(ctx, clientId, matterId)');
      expect({ method: name, hasClientScopeCheck }).toEqual({ method: name, hasClientScopeCheck: true });
    }
  });
});
