import { ConflictException } from '@nestjs/common';

export interface SharedWorkspaceDocument {
  schemaVersion: 1;
  kind: 'workspace_document';
  docTitle: string;
  sections: Array<{ id: string; title: string; content: string }>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Full plain-text recipient projection. This deliberately has no comment-length cap. */
function text(value: unknown, location: string): string {
  if (typeof value !== 'string')
    throw new ConflictException(`Cannot share ${location}: unsupported content`);
  if (/<\s*(?:img|svg|iframe|object|video|audio|canvas)\b/i.test(value))
    throw new ConflictException(
      `Cannot share ${location}: embedded media has no complete frozen projection`,
    );
  // Text is rendered as text by recipients, never inserted as HTML.
  return value
    .replace(/<\s*(?:br\s*\/|br|\/p|\/div|\/li|\/h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .trim();
}

export function projectSharedWorkspaceDocument(snapshotValue: unknown): SharedWorkspaceDocument {
  const snapshot = record(snapshotValue);
  const config = record(snapshot.config);
  const sections: SharedWorkspaceDocument['sections'] = [];
  if (config.anonymize === true)
    throw new ConflictException(
      'Cannot share this anonymized document until its reviewed full-content projection is supported',
    );
  if (record(config.letterhead).custom === true)
    throw new ConflictException(
      'Cannot share this letterhead until its complete frozen projection is supported',
    );
  const sectionIds = config.sections ?? [];
  if (!Array.isArray(sectionIds) || !sectionIds.every((id) => typeof id === 'string'))
    throw new ConflictException('Cannot share document: unsupported section structure');
  const content = record(config.sectionContent);
  for (const id of sectionIds as string[]) {
    sections.push({
      id,
      title: text(id, 'section title'),
      content: text(content[id] ?? '', `section ${id}`),
    });
  }
  const appendBlocks = (value: unknown, prefix: string) => {
    if (value === undefined) return;
    if (!Array.isArray(value))
      throw new ConflictException(`Cannot share ${prefix}: unsupported block structure`);
    value.forEach((value, index) => {
      const block = record(value);
      const id = `${prefix}-${index}`;
      if (block.type === 'section')
        sections.push({ id, title: '', content: text(block.content ?? '', id) });
      else if (
        block.type === 'table' &&
        Array.isArray(block.cells) &&
        block.cells.every(
          (row) =>
            Array.isArray(row) &&
            row.every(
              (cell) => typeof cell === 'string' || typeof cell === 'number' || cell === null,
            ),
        )
      ) {
        sections.push({
          id,
          title: '',
          content: (block.cells as Array<Array<string | number | null>>)
            .map((row) => row.map((cell) => text(String(cell ?? ''), id)).join('\t'))
            .join('\n'),
        });
      } else
        throw new ConflictException(
          `Cannot share ${prefix}: unsupported ${String(block.type ?? 'unknown')} block`,
        );
    });
  };
  appendBlocks(config.mainBlocks, 'main');
  if (config.documentAgent && sections.length === 0)
    throw new ConflictException(
      'Cannot share this document kind: no supported complete content projection',
    );
  if (snapshot.documents !== undefined && !Array.isArray(snapshot.documents))
    throw new ConflictException('Cannot share document: unsupported packet structure');
  // The first document is the editor's vestigial primary row, also excluded by export.service.
  for (const [index, value] of (Array.isArray(snapshot.documents)
    ? snapshot.documents.slice(1)
    : []
  ).entries()) {
    const doc = record(value),
      body = record(doc.body);
    if (Object.keys(body).some((key) => !['title', 'blocks'].includes(key)))
      throw new ConflictException(`Cannot share packet document ${index + 1}: unsupported body`);
    const title = text(body.title ?? doc.name ?? '', `packet document ${index + 1}`);
    sections.push({ id: `document-${index}`, title, content: '' });
    appendBlocks(body.blocks, `document-${index}`);
  }
  return {
    schemaVersion: 1,
    kind: 'workspace_document',
    docTitle: text(snapshot.docTitle ?? '', 'document title'),
    sections,
  };
}
