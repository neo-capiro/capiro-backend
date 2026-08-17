const FORBIDDEN_SERVE_ENV_PATTERNS = [
  /^DEFENSE_PROMOTER_/,
  /^DEFENSE_SNAPSHOT_ACTIVATION_/,
  /^NVIDIA_/,
  /^SAGEMAKER_MODEL_ADMIN_/,
  /^DEFENSE_PARSER_MODEL_/,
] as const;

export interface DefenseConfigValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function positiveInteger(value: string | undefined, fallback: number): number | null {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validatePoolBudget(env: NodeJS.ProcessEnv, errors: string[]): void {
  const max = positiveInteger(env.DEFENSE_DB_POOL_MAX, 12);
  if (max == null) {
    errors.push('DEFENSE_DB_POOL_MAX must be a positive integer');
    return;
  }

  if (!env.DATABASE_URL) return;
  try {
    const url = new URL(env.DATABASE_URL);
    const rawLimit = url.searchParams.get('connection_limit');
    if (!rawLimit) {
      errors.push('DATABASE_URL must set connection_limit for the defense pool budget');
      return;
    }
    const limit = positiveInteger(rawLimit, 0);
    if (limit == null) {
      errors.push('DATABASE_URL connection_limit must be a positive integer');
    } else if (limit > max) {
      errors.push(`DATABASE_URL connection_limit ${limit} exceeds DEFENSE_DB_POOL_MAX ${max}`);
    }
  } catch {
    errors.push('DATABASE_URL must be a valid PostgreSQL URL');
  }
}

function validateInternalKeys(env: NodeJS.ProcessEnv, errors: string[]): void {
  const allowlist = (env.DEFENSE_INTERNAL_SERVICE_ALLOWLIST ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  let keys: Record<string, unknown> = {};
  if (env.DEFENSE_INTERNAL_SERVICE_KEYS_JSON) {
    try {
      const parsed = JSON.parse(env.DEFENSE_INTERNAL_SERVICE_KEYS_JSON) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push('DEFENSE_INTERNAL_SERVICE_KEYS_JSON must be an object');
        return;
      }
      keys = parsed as Record<string, unknown>;
    } catch {
      errors.push('DEFENSE_INTERNAL_SERVICE_KEYS_JSON must be valid JSON');
      return;
    }
  }

  for (const caller of allowlist) {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(caller)) {
      errors.push(`invalid internal service caller name: ${caller}`);
      continue;
    }
    const secret = keys[caller];
    if (typeof secret !== 'string' || secret.length < 32) {
      errors.push(`internal service key for ${caller} must be at least 32 characters`);
    }
  }
}

export function validateDefenseServeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DefenseConfigValidationResult {
  const errors: string[] = [];

  if (!env.DATABASE_URL?.trim()) errors.push('DATABASE_URL is required');
  if (!env.CLERK_SECRET_KEY?.trim()) errors.push('CLERK_SECRET_KEY is required');

  const mode = (env.DEFENSE_CUTOVER_MODE ?? 'dark').trim();
  if (mode !== 'dark' && mode !== 'strict') {
    errors.push('DEFENSE_CUTOVER_MODE must be dark or strict');
  }

  for (const key of Object.keys(env)) {
    if (!env[key]) continue;
    if (FORBIDDEN_SERVE_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      errors.push(`${key} must not be present on the defense HTTP serve task`);
    }
  }

  validatePoolBudget(env, errors);
  validateInternalKeys(env, errors);
  return { valid: errors.length === 0, errors };
}

export function assertDefenseServeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = validateDefenseServeEnvironment(env);
  if (!result.valid) {
    throw new Error(`Invalid defense-api serve environment: ${result.errors.join('; ')}`);
  }
}
