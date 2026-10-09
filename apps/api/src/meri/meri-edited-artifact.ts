/**
 * Meri edited-document version helpers (Lane A / A3).
 *
 * `MeriService.createArtifactVersion` persists an edited ordinary artifact. For
 * a generated document the ordinary branch must rebuild the native bytes and a
 * fresh byte receipt: `MeriToolsService.getDocumentArtifact` refuses an artifact
 * whose `metadata.docFormat` is missing/unknown and rejects a partial/borrowed
 * receipt. This module performs that one step - re-render the edited content
 * through the existing normalizers, the injected `renderStoredDocument` callback
 * and the integrity guard - and emits a FRESH receipt. It never reads or copies
 * the parent receipt and never writes anything.
 *
 * Pure over a small render callback and the existing Capiro helpers; no new
 * framework, module registration or schema changes.
 */
import { randomUUID } from 'node:crypto';
import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import {
  mimeForFormat,
  normalizeExcelSpec,
  normalizePptxSpec,
  normalizeTextSpec,
  normalizeWordSpec,
  slugifyDocName,
  type DocFormat,
  type PptxSpec,
  type WordSpec,
} from './meri-docgen.helpers.js';
import {
  MAX_DOCUMENT_ARTIFACT_BYTES,
  sha256Bytes,
  validateDocumentArtifactBytes,
} from './meri-artifact-integrity.js';
import { MeriPdfRenderError } from './meri-docgen-pdf.js';
import type { TextArtifactCreation } from './meri-text-artifact-receipt.js';

const VALID_FORMATS: readonly DocFormat[] = ['docx', 'pdf', 'xlsx', 'pptx', 'txt'];

/**
 * The existing `MeriToolsService.renderStoredDocument` callback. Re-renders a
 * stored office spec through the real generators; `txt` is rebuilt directly
 * from its text bytes by this module (the callback intentionally rejects txt).
 */
export type EditedDocumentRender = (format: DocFormat, specJson: string) => Promise<Buffer>;

/** Parent artifact facts the ordinary branch already loads before editing. */
export interface EditedDocumentParent {
  /** Parent title; the new version reuses it (createArtifactVersion copies it). */
  title: string;
  /** Parent `clio_artifacts.metadata`, as stored by `createDocument`. */
  metadata: Record<string, unknown> | null;
}

/** Row ownership the new version will be created under (needed for txt receipts). */
export interface EditedDocumentRowContext {
  tenantId: string;
  userId: string;
  clientId: string | null;
  conversationId: string;
}

export interface PreparedEditedDocumentVersion {
  /** Format of the rebuilt native bytes (always the parent's native format). */
  format: DocFormat;
  /** Canonical stored `bodyText` for the new version (JSON spec, or plain text). */
  bodyText: string;
  /** Safe download filename for the new version. */
  filename: string;
  mimeType: string;
  sha256: string;
  byteLength: number;
  /**
   * Byte-receipt metadata for the new version. The caller merges this with
   * `{ versionOf: parent.id, editedBy: ctx.userId }`; this helper deliberately
   * does not own those provenance fields. Every receipt value here is rebuilt
   * from the edited bytes - never inherited from the parent.
   */
  metadata: {
    docFormat: DocFormat;
    mimeType: string;
    filename: string;
    generatedAt: string;
    documentBytesBase64: string;
    documentSha256: string;
    documentByteLength: number;
    documentByteFormat: DocFormat;
    documentByteAuthority: 'persisted_at_creation_v1';
    /** Fresh creation receipt for text artifacts (required by getDocumentArtifact). */
    textCreation?: TextArtifactCreation;
  };
}

/**
 * Edited body text ceiling, aligned with the artifact byte authority. Office
 * specs embed resolved chart PNGs as base64, so this is a serialized-spec bound,
 * not a prose bound. Reject before any generator runs.
 */
export const MAX_EDITED_BODY_TEXT_CHARS = MAX_DOCUMENT_ARTIFACT_BYTES;

/** The parent's native generated format, or null when it is not generated. */
export function generatedDocumentFormat(
  metadata: Record<string, unknown> | null,
): DocFormat | null {
  const candidate = metadata?.docFormat;
  return typeof candidate === 'string' && VALID_FORMATS.includes(candidate as DocFormat)
    ? (candidate as DocFormat)
    : null;
}

/** Resolve the parent's native format the same way the download boundary does. */
export function resolveEditedParentFormat(metadata: Record<string, unknown> | null): DocFormat {
  const format = generatedDocumentFormat(metadata);
  if (!format) {
    throw new BadRequestException('This artifact is not a generated document that can be versioned.');
  }
  return format;
}

/** The artifact kinds `MeriToolsService.createDocument` mints for generated documents. */
const KNOWN_GENERATED_KINDS: readonly string[] = [
  'text_document',
  'pdf_document',
  'word_document',
  'excel_workbook',
  'powerpoint_deck',
];

/** True when the row's kind identifies a generated document even if metadata is malformed. */
export function isKnownGeneratedKind(kind: unknown): boolean {
  return typeof kind === 'string' && KNOWN_GENERATED_KINDS.includes(kind);
}

/**
 * Byte-receipt / native markers `createDocument` stamps on generated artifacts.
 * Their presence means the artifact claims to be generated even when its
 * `docFormat` is missing or unsupported, so it must fail closed rather than be
 * silently re-versioned as legacy text.
 */
const GENERATED_METADATA_MARKERS: readonly string[] = [
  'docFormat',
  'documentByteFormat',
  'documentByteAuthority',
  'documentBytesBase64',
  'documentSha256',
  'documentByteLength',
  'textCreation',
];

/** True when metadata carries any generated-document receipt marker. */
export function hasGeneratedMarkers(metadata: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  return GENERATED_METADATA_MARKERS.some(
    (key) => metadata[key] !== undefined && metadata[key] !== null,
  );
}

/**
 * Sanitized generation/integrity failure for the edited-artifact branch. Mirrors
 * the existing `MERI_DOCUMENT_GENERATION_FAILED` contract used by
 * `createDocument`: the caller learns a safe reason, never a raw generator error.
 */
function editedGenerationFailure(format: DocFormat, error: unknown): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'MERI_DOCUMENT_GENERATION_FAILED',
    format,
    reason: error instanceof MeriPdfRenderError ? error.reason : 'render_failed',
    message:
      error instanceof MeriPdfRenderError
        ? `${error.message} Nothing was saved. Adjust the document and try again.`
        : 'The edited document could not be generated. Nothing was saved. Try again.',
  });
}

/** Filesystem-safe filename derived from the title and rebuilt format. */
export function safeEditedDocumentFilename(title: string, format: DocFormat): string {
  return `${slugifyDocName(title)}.${format}`.replace(/[\r\n"\\]/g, '_');
}

function assertEditableBodyText(bodyText: unknown): string {
  if (typeof bodyText !== 'string' || bodyText.length === 0) {
    throw new BadRequestException('The edited document text is empty.');
  }
  if (bodyText.length > MAX_EDITED_BODY_TEXT_CHARS) {
    throw new BadRequestException('The edited document is too large.');
  }
  return bodyText;
}

function parseOfficeSpec(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    // Office documents store a structured JSON spec; a plain-text edit of an
    // office artifact cannot be re-rendered without inventing structure.
    throw new BadRequestException(
      'A document edit must provide the saved document structure, not plain text.',
    );
  }
}

/**
 * Embedded chart images are resolved to PNG payloads at creation time and stored
 * on the spec; the download callback renders only `images`. A reference left in
 * `imageArtifactIds` cannot be resolved here without the private chart resolver,
 * so it is rejected rather than silently dropped.
 */
function assertImagesResolved(spec: WordSpec | PptxSpec): void {
  const blocks = 'sections' in spec ? spec.sections : spec.slides;
  for (const block of blocks) {
    if (block.imageArtifactIds.length > 0) {
      throw new BadRequestException(
        'This edit references charts that cannot be resolved in a new version. Resolve the charts first.',
      );
    }
  }
}

/**
 * Rebuild the native bytes for an edited ordinary document version and return a
 * fresh byte receipt. Uses only the existing normalizers, the injected render
 * callback and the integrity guard. Throws (fail-closed) rather than returning
 * stale/partial data or fabricating an empty document.
 */
export async function buildEditedDocumentVersion(
  parent: EditedDocumentParent,
  editedBodyText: string,
  render: EditedDocumentRender,
  rowContext?: EditedDocumentRowContext,
): Promise<PreparedEditedDocumentVersion> {
  const format = resolveEditedParentFormat(parent.metadata);
  const text = assertEditableBodyText(editedBodyText);
  const title = typeof parent.title === 'string' && parent.title.trim() ? parent.title : 'Document';

  let generatedBuffer: Buffer;
  let storedBodyText = '';
  let textCreation: TextArtifactCreation | undefined;

  if (format === 'txt') {
    let spec: { title: string; text: string };
    try {
      spec = normalizeTextSpec({ title, text });
    } catch {
      throw new BadRequestException('The edited text is not a valid text document.');
    }
    generatedBuffer = Buffer.from(spec.text, 'utf8');
    storedBodyText = spec.text;
  } else {
    const parsed = parseOfficeSpec(text);
    try {
      if (format === 'docx' || format === 'pdf') {
        const spec = normalizeWordSpec(parsed);
        assertImagesResolved(spec);
        storedBodyText = JSON.stringify(spec);
      } else if (format === 'xlsx') {
        storedBodyText = JSON.stringify(normalizeExcelSpec(parsed));
      } else {
        const spec = normalizePptxSpec(parsed);
        assertImagesResolved(spec);
        storedBodyText = JSON.stringify(spec);
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('The edited document structure is invalid.');
    }
    // The stored spec is re-normalized inside renderStoredDocument (idempotent).
    try {
      generatedBuffer = await render(format, storedBodyText);
    } catch (error) {
      throw editedGenerationFailure(format, error);
    }
  }

  // Reuse the canonical API-owner integrity guard before the bytes can be
  // persisted or served; its raw failure is not exposed.
  try {
    await validateDocumentArtifactBytes(format, generatedBuffer);
  } catch (error) {
    throw editedGenerationFailure(format, error);
  }

  const documentSha256 = sha256Bytes(generatedBuffer);
  const filename = safeEditedDocumentFilename(title, format);
  const mimeType = mimeForFormat(format);

  if (format === 'txt') {
    if (!rowContext) throw new Error('meri_edited_artifact_receipt_context_required');
    // Fresh creation receipt: a new operation id and the rebuilt digest/length.
    // The parent's receipt is never consulted or copied, and no action proposal
    // is inherited - an edited text version is a new user-requested version, not
    // a mutation of an already-approved effect.
    textCreation = {
      version: 1,
      kind: 'meri_text_artifact_creation',
      operationId: randomUUID(),
      actionProposalId: null,
      tenantId: rowContext.tenantId,
      userId: rowContext.userId,
      clientId: rowContext.clientId,
      conversationId: rowContext.conversationId,
      filename,
      mimeType: 'text/plain',
      sha256: documentSha256,
      byteLength: generatedBuffer.length,
    };
  }

  return {
    format,
    bodyText: storedBodyText,
    filename,
    mimeType,
    sha256: documentSha256,
    byteLength: generatedBuffer.length,
    metadata: {
      docFormat: format,
      mimeType,
      filename,
      generatedAt: new Date().toISOString(),
      documentBytesBase64: generatedBuffer.toString('base64'),
      documentSha256,
      documentByteLength: generatedBuffer.length,
      documentByteFormat: format,
      documentByteAuthority: 'persisted_at_creation_v1',
      ...(textCreation ? { textCreation } : {}),
    },
  };
}
