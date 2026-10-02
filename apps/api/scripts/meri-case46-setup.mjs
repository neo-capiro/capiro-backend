import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const PREFIX = 'MERI_CASE46_SETUP_RECEIPT ';

/** Fixed internal image entry. No runtime/provider/identity injection ports. */
export async function main(argv = process.argv.slice(2)) {
  let runtime;
  try {
    if (argv.length !== 1 || !['plan', 'execute'].includes(argv[0])) throw new Error('mode');
    const raw = process.env.MERI_CASE46_SETUP_INPUT;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 6000) throw new Error('input');
    const envelope = JSON.parse(raw);
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(',') !==
        (argv[0] === 'plan' ? 'recipe' : 'expectedPlanSha256,recipe')
    )
      throw new Error('envelope');
    const {
      createCase46SetupDependencies,
    } = require('../dist/meri/meri-case46-setup-dependencies.js');
    const {
      planCase46Setup,
      executeCase46Setup,
    } = require('../dist/meri/meri-case46-setup-owner.js');
    runtime = await createCase46SetupDependencies();
    const emit = (entry) => {
      process.stdout.write(PREFIX + JSON.stringify(entry) + '\n');
    };
    if (argv[0] === 'plan') {
      emit({
        kind: 'meri-case46-setup-plan',
        version: 1,
        status: 'READY',
        plan: await planCase46Setup(runtime, envelope.recipe),
        liveAcceptance: 'NOT_RUN',
      });
    } else {
      await executeCase46Setup(runtime, envelope.recipe, envelope.expectedPlanSha256, emit);
    }
    return 0;
  } catch {
    process.stdout.write(
      PREFIX +
        JSON.stringify({
          kind: 'meri-case46-setup-failure',
          version: 1,
          status: 'RECONCILIATION_REQUIRED',
          code: 'CASE46_SETUP_REFUSED',
          liveAcceptance: 'NOT_RUN',
        }) +
        '\n',
    );
    return 1;
  } finally {
    if (runtime)
      await runtime.close().catch(() => {
        process.stdout.write(
          PREFIX +
            JSON.stringify({
              kind: 'meri-case46-setup-failure',
              version: 1,
              status: 'RECONCILIATION_REQUIRED',
              code: 'CASE46_SETUP_CLOSE_FAILED',
              liveAcceptance: 'NOT_RUN',
            }) +
            '\n',
        );
        process.exitCode = 1;
      });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main();
  process.exitCode = process.exitCode === 1 ? 1 : result;
}
