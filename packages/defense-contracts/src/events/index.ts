export type DefenseEventName =
  | 'defense.ingestion.completed.v1'
  | 'defense.ingestion.failed.v1'
  | 'defense.verification.completed.v1'
  | 'defense.snapshot.created.v1'
  | 'defense.snapshot.activated.v1'
  | 'defense.program-element.changed.v1'
  | 'defense.delta.derived.v1'
  | 'defense.promotion.completed.v1'
  | 'defense.promotion.rolled-back.v1';

export interface DefenseEventEnvelope<TName extends DefenseEventName, TPayload> {
  readonly id: string;
  readonly name: TName;
  readonly version: 1;
  readonly occurredAt: string;
  readonly producer: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly tenantId?: string;
  readonly payload: TPayload;
}

export interface DefenseSnapshotEventPayload {
  readonly snapshotId: string;
  readonly contentSha256: string;
  readonly activatedAt?: string;
  readonly sourceFamilies: readonly string[];
}

export interface DefenseProgramElementChangedPayload {
  readonly peCode: string;
  readonly snapshotId: string;
  readonly changedFields: readonly string[];
  readonly fiscalYears: readonly number[];
}

export interface DefenseVerificationCompletedPayload {
  readonly snapshotId: string;
  readonly status: 'passed' | 'failed' | 'blocked';
  readonly blockingFindings: number;
  readonly warningFindings: number;
  readonly reportLocation?: string;
}

export interface DefenseIngestionCompletedPayload {
  readonly jobId: string;
  readonly sourceDocumentId: string;
  readonly parserVersion: string;
  readonly acceptedRecords: number;
  readonly quarantinedRecords: number;
}
