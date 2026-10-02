import { createHash } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TextArtifactCreation } from './meri-text-artifact-receipt.js';
import { normalizeTextSpec, slugifyDocName } from './meri-docgen.helpers.js';

/** A metadata id is not action authority. Re-read the actual completed proposal
 * and compare its canonical input and durable result against the artifact row.
 * This helper neither executes nor reconciles a proposal. */
export async function assertTextArtifactCurrentProposal(
  tx: Pick<Prisma.TransactionClient, 'meriActionProposal'>,
  receipt: TextArtifactCreation & { artifactId: string },
): Promise<void> {
  if (receipt.actionProposalId === null) return;
  const row = await tx.meriActionProposal.findFirst({
    where: {
      id: receipt.actionProposalId,
      tenantId: receipt.tenantId,
      userId: receipt.userId,
      actorUserId: receipt.userId,
      conversationId: receipt.conversationId,
      tool: 'create_word',
      surface: 'chat',
      status: 'succeeded',
    },
    select: { input: true, resultSummary: true, executedAt: true },
  });
  const fail = (): never => {
    throw new UnprocessableEntityException('The saved text artifact has no matching completed action proposal.');
  };
  // An earlier pre-write failure may legitimately precede this success. The
  // completed proposal and exact effect receipt establish artifact identity;
  // attempt count does not establish how many effects occurred.
  if (!row || !row.executedAt) return fail();
  const input = row.input as Record<string, unknown>;
  const result = row.resultSummary as Record<string, unknown>;
  if (!input || !result || input.format !== 'txt' ||
      input.conversationId !== receipt.conversationId ||
      (input.clientId !== undefined && input.clientId !== receipt.clientId)) fail();
  const spec = normalizeTextSpec(input);
  const bytes = Buffer.from(spec.text, 'utf8');
  if (`${slugifyDocName(spec.title)}.txt` !== receipt.filename ||
      bytes.length !== receipt.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== receipt.sha256 ||
      result.ok !== true || result.artifactId !== receipt.artifactId ||
      result.operationId !== receipt.operationId || result.sha256 !== receipt.sha256 ||
      result.byteLength !== receipt.byteLength || result.filename !== receipt.filename) fail();
}
