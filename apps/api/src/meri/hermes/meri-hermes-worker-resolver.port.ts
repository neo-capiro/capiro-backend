/**
 * Decoupling seam between `MeriHermesRuntimeClient` and
 * `MeriHermesWorkerLifecycleService` (Phase 1 backlog #2).
 *
 * `MeriHermesRuntimeClient.forScope()` needs to ask "what URL should I use for
 * this execution scope's worker right now" without creating a hard, circular
 * class dependency: the lifecycle service itself needs `MeriHermesRuntimeClient`
 * (its static `withEnv()` factory) to run the `/health` check during
 * provisioning. Routing the client -> lifecycle-service edge through a small
 * interface + DI token (same pattern as `MERI_HERMES_SECURITY_ENVELOPE` and
 * `MERI_HERMES_RUN_REPOSITORY` elsewhere in this module) means the client only
 * ever imports this file, never the lifecycle service class, so there is no
 * import cycle and no `emitDecoratorMetadata` circular-class-reference risk.
 */

export type MeriHermesWorkerActorType = 'user' | 'service';

/** Everything the resolver needs to find-or-provision a scope's worker. Same fields the authorization envelope already carries. */
export interface MeriHermesWorkerScopeRef {
  tenantId: string;
  executionScopeId: string;
  actorType: MeriHermesWorkerActorType;
  actorId: string;
  authorizationVersion: string;
}

export interface MeriHermesResolvedWorker {
  /** Base URL of the running worker's API server, e.g. `http://10.0.1.23:8642`. */
  url: string;
}

export interface MeriHermesWorkerResolverPort {
  resolveWorker(scope: MeriHermesWorkerScopeRef): Promise<MeriHermesResolvedWorker>;
}

export const MERI_HERMES_WORKER_RESOLVER = Symbol('MERI_HERMES_WORKER_RESOLVER');
