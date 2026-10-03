import { isDeepStrictEqual } from 'node:util';

// This pure comparison is a prepared expectation, never live release authority.
// readCase01BuildAuthority and native admission still reread the actual release.
const exactDeployment = {
  "apiSha": "5b086a6b47ffce5aa1b93bfe38f9c7b96e297642",
  "orchestratorSha": "fb17c7ebfa010ce964919068f61830cb78ca620d",
  "builds": {
    "api": {
      "service": "api",
      "sourceSha": "5b086a6b47ffce5aa1b93bfe38f9c7b96e297642",
      "imageDigest": "sha256:d20110a114ef51a7db3d352321f411a2f51cc8b1877f9ccec6d1f35d7701c8cd",
      "buildId": "capiro-build-web-dev:01196b56-83c6-47a9-97a1-11004413a7ee",
      "buildspecSha256": "c92763d03d141e59d18485c4d9f6ac3958392ff18e0bbaf501dd116cc39f4c3c"
    },
    "meriv2-orchestrator": {
      "service": "meriv2-orchestrator",
      "sourceSha": "fb17c7ebfa010ce964919068f61830cb78ca620d",
      "imageDigest": "sha256:2b3ac021d0e5149478bb480c3ed572151bd8b03e08b2a74fd1227af829a06436",
      "buildId": "capiro-build-web-dev:d6486a5b-9ab2-4410-bba0-3a5afb2f0b2c",
      "buildspecSha256": "330e33036707a5ce89befa560312635f7261a88d6eb18d73e7cb73af9093c332"
    }
  }
};

export function assertCase01PreparedDeployment(deployment) {
  if (!isDeepStrictEqual(deployment, exactDeployment)) {
    const error = new Error('CASE01_EXACT_DEPLOYMENT_REQUIRED');
    error.safeCode = 'CASE01_EXACT_DEPLOYMENT_REQUIRED';
    throw error;
  }
}

export function case01SubmissionObservation(summary) {
  const count = summary?.outcome?.synthesisSubmissionCount;
  if (Number.isSafeInteger(count) && count >= 0 && count <= 1)
    return { turnsSent: count, turnsSentStatus: 'OBSERVED_NATIVE_OUTCOME' };
  return summary?.executionAttempted === true
    ? { turnsSent: null, turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT' }
    : { turnsSent: 0, turnsSentStatus: 'NOT_ATTEMPTED' };
}
