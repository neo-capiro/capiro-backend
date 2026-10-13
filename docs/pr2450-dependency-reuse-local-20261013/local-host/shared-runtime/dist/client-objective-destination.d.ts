/** Canonical Core Objective revision authority, reused inside each owner's transaction. */
export interface ClientObjectiveDestinationInput {
    clientId: string;
    objectiveId: string;
    objectiveVersion: number;
}
export interface ClientObjectiveRevisionBinding extends ClientObjectiveDestinationInput {
    objectiveRevisionId: string;
}
export interface ClientObjectiveDestinationActor {
    tenantId: string;
    clerkUserId: string;
    /** Core callers additionally pin their already-resolved UUID; Clerk subjects are never cast. */
    userId?: string;
}
export interface ClientObjectiveDestinationTx {
    $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
export declare class ClientObjectiveDestinationError extends Error {
    readonly code: 'OBJECTIVE_DESTINATION_INVALID' | 'OBJECTIVE_DESTINATION_NOT_FOUND' | 'OBJECTIVE_VERSION_CONFLICT';
    constructor(code: 'OBJECTIVE_DESTINATION_INVALID' | 'OBJECTIVE_DESTINATION_NOT_FOUND' | 'OBJECTIVE_VERSION_CONFLICT');
}
export declare function normalizeClientObjectiveDestination(input: ClientObjectiveDestinationInput): ClientObjectiveDestinationInput;
export declare function requireClientObjectiveDestinationRevision(tx: ClientObjectiveDestinationTx, actor: ClientObjectiveDestinationActor, input: ClientObjectiveDestinationInput): Promise<ClientObjectiveRevisionBinding>;
//# sourceMappingURL=client-objective-destination.d.ts.map