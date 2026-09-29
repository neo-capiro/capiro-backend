// These two bindings are already unconditional in engagement-api-iam.ts.
// Validate the real rendered task before making the legacy compatibility copy.
export const REQUIRED_PROVIDER_SECRET_KEYS = {
  OPENAI_API_KEY: 'openaiApiKeySecretArn',
  ANTHROPIC_API_KEY: 'anthropicApiKeySecretArn',
};
export function providerSecretProblems(secrets, cfg) {
  const problems = [];
  const arnPattern = /^arn:aws:secretsmanager:([a-z0-9-]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/;
  for (const [name, key] of Object.entries(REQUIRED_PROVIDER_SECRET_KEYS)) {
    const configured = cfg[key];
    const match = typeof configured === 'string' ? configured.match(arnPattern) : null;
    if (!match || match[1] !== cfg.region || match[2] !== cfg.accountId) {
      problems.push(`${name} must have an exact flat-string ARN in the configured account/region`);
      continue;
    }
    const entries = secrets.filter((entry) => (entry.Name ?? entry.name) === name);
    if (entries.length !== 1) {
      problems.push(`${name} must be injected exactly once`);
      continue;
    }
    if ((entries[0].ValueFrom ?? entries[0].valueFrom) !== configured) {
      problems.push(`${name} must use its exact configured whole-secret ARN`);
    }
  }
  return problems;
}
