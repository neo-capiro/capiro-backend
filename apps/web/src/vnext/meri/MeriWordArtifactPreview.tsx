/**
 * Read-only view of the persisted WordSpec from meri-docgen.helpers.ts. The API
 * owns normalization and binary generation; this decoder only checks the stored
 * shape so a malformed/unfinished artifact cannot crash the canvas.
 */
interface WordArtifactDocument {
  title: string;
  subtitle?: string | null;
  sections: Array<{
    heading: string;
    paragraphs?: string[];
    bullets?: string[];
    tables?: Array<{ headers: string[]; rows: string[][] }>;
    images?: Array<{ dataBase64: string }>;
  }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function readMeriWordArtifact(body: string): WordArtifactDocument | null {
  try {
    const value: unknown = JSON.parse(body);
    if (!record(value) || typeof value.title !== 'string' ||
      (value.subtitle != null && typeof value.subtitle !== 'string') ||
      !Array.isArray(value.sections) || value.sections.length === 0) return null;
    for (const section of value.sections) {
      if (!record(section) || typeof section.heading !== 'string') return null;
      if (section.paragraphs !== undefined && !strings(section.paragraphs)) return null;
      if (section.bullets !== undefined && !strings(section.bullets)) return null;
      if (section.tables !== undefined && (!Array.isArray(section.tables) ||
        !section.tables.every((table) => record(table) && strings(table.headers) &&
          Array.isArray(table.rows) && table.rows.every(strings)))) return null;
      if (section.images !== undefined && (!Array.isArray(section.images) ||
        !section.images.every((image) => record(image) && typeof image.dataBase64 === 'string'))) return null;
    }
    return value as unknown as WordArtifactDocument;
  } catch {
    return null;
  }
}

export function meriWordArtifactText(document: WordArtifactDocument): string {
  return [
    document.title,
    ...(document.subtitle ? [document.subtitle] : []),
    ...document.sections.flatMap((section) => [
      section.heading,
      ...(section.paragraphs ?? []),
      ...(section.bullets?.length ? [section.bullets.map((bullet) => `• ${bullet}`).join('\n')] : []),
      ...(section.tables ?? []).map((table) =>
        [table.headers, ...table.rows].map((row) => row.join('\t')).join('\n')),
      ...(section.images?.length ? ['[Embedded charts are included in the Word download.]'] : []),
    ]),
  ].join('\n\n');
}

export function MeriWordArtifactPreview({ document }: { document: WordArtifactDocument }) {
  return (
    <article aria-label="Word document preview">
      <h1 style={{ margin: '0 0 12px', fontSize: 24, lineHeight: 1.25, color: '#101828', fontWeight: 700 }}>
        {document.title}
      </h1>
      {document.subtitle ? <p style={{ margin: '0 0 20px', fontStyle: 'italic', color: '#667085' }}>{document.subtitle}</p> : null}
      {document.sections.map((section, sectionIndex) => (
        <section key={sectionIndex} style={{ marginTop: 22 }}>
          <h2 style={{ margin: '0 0 10px', fontSize: 16, lineHeight: 1.4, color: '#1C2E4A', fontWeight: 600 }}>{section.heading}</h2>
          {(section.paragraphs ?? []).map((paragraph, index) => <p key={index} style={{ margin: '0 0 12px' }}>{paragraph}</p>)}
          {section.bullets?.length ? (
            <ul style={{ margin: '0 0 12px', paddingLeft: 22, listStyleType: 'disc' }}>
              {section.bullets.map((bullet, index) => <li key={index} style={{ marginBottom: 6 }}>{bullet}</li>)}
            </ul>
          ) : null}
          {(section.tables ?? []).map((table, index) => (
            <div key={index} style={{ overflowX: 'auto', margin: '12px 0' }}>
              <table aria-label={`${section.heading} table ${index + 1}`} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr>{table.headers.map((header, column) => (
                  <th key={column} scope="col" style={{ padding: 8, border: '1px solid #D0D5DD', background: '#EEF1F7', textAlign: 'left' }}>{header}</th>
                ))}</tr></thead>
                <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => (
                  <td key={column} style={{ padding: 8, border: '1px solid #D0D5DD', verticalAlign: 'top' }}>{cell}</td>
                ))}</tr>)}</tbody>
              </table>
            </div>
          ))}
          {(section.images ?? []).map((image, index) => (
            /^iVBORw0KGgo[A-Za-z0-9+/=\s]*$/.test(image.dataBase64) && image.dataBase64.length <= 3 * 1024 * 1024
              ? <img key={index} src={`data:image/png;base64,${image.dataBase64}`} alt={`${section.heading} — embedded chart ${index + 1}`} style={{ display: 'block', maxWidth: '100%', height: 'auto', margin: '12px 0' }} />
              : <p key={index}>This embedded chart could not be previewed. Check the Word download.</p>
          ))}
        </section>
      ))}
    </article>
  );
}
