const WRITE_OPT_IN = '--execute-on-disposable-package6-db';
const ENV_OPT_IN = 'PACKAGE6_QUALIFICATION_ALLOW_WRITES';
const APPROVED_DATABASE = 'package6_qualification';

export class Package6QualificationSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Package6QualificationSafetyError';
  }
}

export interface Package6QualificationSafetyInput {
  databaseUrl: string | undefined;
  environmentOptIn: string | undefined;
  args: readonly string[];
}

export interface ApprovedPackage6Database {
  databaseName: typeof APPROVED_DATABASE;
}

/**
 * Package 6 qualification writes deterministic financial fixtures and probes
 * immutable-ledger triggers. Require two explicit opt-ins and an exact,
 * disposable database name. Connection details must never enter diagnostics.
 */
export function assertPackage6QualificationTarget(
  input: Package6QualificationSafetyInput,
): ApprovedPackage6Database {
  if (!input.args.includes(WRITE_OPT_IN) || input.environmentOptIn !== '1') {
    throw new Package6QualificationSafetyError(
      `Refusing Package 6 qualification writes. Both opt-ins are required: ` +
      `${WRITE_OPT_IN} and ${ENV_OPT_IN}=1. Set DATABASE_URL to a disposable database ` +
      `named exactly ${APPROVED_DATABASE}.`,
    );
  }

  if (!input.databaseUrl) {
    throw new Package6QualificationSafetyError(
      `DATABASE_URL is required and must target the disposable ${APPROVED_DATABASE} database.`,
    );
  }

  let target: URL;
  try {
    target = new URL(input.databaseUrl);
  } catch {
    throw new Package6QualificationSafetyError(
      `DATABASE_URL is not a valid URL for the disposable ${APPROVED_DATABASE} database.`,
    );
  }

  if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
    throw new Package6QualificationSafetyError(
      `Package 6 qualification requires PostgreSQL database ${APPROVED_DATABASE}.`,
    );
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  } catch {
    throw new Package6QualificationSafetyError(
      `DATABASE_URL is not a valid URL for the disposable ${APPROVED_DATABASE} database.`,
    );
  }
  if (databaseName !== APPROVED_DATABASE) {
    throw new Package6QualificationSafetyError(
      `Refusing writes: DATABASE_URL must target the disposable database named exactly ${APPROVED_DATABASE}.`,
    );
  }

  if (/(^|[.-])(prod|production)([.-]|$)/i.test(target.hostname)) {
    throw new Package6QualificationSafetyError(
      'Refusing writes to a production-looking database host. DATABASE_URL details were withheld.',
    );
  }

  return { databaseName: APPROVED_DATABASE };
}
