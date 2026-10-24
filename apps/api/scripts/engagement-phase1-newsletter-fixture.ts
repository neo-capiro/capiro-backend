import { randomBytes } from 'node:crypto';
import {
  createNewsletterBlock,
  createNewsletterLayout,
  defaultNewsletterConfig,
} from '@capiro/shared/newsletter';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { contentHashOf } from '../src/engagement/outreach-draft.service.js';

/** Synthetic local acceptance rows only. Completed delivery + disconnected mailbox
 * cannot enqueue a provider send. The public capability needs no session bearer. */
const ids = {
  document: 'ea000000-0000-4000-8000-000000000101',
  stage: 'ea000000-0000-4000-8000-000000000102',
  connection: 'ea000000-0000-4000-8000-000000000103',
  artifact: 'ea000000-0000-4000-8000-000000000104',
  version: 'ea000000-0000-4000-8000-000000000105',
  intent: 'ea000000-0000-4000-8000-000000000106',
  delivery: 'ea000000-0000-4000-8000-000000000107',
  access: 'ea000000-0000-4000-8000-000000000108',
  unpublished: 'ea000000-0000-4000-8000-000000000109',
};
export interface NewsletterPublicFixture {
  token: string;
  unpublishedToken: string;
  survey: { block: string; answer: string };
}

export function newsletterPublicFixture(value: unknown): NewsletterPublicFixture {
  const f = value as NewsletterPublicFixture | undefined;
  if (
    !f ||
    typeof f.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(f.token) ||
    typeof f.unpublishedToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(f.unpublishedToken) ||
    f.token === f.unpublishedToken ||
    typeof f.survey?.block !== 'string' ||
    !f.survey.block.trim() ||
    f.survey.block.length > 100 ||
    typeof f.survey.answer !== 'string' ||
    !f.survey.answer.trim() ||
    f.survey.answer.length > 500
  ) {
    throw new Error('Phase 1 requires the seeded Newsletter capability and survey fixture');
  }
  return f;
}

export async function clearNewsletterPublicFixture(
  prisma: PrismaService,
  tenantId: string,
): Promise<void> {
  await prisma.withSystem(async (tx) => {
    await tx.newsletterRecipientAccess.deleteMany({
      where: { tenantId, id: { in: [ids.access, ids.unpublished] } },
    });
    await tx.outreachDelivery.deleteMany({ where: { tenantId, id: ids.delivery } });
    await tx.outreachSendIntent.deleteMany({ where: { tenantId, id: ids.intent } });
    await tx.outreachDraftVersion.deleteMany({ where: { tenantId, id: ids.version } });
    await tx.outreachDraftArtifact.deleteMany({ where: { tenantId, id: ids.artifact } });
    await tx.integrationConnection.deleteMany({ where: { tenantId, id: ids.connection } });
    await tx.$executeRaw`DELETE FROM ws_newsletter_stage WHERE id = ${ids.stage}::uuid AND tenant_id = ${tenantId}::uuid`;
    await tx.$executeRaw`DELETE FROM ws_newsletter_document WHERE id = ${ids.document}::uuid AND tenant_id = ${tenantId}::uuid`;
  });
}

export async function seedNewsletterPublicFixture(
  prisma: PrismaService,
  owner: { tenantId: string; userId: string; clerkUserId: string; outreachRecordId: string },
): Promise<NewsletterPublicFixture> {
  const { tenantId, userId, clerkUserId, outreachRecordId } = owner;
  const fixture = newsletterPublicFixture({
    token: randomBytes(32).toString('hex'),
    unpublishedToken: randomBytes(32).toString('hex'),
    survey: { block: 'phase1-survey', answer: 'Useful & clear' },
  });
  const design = createNewsletterLayout();
  design.sections[1]!.blocks = [
    createNewsletterBlock('survey', {
      id: fixture.survey.block,
      question: 'Phase 1 synthetic survey',
      options: [fixture.survey.answer, 'Other'],
    }),
  ];
  const config = JSON.stringify(defaultNewsletterConfig()),
    designJson = JSON.stringify(design);
  const subject = 'Phase 1 synthetic newsletter',
    html = '<p>Phase 1 staged newsletter archive</p>';
  const email = 'newsletter-parity@example.test',
    key = 'phase1-newsletter-public';
  await prisma.withSystem(async (tx) => {
    await tx.$executeRaw`INSERT INTO ws_newsletter_document
      (id, tenant_id, owner_id, name, config, design, updated_at)
      VALUES (${ids.document}::uuid, ${tenantId}::uuid, ${clerkUserId}, ${subject}, ${config}::jsonb, ${designJson}::jsonb, now())`;
    await tx.$executeRaw`INSERT INTO ws_newsletter_stage
      (id, tenant_id, document_id, owner_id, revision, name, config, design, html, plain_text)
      VALUES (${ids.stage}::uuid, ${tenantId}::uuid, ${ids.document}::uuid, ${clerkUserId}, 1,
        ${subject}, ${config}::jsonb, ${designJson}::jsonb, ${html}, ${subject})`;
    await tx.integrationConnection.create({
      data: {
        id: ids.connection,
        tenantId,
        createdByUserId: userId,
        provider: 'microsoft_365',
        accountEmail: email,
        status: 'needs_configuration',
      },
    });
    await tx.outreachDraftArtifact.create({
      data: {
        id: ids.artifact,
        tenantId,
        outreachRecordId,
        generationKey: key,
        recipientKey: email,
        audienceKind: 'individual',
        createdByUserId: userId,
        currentVersion: 1,
      },
    });
    await tx.outreachDraftVersion.create({
      data: {
        id: ids.version,
        tenantId,
        artifactId: ids.artifact,
        version: 1,
        subject,
        body: html,
        contentHash: contentHashOf(subject, html),
        generationStatus: 'manually_authored',
        auditStatus: 'not_required',
        approvalStatus: 'not_required',
        contentFormat: 'workspace_newsletter',
        newsletterStageId: ids.stage,
        createdByUserId: userId,
      },
    });
    await tx.outreachSendIntent.create({
      data: {
        id: ids.intent,
        tenantId,
        userId,
        outreachRecordId,
        senderConnectionId: ids.connection,
        requestKey: key,
        requestFingerprint: key,
        testMode: false,
        status: 'complete',
        appendSignature: false,
        finishedAt: new Date(),
      },
    });
    await tx.outreachDelivery.create({
      data: {
        id: ids.delivery,
        tenantId,
        sendIntentId: ids.intent,
        draftVersionId: ids.version,
        generationKey: key,
        recipientKey: email,
        recipientEnvelope: { to: [{ email }] },
        idempotencyKey: key,
        renderedSubject: subject,
        renderedBody: html,
        provider: 'microsoft_graph',
        status: 'sent',
        acceptedAt: new Date(),
      },
    });
    for (const [id, token, draftVersionId] of [
      [ids.access, fixture.token, ids.version],
      [ids.unpublished, fixture.unpublishedToken, null],
    ] as const) {
      await tx.newsletterRecipientAccess.create({
        data: {
          id,
          tenantId,
          userId,
          outreachRecordId,
          stageId: ids.stage,
          draftVersionId,
          token,
          email,
          html,
        },
      });
    }
  });
  return fixture;
}
