// Loaded only by jest.portfolio.config.cjs, before either focused suite.
// These unrelated import/constructor dependencies must not start providers,
// generation workers or storage clients. Resource admission, encrypted-entry
// ACLs, projections, lifecycle mutations and the controller role guard stay real.
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: class {}, DeleteObjectCommand: class {}, GetObjectCommand: class {}, HeadObjectCommand: class {}, PutObjectCommand: class {} }), {virtual: true});
jest.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: jest.fn() }), {virtual: true});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }), {virtual: true});
jest.mock('mammoth', () => ({}), {virtual: true});
jest.mock('../../apps/api/src/engagement/xlsx-extract.ts', () => ({}));
jest.mock('../../apps/api/src/engagement/pptx-extract.ts', () => ({}));
jest.mock('../../apps/api/src/engagement/meeting-prep-pdf.ts', () => ({}));
jest.mock('../../apps/api/src/common/sanitize-signature.ts', () => ({ sanitizeSignatureHtml: jest.fn() }));
jest.mock('../../apps/api/src/engagement/outreach-email-renderer.ts', () => ({}));
// Unused constructor dependencies are inert; admission, projection and mutation code below is real.
jest.mock('../../apps/api/src/ai-credentials/ai-credential-resolver.service.ts', () => ({ AiCredentialResolverService: class {} }));
jest.mock('../../apps/api/src/engagement/attachment-pdf-vision.ts', () => ({ AttachmentPdfVisionReader: class {} }));
jest.mock('../../apps/api/src/engagement/generation/generation-gateway.service.ts', () => ({ GenerationGatewayService: class {} }));
jest.mock('../../apps/api/src/engagement/generation/outreach-truth.service.ts', () => ({ OutreachTruthService: class {} }));
jest.mock('../../apps/api/src/engagement/generation/evidence-source.service.ts', () => ({ EvidenceSourceService: class {} }));
jest.mock('../../apps/api/src/engagement/attachment-content.service.ts', () => ({ AttachmentContentService: class {} }));
jest.mock('../../apps/api/src/engagement/attachment-scanner.service.ts', () => ({ AttachmentScannerService: class {} }));
jest.mock('../../apps/api/src/engagement/outreach-draft.service.ts', () => ({ OutreachDraftService: class {} }));
jest.mock('../../apps/api/src/quality-telemetry/quality-telemetry-capture.service.ts', () => ({ QualityTelemetryCaptureService: class {} }));
jest.mock('../../apps/api/src/prisma/prisma.service.ts', () => ({ PrismaService: class {} }));
jest.mock('../../apps/api/src/directory/directory.service.ts', () => ({ DirectoryService: class {} }));
jest.mock('../../apps/api/src/lobby-intel/lobby-intel.service.ts', () => ({ LobbyIntelService: class {} }));
jest.mock('../../apps/api/src/federal-spending/federal-spending.service.ts', () => ({ FederalSpendingService: class {} }));
jest.mock('../../apps/api/src/engagement/client-association.service.ts', () => ({ ClientAssociationService: class {} }));
jest.mock('../../apps/api/src/engagement/engagement-ai.service.ts', () => ({ EngagementAiService: class {} }));
jest.mock('../../apps/api/src/engagement/meeting-notes-crypto.service.ts', () => ({ MeetingNotesCryptoService: class {} }));
jest.mock('../../apps/api/src/engagement/mail-sender.service.ts', () => ({ EngagementMailSender: class {} }));
jest.mock('../../apps/api/src/embeddings/client-kb.service.ts', () => ({ ClientKbService: class {} }));
jest.mock('../../apps/api/src/engagement/generation/alert-packet-client.service.ts', () => ({ AlertPacketClientService: class {} }));
jest.mock('@capiro/meriv2-core', () => ({ runAuditor: jest.fn() }), { virtual: true });
jest.mock('@nestjs/throttler', () => ({ Throttle: () => () => {} }), { virtual: true });
jest.mock('../../apps/api/src/engagement/meeting-prep-job.service.ts', () => ({ MeetingPrepJobService: class {} }));
jest.mock('../../apps/api/src/engagement/outreach-job.service.ts', () => ({ OutreachJobService: class {} }));
jest.mock('../../apps/api/src/engagement/notetaker/notetaker.service.ts', () => ({ NotetakerService: class {} }));
jest.mock('../../apps/api/src/engagement/outreach-send-intent.service.ts', () => ({ OutreachSendIntentService: class {} }));
jest.mock('../../apps/api/src/engagement/runtime/engagement-runtime-policy.service.ts', () => ({ EngagementRuntimePolicyService: class {} }));
