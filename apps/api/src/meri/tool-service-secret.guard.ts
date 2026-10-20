// Compatibility path. The guard and its request-local service-identity proof
// live in the neutral authority owner so the application-authority module does
// not depend on the legacy Meri runtime directory. Re-exporting keeps one class
// identity for Nest DI and one WeakSet of verified requests.
export { ToolServiceSecretGuard, hasVerifiedToolServiceIdentity } from '../auth/tool-service-secret.guard.js';
