import { UnprocessableEntityException } from '@nestjs/common';

export interface TextArtifactCreation {
  version: 1;
  kind: 'meri_text_artifact_creation';
  operationId: string;
  tenantId: string;
  userId: string;
  clientId: string | null;
  conversationId: string;
  filename: string;
  mimeType: 'text/plain';
  sha256: string;
  byteLength: number;
}

/** Project a receipt from the actual authorized persisted row. Metadata alone
 * cannot assert a different owner, byte identity or artifact identity. */
export function readTextArtifactCreation(
  value: unknown,
  row: Omit<TextArtifactCreation, 'version' | 'kind' | 'operationId'> & { artifactId: string },
): TextArtifactCreation & { artifactId: string } {
  const receipt = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const { artifactId, ...expected } = row;
  if (
    receipt.version !== 1 || receipt.kind !== 'meri_text_artifact_creation' ||
    typeof receipt.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.operationId) ||
    Object.entries(expected).some(([key, entry]) => receipt[key] !== entry)
  ) throw new UnprocessableEntityException('The saved text artifact creation receipt does not match its owner or bytes.');
  return { ...expected, version: 1, kind: 'meri_text_artifact_creation', operationId: receipt.operationId, artifactId };
}
