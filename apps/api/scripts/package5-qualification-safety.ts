const WRITE_OPT_IN = '--execute-on-disposable-package5-db';
const ENV_OPT_IN = 'PACKAGE5_QUALIFICATION_ALLOW_WRITES';
const APPROVED_DATABASE = 'package5_qualification';

export class Package5QualificationSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Package5QualificationSafetyError';
  }
}

export interface Package5QualificationSafetyInput {
  databaseUrl: string | undefined;
  environmentOptIn: string | undefined;
  args: readonly string[];
}

export interface ApprovedPackage5Database {
  databaseName: typeof APPROVED_DATABASE;
}

/**
 * Qualification inserts fixtures and deliberately probes the immutable-table
 * trigger. Require both an explicit command-line acknowledgement and an
 * environment opt-in, then verify the parsed database name exactly. Never put
 * the connection string (or URL credentials) in an error or log message.
 */
export function assertPackage5QualificationTarget(
  input: Package5QualificationSafetyInput,
): ApprovedPackage5Database {
  if (!input.args.includes(WRITE_OPT_IN) || input.environmentOptIn !== '1') {
    throw new Package5QualificationSafetyError(
      `Refusing Package 5 qualification writes. Both opt-ins are required: ` +
      `${WRITE_OPT_IN} and ${ENV_OPT_IN}=1. Set DATABASE_URL to a disposable database ` +
      `named exactly ${APPROVED_DATABASE}. Example: ` +
      `$env:${ENV_OPT_IN}='1'; pnpm --filter @capiro/api qualify:package5-program-acquisition ${WRITE_OPT_IN}`,
    );
  }

  if (!input.databaseUrl) {
    throw new Package5QualificationSafetyError(`DATABASE_URL is required and must target the disposable ${APPROVED_DATABASE} database.`);
  }

  let target: URL;
  try {
    target = new URL(input.databaseUrl);
  } catch {
    throw new Package5QualificationSafetyError(`DATABASE_URL is not a valid URL for the disposable ${APPROVED_DATABASE} database.`);
  }

  if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
    throw new Package5QualificationSafetyError(`Package 5 qualification requires PostgreSQL database ${APPROVED_DATABASE}.`);
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  } catch {
    throw new Package5QualificationSafetyError(`DATABASE_URL is not a valid URL for the disposable ${APPROVED_DATABASE} database.`);
  }
  if (databaseName !== APPROVED_DATABASE) {
    throw new Package5QualificationSafetyError(`Refusing writes: DATABASE_URL must target the disposable database named exactly ${APPROVED_DATABASE}.`);
  }

  // Obvious production hostnames are rejected even if somebody accidentally
  // provisioned a production database with the qualification database name.
  if (/(^|[.-])(prod|production)([.-]|$)/i.test(target.hostname)) {
    throw new Package5QualificationSafetyError('Refusing writes to a production-looking database host. DATABASE_URL details were withheld.');
  }

  return { databaseName: APPROVED_DATABASE };
}
