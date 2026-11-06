/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import type { ImpactRefreshOptions } from '../src/legiwatch-impact/impact-refresh.service.js';
import { impactAgentConfig } from '../src/legiwatch-impact/impact-agent.config.js';

export const IMPACT_REFRESH_USAGE = `Usage: refresh-legiwatch-impact [--limit 1..100] [--discovery-limit 1..1000]
Runs one bounded, durable LegiWatch client-impact refresh cycle (defaults: 10 / 100).
Requires DATABASE_URL, LEGIWATCH_AGENT_PROVIDER, LEGIWATCH_AGENT_MODEL; Anthropic also requires ANTHROPIC_API_KEY.
LEGIWATCH_IMPACT_REFRESH_TIMEOUT_MS: 60000..900000 (default 240000), at least agent timeout + 120000.
Provider budgets: LEGIWATCH_AGENT_TIMEOUT_MS / LEGIWATCH_AGENT_MAX_TURNS / LEGIWATCH_AGENT_MAX_BUDGET_USD.
Exit codes: 0 completed/help, 1 operational failure, 2 invalid arguments/configuration.
--help and configuration validation do not initialize Nest, Prisma or provider clients.`;

export function parseImpactRefreshArgs(args: string[], env: NodeJS.ProcessEnv = process.env): ImpactRefreshOptions | null {
  if (args.length === 1 && args[0] === '--help') return null;
  const values = new Map<string, number>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, raw = args[i + 1];
    if (!['--limit', '--discovery-limit'].includes(key) || values.has(key) || !raw || !/^\d+$/.test(raw))
      throw new Error('INVALID_IMPACT_REFRESH_ARGUMENTS');
    const value = Number(raw), max = key === '--limit' ? 100 : 1000;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('INVALID_IMPACT_REFRESH_ARGUMENTS');
    values.set(key, value);
  }
  if (!env.DATABASE_URL?.trim() || !env.LEGIWATCH_AGENT_PROVIDER?.trim() || !env.LEGIWATCH_AGENT_MODEL?.trim())
    throw new Error('IMPACT_REFRESH_CONFIGURATION_REQUIRED');
  try {
    const url = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
  } catch { throw new Error('IMPACT_REFRESH_CONFIGURATION_REQUIRED'); }
  const config = impactAgentConfig(env);
  if (config.runtime?.provider === 'anthropic' && !env.ANTHROPIC_API_KEY?.trim())
    throw new Error('IMPACT_REFRESH_CONFIGURATION_REQUIRED');
  const rawTimeout = env.LEGIWATCH_IMPACT_REFRESH_TIMEOUT_MS ?? '240000';
  const timeoutMs = Number(rawTimeout), analysisTimeoutMs = config.timeoutMs!;
  if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 900_000 ||
    timeoutMs < analysisTimeoutMs + 120_000) throw new Error('INVALID_IMPACT_REFRESH_TIMEOUT');
  return { limit: values.get('--limit') ?? 10, discoveryLimit: values.get('--discovery-limit') ?? 100, timeoutMs, analysisTimeoutMs };
}

type OwnedRunner = { run: (options: ImpactRefreshOptions) => Promise<unknown>; close: () => Promise<void> };
async function createRunner(): Promise<OwnedRunner> {
  // Load the smallest provider graph only after pure argument/config validation.
  const [{ NestFactory }, { Module }, { PrismaService }, { PortfolioAgentService },
    { ImpactService }, { ImpactRepository }, { ImpactEvidenceService }, { ImpactAnalysisService },
    { ImpactRefreshService }, { ImpactRefreshRepository }, { runInDbLane }] = await Promise.all([
    import('@nestjs/core'), import('@nestjs/common'), import('../src/prisma/prisma.service.js'), import('../src/clients/portfolio-agent.service.js'),
    import('../src/legiwatch-impact/impact.service.js'), import('../src/legiwatch-impact/impact.repository.js'),
    import('../src/legiwatch-impact/impact-evidence.service.js'), import('../src/legiwatch-impact/impact-analysis.service.js'),
    import('../src/legiwatch-impact/impact-refresh.service.js'), import('../src/legiwatch-impact/impact-refresh.repository.js'),
    import('../src/prisma/db-lane.js'),
  ]);
  // Own Prisma explicitly so even partial application-context initialization is cleaned up.
  const prisma = new PrismaService();
  class RefreshModule {}
  // tsx does not emit decorator metadata; explicit factories preserve injection in source CLIs.
  Module({ providers: [{ provide: PrismaService, useValue: prisma },
    { provide: PortfolioAgentService, useFactory: () => new PortfolioAgentService() },
    { provide: ImpactRepository, useFactory: () => new ImpactRepository() },
    { provide: ImpactEvidenceService, useFactory: () => new ImpactEvidenceService() },
    { provide: ImpactAnalysisService, useFactory: (agent: InstanceType<typeof PortfolioAgentService>) => new ImpactAnalysisService(agent), inject: [PortfolioAgentService] },
    { provide: ImpactService, useFactory: (repository: InstanceType<typeof ImpactRepository>, evidence: InstanceType<typeof ImpactEvidenceService>, analysis: InstanceType<typeof ImpactAnalysisService>) =>
      new ImpactService(prisma, repository, evidence, analysis), inject: [ImpactRepository, ImpactEvidenceService, ImpactAnalysisService] },
    { provide: ImpactRefreshRepository, useFactory: () => new ImpactRefreshRepository(prisma) },
    { provide: ImpactRefreshService, useFactory: (queue: InstanceType<typeof ImpactRefreshRepository>, impact: InstanceType<typeof ImpactService>, repository: InstanceType<typeof ImpactRepository>, evidence: InstanceType<typeof ImpactEvidenceService>) =>
      new ImpactRefreshService(prisma, queue, impact, repository, evidence), inject: [ImpactRefreshRepository, ImpactService, ImpactRepository, ImpactEvidenceService] },
  ] })(RefreshModule);
  try {
    const app = await NestFactory.createApplicationContext(RefreshModule, { logger: false, abortOnError: false });
    return { run: options => runInDbLane('background', () => app.get(ImpactRefreshService).run(options)), close: () => app.close() };
  } catch (error) {
    await prisma.onModuleDestroy();
    throw error;
  }
}

export async function main(args: string[], dependencies: {
  env?: NodeJS.ProcessEnv; create?: () => Promise<OwnedRunner>; log?: (message: string) => void;
} = {}): Promise<number> {
  const log = dependencies.log ?? console.log;
  let options: ImpactRefreshOptions | null;
  try { options = parseImpactRefreshArgs(args, dependencies.env ?? process.env); }
  catch { log('Usage: refresh-legiwatch-impact [--limit N] [--discovery-limit N]. Invalid arguments or configuration; use --help.'); return 2; }
  if (!options) { log(IMPACT_REFRESH_USAGE); return 0; }
  let runner: OwnedRunner | undefined;
  try {
    runner = await (dependencies.create ?? createRunner)();
    log(JSON.stringify(await runner.run(options)));
    return 0;
  } catch { log('LegiWatch impact refresh failed; pending durable work remains retryable.'); return 1; }
  finally { if (runner) await runner.close(); }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
  console.error('LegiWatch impact refresh resource cleanup failed.'); process.exitCode = 1;
});
