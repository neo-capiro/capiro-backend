import { Typography } from 'antd';

/**
 * "What this program does" narrative panel (Overview tab). Renders
 * program_element.description — the prose narrative pulled from whichever
 * source document produced it (RDT&E R-2 descriptive summary, procurement
 * P-40 "Description" block, or O&M OP-5 "Description of Operations Financed").
 *
 * This field was fetched and typed since the original page but never rendered
 * anywhere, in either the pre-redesign or redesigned Watch page — verified by
 * grepping the whole file for `detail.description` and finding zero matches.
 * It is the single biggest reason enriched lines still "looked blank": the
 * data was loaded correctly, it simply had no panel. Renders nothing when the
 * line has no narrative yet (RDT&E/O&M lines pending their source book), so it
 * lights up automatically as loads land — same pattern as PdocDetailPanel.
 */

const { Paragraph } = Typography;

export interface DescriptionSource {
  /** raw.op5Detail (batch-10 O&M) */
  op5Detail?: { sag?: string | null; book?: string | null; pageStart?: number | null; pageEnd?: number | null } | null;
  /** raw.pDocDetail.sourceBook (batch-5 procurement) — only used here when no
   * structured P-40 fields exist to justify PdocDetailPanel rendering its own
   * citation; avoids showing the same citation twice on lines that DO have
   * quantities/MDAP/etc. */
  pDocSourceBookOnly?: string | null;
}

export function DescriptionPanel({
  description,
  source,
}: {
  description: string | null | undefined;
  source?: DescriptionSource;
}) {
  const text = (description ?? '').trim();
  if (!text) return null;

  const op5 = source?.op5Detail;
  const citation = op5?.book
    ? `Source: FY2027 ${op5.book.replace(/_/g, ' ')} OP-5 exhibit${op5.sag ? `, SAG ${op5.sag}` : ''}${
        op5.pageStart ? `, p.${op5.pageStart}${op5.pageEnd && op5.pageEnd !== op5.pageStart ? `-${op5.pageEnd}` : ''}` : ''
      }`
    : source?.pDocSourceBookOnly
      ? `Source: FY2027 ${source.pDocSourceBookOnly.replace(/_/g, ' ')} P-40 exhibit`
      : null;

  return (
    <div className="pe-surface pe-plain-surface span-2 pe-desc-panel">
      <div className="pe-surface-head">
        <h3>What this program does</h3>
      </div>
      <div style={{ padding: '0 18px 16px' }}>
        <Paragraph
          className="pe-desc-text"
          ellipsis={{ rows: 4, expandable: true, symbol: 'Read more' }}
        >
          {text}
        </Paragraph>
        {citation ? <div className="pe-desc-citation">{citation}</div> : null}
      </div>
    </div>
  );
}
