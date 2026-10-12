import { BadRequestException, HttpStatus } from '@nestjs/common';

interface AttachmentSelection {
  id: string;
  clientId: string | null;
}

/** Validate the complete selection before the caller can fetch any file bytes.
 * Parent and hearing authority stay with their existing owning implementations. */
export async function assertOutboundAttachmentAccess<Row extends AttachmentSelection>(
  requestedIds: readonly string[],
  rows: readonly Row[],
  expectedClientId: string | null,
  access: {
    parents: (row: Row) => Promise<void>;
    usable: (row: Row) => void;
    distribute: (row: Row) => Promise<void>;
  },
): Promise<void> {
  const foundIds = new Set(rows.map((row) => row.id));
  const missing = requestedIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    // Missing, superseded and forbidden files are intentionally indistinguishable.
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'ATTACHMENT_MISSING',
      message: `${missing.length} attachment(s) selected for this send are no longer available. Remove them and try again.`,
    });
  }
  if (rows.some((row) => row.clientId && row.clientId !== expectedClientId)) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'ATTACHMENT_CLIENT_MISMATCH',
      message:
        'An attachment selected for this send belongs to a different client. Remove it and review the selection.',
    });
  }
  for (const row of rows) {
    await access.parents(row);
    access.usable(row);
    await access.distribute(row);
  }
}
