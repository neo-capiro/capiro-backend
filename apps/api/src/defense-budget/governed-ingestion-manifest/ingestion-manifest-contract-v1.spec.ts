import {
  INGESTION_MANIFEST_SCHEMA_VERSION_V1,
  assertIngestionManifestContentSha256V1,
  computeIngestionManifestContentSha256V1,
  ingestionManifestV1Schema,
  parseIngestionManifestV1,
  sealIngestionManifestV1,
} from './ingestion-manifest-contract-v1.js';

const sha = (character: string): string => character.repeat(64);
const digest = (character: string): string => `sha256:${sha(character)}`;
const uuid = (suffix: number): string =>
  `10000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;

function member(ordinal: number, character: string) {
  const sourceSha256 = sha(character);
  return {
    memberId: uuid(ordinal),
    ordinal,
    documentKey: `FY2027-ARMY-RDTE-VOL${ordinal}`,
    component: 'Army',
    agency: 'Department of the Army',
    fiscalYear: 2027,
    authorityTrack: 'presidents_budget',
    lifecycleStage: 'request',
    sourceFamily: 'rdte_budget_justification',
    exhibit: 'R-2',
    volume: `Volume ${ordinal}`,
    source: {
      officialLocator: `https://www.asafm.army.mil/budget-materials/vol-${ordinal}.pdf`,
      sourceVersion: `FY2027-v${ordinal}`,
      sha256: sourceSha256,
      byteSize: 1_000 + ordinal,
    },
    archive: {
      bucket: 'capiro-dev-defense-budget-source-archive',
      objectKey: `fy2027/army/vol-${ordinal}.pdf`,
      versionId: `3Lg-version-${ordinal}`,
      sha256: sourceSha256,
      byteSize: 1_000 + ordinal,
    },
    lifecycle: {
      cycleId: uuid(100),
      sourceDocumentId: uuid(200 + ordinal),
      observationId: uuid(300 + ordinal),
      outboxRowId: uuid(400 + ordinal),
      jobKind: 'governed_source_ingestion',
      expectedObservationState: 'ingested',
      expectedOutboxState: 'pending',
      expectedOutboxAttempts: 0,
      expectedOutboxUpdatedAt: '2026-09-20T12:00:00.000Z',
      expectedCandidateCount: 0,
      expectedActiveApprovalCount: 0,
      expectedCorrectionCount: 0,
      intendedOperation: 'drain_existing_outbox',
    },
    qualification: {
      status: 'qualified',
      formatProfile: 'rdte-r2-table-v1',
      evidenceReference: `evidence/package-e/army-vol-${ordinal}.json`,
      evidenceSha256: sha(ordinal === 1 ? 'c' : 'd'),
      qualifiedDrainImageDigest: digest('2'),
    },
    timeoutSeconds: 7_200,
    retry: {
      classification: 'transient_only',
      maxAttempts: 3,
      initialBackoffSeconds: 60,
    },
    protection: {
      baselineEvidenceReference: `evidence/package-e/army-vol-${ordinal}-baseline.json`,
      expectedApprovalWrites: 0,
      expectedCorrectionWrites: 0,
      expectedCanonicalWrites: 0,
    },
  };
}

function validPayload() {
  return {
    schemaVersion: INGESTION_MANIFEST_SCHEMA_VERSION_V1,
    operationId: uuid(900),
    owner: 'package-e-batch-operator',
    environment: 'capiro-dev',
    runtime: {
      releaseRevision: '1'.repeat(40),
      apiImageDigest: digest('1'),
      drainImageDigest: digest('2'),
      runtimeConfigReference: 'evidence/package-e/drain-runtime-config.json',
      runtimeConfigSha256: sha('3'),
      taskDefinitionArn:
        'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-defense-budget-ingestion-drain:42',
      taskDefinitionRevision: 42,
      containerName: 'ingestion-drain',
      command: ['run-defense-budget-ingestion-manifest-v1'],
    },
    members: [member(1, 'a'), member(2, 'b')],
    exclusions: [
      {
        exclusionId: uuid(800),
        documentKey: 'FY2027-AF-RDTE-VOL1',
        component: 'Air Force',
        agency: 'Department of the Air Force',
        officialLocator: 'https://www.af.mil/LinkClick.aspx?fileticket=gyv1L58eQEs%3D&portalid=1',
        sourceVersion: 'FY2027-RDTE-Volume-I',
        sourceSha256: '6666345286e16a60ed4d0d74fd788389eb7565b2225e9d51e262a9ee2a2b20fb',
        byteSize: 9_504_933,
        reasonCode: 'qualification_failed',
        reason: 'Authoritative publisher-byte binding was not established.',
        evidenceReference: 'evidence/package-e/air-force-rdte-vol-1-failure.json',
        permittedEffects: 'none',
      },
    ],
    limits: {
      maxDocuments: 5,
      activeWorkers: 1,
      maxAttemptsPerDocument: 3,
      maxElapsedSeconds: 43_200,
      defaultDocumentTimeoutSeconds: 7_200,
      resourceShape: {
        cpuUnits: 4_096,
        memoryMiB: 8_192,
        ephemeralStorageGiB: 20,
        cpuArchitecture: 'ARM64',
        operatingSystemFamily: 'LINUX',
      },
      costCeiling: {
        currency: 'USD',
        maximumAmount: '25.00',
        enforcement: 'operator_and_elapsed_limits',
      },
    },
    readiness: {
      policy: 'deferred',
      expectedOutcome: 'not_performed',
    },
    permittedEffects: {
      database: {
        manifestLedgerWrites: true,
        outboxLeaseAndDispositionWrites: true,
        documentParseJobWrites: true,
        verificationEvidenceWrites: true,
        sourceRegistrationWrites: false,
        lifecycleObservationWrites: false,
        readinessWrites: false,
        approvalWrites: false,
        correctionWrites: false,
        canonicalWrites: false,
        outOfManifestEnqueueWrites: false,
      },
      storage: {
        pinnedArchiveReads: true,
        extractionArtifactWrites: true,
        rawArchiveWrites: false,
        objectDeletes: false,
        durablePresignedUrlWrites: false,
      },
    },
  };
}

const clone = <T>(value: T): T => structuredClone(value);

describe('ingestion manifest contract v1', () => {
  it('pins the only supported production container and command', () => {
    const payload = validPayload();
    expect(() => sealIngestionManifestV1({
      ...payload,
      runtime: { ...payload.runtime, containerName: 'api' },
    })).toThrow();
    expect(() => sealIngestionManifestV1({
      ...payload,
      runtime: { ...payload.runtime, command: ['drain-defense-budget-ingestion-outbox-v1'] },
    })).toThrow();
  });
  it('seals, verifies, parses, and deeply freezes a valid exact-row manifest', () => {
    const sealed = sealIngestionManifestV1(validPayload());

    expect(sealed.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(computeIngestionManifestContentSha256V1(sealed)).toBe(sealed.contentSha256);
    expect(() => assertIngestionManifestContentSha256V1(sealed)).not.toThrow();
    expect(parseIngestionManifestV1(sealed)).toEqual(sealed);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.members)).toBe(true);
    expect(Object.isFrozen(sealed.members[0]?.archive)).toBe(true);
  });

  it('is insensitive to object-key insertion order', () => {
    const payload = validPayload();
    const { owner, operationId, schemaVersion, ...rest } = payload;
    const reordered = { ...rest, schemaVersion, operationId, owner };

    expect(computeIngestionManifestContentSha256V1(reordered)).toBe(
      computeIngestionManifestContentSha256V1(payload),
    );
  });

  it('is sensitive to member order and content mutation', () => {
    const payload = validPayload();
    const reordered = clone(payload);
    reordered.members.reverse();
    reordered.members.forEach((entry, index) => {
      entry.ordinal = index + 1;
    });
    const mutated = clone(payload);
    mutated.members[0]!.source.sha256 = sha('e');
    mutated.members[0]!.archive.sha256 = sha('e');
    const runtimeMutation = clone(payload);
    runtimeMutation.runtime.runtimeConfigSha256 = sha('4');

    const original = computeIngestionManifestContentSha256V1(payload);
    expect(computeIngestionManifestContentSha256V1(reordered)).not.toBe(original);
    expect(computeIngestionManifestContentSha256V1(mutated)).not.toBe(original);
    expect(computeIngestionManifestContentSha256V1(runtimeMutation)).not.toBe(original);
  });

  it('rejects a stale or uppercase self-hash', () => {
    const sealed = sealIngestionManifestV1(validPayload());

    expect(() => parseIngestionManifestV1({ ...sealed, contentSha256: sha('0') })).toThrow(
      /content hash mismatch/,
    );
    expect(() =>
      parseIngestionManifestV1({ ...sealed, contentSha256: sealed.contentSha256.toUpperCase() }),
    ).toThrow(/lowercase SHA-256/);
  });

  it('rejects unknown keys at the root and nested levels', () => {
    expect(() => sealIngestionManifestV1({ ...validPayload(), surprise: true })).toThrow();
    const nested = validPayload();
    Object.assign(nested.members[0]!.archive, { presignedUrl: 'https://example.test' });
    expect(() => sealIngestionManifestV1(nested)).toThrow();
  });

  it('is fail-closed to capiro-dev and a full matching revisioned task ARN', () => {
    const production = validPayload();
    production.environment = 'production';
    expect(() => sealIngestionManifestV1(production)).toThrow();

    const unrevisioned = validPayload();
    unrevisioned.runtime.taskDefinitionArn =
      'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-defense-budget-ingestion-drain';
    expect(() => sealIngestionManifestV1(unrevisioned)).toThrow(/full revisioned/);

    const mismatch = validPayload();
    mismatch.runtime.taskDefinitionRevision = 41;
    expect(() => sealIngestionManifestV1(mismatch)).toThrow(/must equal the revision/);

    const wrongEnvironmentFamily = validPayload();
    wrongEnvironmentFamily.runtime.taskDefinitionArn =
      'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-production-defense-budget-ingestion-drain:42';
    expect(() => sealIngestionManifestV1(wrongEnvironmentFamily)).toThrow(/full revisioned/);

    for (const arn of [
      'arn:aws:ecs:us-west-2:967807252336:task-definition/capiro-dev-defense-budget-ingestion-drain:42',
      'arn:aws:ecs:us-east-1:111111111111:task-definition/capiro-dev-defense-budget-ingestion-drain:42',
    ]) {
      const outsideDev = validPayload();
      outsideDev.runtime.taskDefinitionArn = arn;
      expect(() => sealIngestionManifestV1(outsideDev)).toThrow(/full revisioned/);
    }
  });

  it('rejects invalid UUIDs and non-lowercase SHA/digest identities', () => {
    const invalidUuid = validPayload();
    invalidUuid.operationId = 'not-a-uuid';
    expect(() => sealIngestionManifestV1(invalidUuid)).toThrow();

    const uppercaseSha = validPayload();
    uppercaseSha.runtime.runtimeConfigSha256 = sha('A');
    expect(() => sealIngestionManifestV1(uppercaseSha)).toThrow(/lowercase SHA-256/);

    const uppercaseDigest = validPayload();
    uppercaseDigest.runtime.drainImageDigest = digest('A');
    expect(() => sealIngestionManifestV1(uppercaseDigest)).toThrow(/lowercase/);
  });

  it.each([0, 2])('rejects activeWorkers=%s because v1 concurrency is exactly one', (value) => {
    const payload = validPayload();
    payload.limits.activeWorkers = value;
    expect(() => sealIngestionManifestV1(payload)).toThrow();
  });

  it('rejects invalid count, attempt, elapsed, timeout, resource, and cost boundaries', () => {
    const tooManyForLimit = validPayload();
    tooManyForLimit.limits.maxDocuments = 1;
    expect(() => sealIngestionManifestV1(tooManyForLimit)).toThrow(/member count/);

    const noAttempts = validPayload();
    noAttempts.limits.maxAttemptsPerDocument = 0;
    expect(() => sealIngestionManifestV1(noAttempts)).toThrow();

    const tooManyAttempts = validPayload();
    tooManyAttempts.members[0]!.retry.maxAttempts = 4;
    expect(() => sealIngestionManifestV1(tooManyAttempts)).toThrow(/attempt ceiling/);

    const timeoutOutsideWindow = validPayload();
    timeoutOutsideWindow.members[0]!.timeoutSeconds = 43_201;
    expect(() => sealIngestionManifestV1(timeoutOutsideWindow)).toThrow(/elapsed window/);

    const wrongResource = validPayload();
    wrongResource.limits.resourceShape.cpuUnits = 1_024;
    expect(() => sealIngestionManifestV1(wrongResource)).toThrow();

    const freeRun = validPayload();
    freeRun.limits.costCeiling.maximumAmount = '0.00';
    expect(() => sealIngestionManifestV1(freeRun)).toThrow(/positive USD/);
  });

  it.each([
    [
      'memberId',
      (payload: ReturnType<typeof validPayload>) => {
        payload.members[1]!.memberId = payload.members[0]!.memberId;
      },
    ],
    [
      'ordinal',
      (payload: ReturnType<typeof validPayload>) => {
        payload.members[1]!.ordinal = payload.members[0]!.ordinal;
      },
    ],
    [
      'lifecycle.outboxRowId',
      (payload: ReturnType<typeof validPayload>) => {
        payload.members[1]!.lifecycle.outboxRowId = payload.members[0]!.lifecycle.outboxRowId;
      },
    ],
    [
      'lifecycle.sourceDocumentId',
      (payload: ReturnType<typeof validPayload>) => {
        payload.members[1]!.lifecycle.sourceDocumentId =
          payload.members[0]!.lifecycle.sourceDocumentId;
      },
    ],
  ])('rejects duplicate %s values', (_field, mutate) => {
    const payload = validPayload();
    mutate(payload);
    expect(() => sealIngestionManifestV1(payload)).toThrow(/unique|ordinals/);
  });

  it('requires a fully pinned archive that matches the selected source bytes', () => {
    const missingVersion = validPayload();
    missingVersion.members[0]!.archive.versionId = 'null';
    expect(() => sealIngestionManifestV1(missingVersion)).toThrow(/immutable object version/);

    const mismatch = validPayload();
    mismatch.members[0]!.archive.byteSize += 1;
    expect(() => sealIngestionManifestV1(mismatch)).toThrow(/exactly match/);
  });

  it('requires exact runtime qualification and one remaining authorized attempt', () => {
    const wrongRuntime = validPayload();
    wrongRuntime.members[0]!.qualification.qualifiedDrainImageDigest = digest('4');
    expect(() => sealIngestionManifestV1(wrongRuntime)).toThrow(/exact manifest drain image/);

    const exhausted = validPayload();
    exhausted.members[0]!.lifecycle.expectedOutboxAttempts = 3;
    expect(() => sealIngestionManifestV1(exhausted)).toThrow(/at least one authorized attempt/);
  });

  it('rejects presigned locators and durable evidence references', () => {
    const signedSource = validPayload();
    signedSource.members[0]!.source.officialLocator =
      'https://example.test/source.pdf?X-Amz-Signature=secret';
    expect(() => sealIngestionManifestV1(signedSource)).toThrow(/presigned/);

    const signedEvidence = validPayload();
    signedEvidence.members[0]!.qualification.evidenceReference =
      'https://example.test/evidence?sig=secret';
    expect(() => sealIngestionManifestV1(signedEvidence)).toThrow(/presigned/);

    const credentialedSource = validPayload();
    credentialedSource.members[0]!.source.officialLocator =
      'https://operator:secret@example.test/source.pdf';
    expect(() => sealIngestionManifestV1(credentialedSource)).toThrow(/userinfo/);

    const credentialedEvidence = validPayload();
    credentialedEvidence.members[0]!.qualification.evidenceReference =
      'https://operator:secret@example.test/evidence.json';
    expect(() => sealIngestionManifestV1(credentialedEvidence)).toThrow(/userinfo/);

    const protocolRelativeCredentials = validPayload();
    protocolRelativeCredentials.members[0]!.qualification.evidenceReference =
      '//operator:secret@example.test/evidence.json';
    expect(() => sealIngestionManifestV1(protocolRelativeCredentials)).toThrow(/userinfo/);

    const signedRelativeReference = validPayload();
    signedRelativeReference.members[0]!.qualification.evidenceReference =
      'evidence/package-e/result.json?X-Amz-Signature=secret';
    expect(() => sealIngestionManifestV1(signedRelativeReference)).toThrow(/presigned/);
  });

  it('requires nonempty explicit exclusions and prevents selected/excluded overlap', () => {
    const none = validPayload();
    none.exclusions = [];
    expect(() => sealIngestionManifestV1(none)).toThrow();

    const overlap = validPayload();
    overlap.exclusions[0]!.sourceSha256 = overlap.members[0]!.source.sha256;
    expect(() => sealIngestionManifestV1(overlap)).toThrow(/both selected and excluded/);
  });

  it('fixes readiness to deferred/not_performed and zero approval expectations', () => {
    const readiness = validPayload();
    readiness.readiness.policy = 'global_catch_up';
    expect(() => sealIngestionManifestV1(readiness)).toThrow();

    const approval = validPayload();
    approval.members[0]!.protection.expectedApprovalWrites = 1;
    expect(() => sealIngestionManifestV1(approval)).toThrow();

    for (const field of [
      'expectedCandidateCount',
      'expectedActiveApprovalCount',
      'expectedCorrectionCount',
    ] as const) {
      const preexistingState = validPayload();
      preexistingState.members[0]!.lifecycle[field] = 1;
      expect(() => sealIngestionManifestV1(preexistingState)).toThrow();
    }
  });

  it('does not accept a hash as a substitute for complete manifest validation', () => {
    const payload = validPayload();
    const contentSha256 = computeIngestionManifestContentSha256V1(payload);
    const malformed = { ...payload, contentSha256, members: [] };

    expect(ingestionManifestV1Schema.safeParse(malformed).success).toBe(false);
  });
});
