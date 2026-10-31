import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The client Overview writes through `apps/web` against these exact Core
 * operations. A live QA pass found eight of them answering 404 while two
 * reached validation, because the web build and the Core build disagreed about
 * methods and paths. This contract pins the Core side so a drift shows up here
 * instead of as an "action unavailable" toast in the product.
 */
const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

describe('client Overview write surface', () => {
  const clients = source('src/clients/clients.controller.ts');
  const team = source('src/clients/client-team.controller.ts');
  const facilities = source('src/clients/client-facilities.controller.ts');
  const activity = source('src/clients/client-activity.controller.ts');
  const objectives = source('src/clients/objectives/objectives.controller.ts');
  const owners = source('src/clients/client-ordered-owner.controller.ts');
  const commands = source(
    'src/clients/activity-commands/activity-command.controller.ts',
  );

  it('declares every operation the Overview writes through', () => {
    // Profile notes and the whole-profile save live on the clients controller.
    expect(clients).toContain("@Put(':id/profile-notes')");
    expect(clients).toContain("@Put(':id')");

    // Team roster.
    expect(team).toContain("@Controller('clients/:clientId/team')");
    expect(team).toContain('@Post()');
    expect(team).toContain('@Delete()');

    // Facilities.
    expect(facilities).toContain(
      "@Controller('clients/:clientId/facilities')",
    );
    expect(facilities).toContain('@Post()');
    expect(facilities).toContain("@Patch(':id')");
    expect(facilities).toContain("@Delete(':id')");

    // Activity (settle / edit).
    expect(activity).toContain("@Controller('clients/:clientId/activity')");
    expect(activity).toContain("@Patch(':id')");

    // Objectives.
    expect(objectives).toContain(
      "@Controller('clients/:clientId/objectives')",
    );
    expect(objectives).toContain('@Post()');

    // Ordered account owners.
    expect(owners).toContain(
      "@Controller('clients/:clientId/account-owners')",
    );
    expect(owners).toContain('@Put()');

    // Quick log commands.
    expect(commands).toContain(
      "@Controller('clients/:clientId/activity-commands')",
    );
    expect(commands).toContain('@Post()');
  });

  it('declares the pulse read before the :id route so metrics is not read as a client id', () => {
    const decoratorLines = clients
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('@Get('));
    const metricsAt = decoratorLines.indexOf("@Get('metrics')");
    const idAt = decoratorLines.indexOf("@Get(':id')");
    expect(metricsAt).toBeGreaterThan(-1);
    expect(idAt).toBeGreaterThan(-1);
    expect(metricsAt).toBeLessThan(idAt);
  });
});
