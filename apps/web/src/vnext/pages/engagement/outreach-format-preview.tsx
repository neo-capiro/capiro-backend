/**
 * The Format step's mailbox preview: one letter, laid out four ways.
 *
 * This component decides WHERE words go and never WHAT they are. Everything it
 * shows comes out of `outreachLetterLayout()` over the campaign's own subject
 * and body, so a fact strip, a table row or a closing line only appears when
 * the letter itself carries one. The four static labels the prototype writes in
 * chrome ("Capiro briefing", "Item", "Detail", "Note") are the only strings
 * here that are not the letter's.
 *
 * A caller with no letter to show passes an empty body and gets the empty
 * state — the prototype previews a seeded specimen letter at that point, which
 * would be a fabricated draft on a real campaign.
 */
import {
  OUTREACH_TABLE_FORMAT_EMPTY_NOTE,
  outreachLetterLayout,
  outreachLetterTableGrid,
} from './outreach-email-format-preview.js';
import type { OutreachEmailFormatOption } from './outreach-campaign-flow.js';
import './outreach-step-format.css';

export const OUTREACH_FORMAT_PREVIEW_EMPTY_NOTE =
  'This campaign has no letter structure yet. Choose a template on the previous step and the preview lays out that letter’s own words here.';

export interface OutreachFormatPreviewProps {
  format: OutreachEmailFormatOption;
  subject: string;
  body: string;
  kicker: string;
}

export function OutreachFormatPreview({
  format,
  subject,
  body,
  kicker,
}: OutreachFormatPreviewProps): JSX.Element {
  const layout = outreachLetterLayout(subject, body);
  const hasLetter = body.trim().length > 0;

  return (
    <div className="ofpv">
      <div className="ofpv__mail">
        {!hasLetter ? (
          <p className="ofpv__empty">{OUTREACH_FORMAT_PREVIEW_EMPTY_NOTE}</p>
        ) : format.id === 'briefing_card' ? (
          <>
            <div className="ofpv__head">
              <span className="ofpv__head-eyebrow">Capiro briefing</span>
              <span className="ofpv__head-subject">{subject}</span>
              <span className="ofpv__head-kicker">{kicker}</span>
            </div>
            <div className="ofpv__blocks">
              {layout.blocks.map((block, index) =>
                block.kind === 'head' ? (
                  <span className="ofpv__block-head" key={`${index}:${block.text}`}>
                    {block.text}
                  </span>
                ) : block.kind === 'bullet' ? (
                  <span className="ofpv__bullet" key={`${index}:${block.text}`}>
                    <span className="ofpv__bullet-dot" aria-hidden="true" />
                    {block.text}
                  </span>
                ) : (
                  <span className="ofpv__para" key={`${index}:${block.text}`}>
                    {block.text}
                  </span>
                ),
              )}
            </div>
            {/* The strip is the letter's own figures, so a letter that states
                none shows no strip rather than an empty three-up grid. */}
            {layout.facts.length > 0 ? (
              <div className="ofpv__facts">
                {layout.facts.map((fact) => (
                  <span className="ofpv__fact" key={`${fact.value}:${fact.label}`}>
                    <span className="ofpv__fact-label">{fact.label}</span>
                    <span className="ofpv__fact-value">{fact.value}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : format.id === 'status_table' ? (
          <div className="ofpv__pad">
            <span className="ofpv__subject">{subject}</span>
            <span className="ofpv__kicker">{kicker}</span>
            <div className="ofpv__table" role="table">
              <div
                className="ofpv__thead"
                role="row"
                style={{ gridTemplateColumns: outreachLetterTableGrid(layout.hasNoteColumn) }}
              >
                <span role="columnheader">Item</span>
                <span role="columnheader">Detail</span>
                {/* The third column exists only when a row has a third field —
                    a permanently empty "Note" column would read as missing data. */}
                {layout.hasNoteColumn ? <span role="columnheader">Note</span> : null}
              </div>
              {layout.tableRows.map((row, index) => (
                <div
                  className="ofpv__trow"
                  role="row"
                  key={`${index}:${row.item}`}
                  style={{ gridTemplateColumns: outreachLetterTableGrid(layout.hasNoteColumn) }}
                >
                  <span className="ofpv__cell ofpv__cell--item" role="cell">
                    {row.item}
                  </span>
                  <span className="ofpv__cell" role="cell">
                    {row.detail}
                  </span>
                  {layout.hasNoteColumn ? (
                    <span className="ofpv__cell ofpv__cell--note" role="cell">
                      {row.note}
                    </span>
                  ) : null}
                </div>
              ))}
              {layout.tableRows.length === 0 ? (
                <p className="ofpv__table-empty">{OUTREACH_TABLE_FORMAT_EMPTY_NOTE}</p>
              ) : null}
            </div>
            {/* Closing line and source small print render in this format only —
                the prototype's asymmetry, kept deliberately. */}
            {layout.closingLine ? <p className="ofpv__close">{layout.closingLine}</p> : null}
            {layout.footnote ? <p className="ofpv__foot">{layout.footnote}</p> : null}
          </div>
        ) : format.id === 'timeline' ? (
          <div className="ofpv__pad">
            <span className="ofpv__subject">{subject}</span>
            <span className="ofpv__kicker">{kicker}</span>
            <div className="ofpv__timeline">
              {layout.sections.map((section, index) => (
                <span className="ofpv__section" key={`${index}:${section.head}`}>
                  <span className="ofpv__rail" aria-hidden="true">
                    <span className="ofpv__rail-dot" />
                    <span className="ofpv__rail-line" />
                  </span>
                  <span className="ofpv__section-body">
                    {section.head ? (
                      <span className="ofpv__section-head">{section.head}</span>
                    ) : null}
                    {section.items.map((item, itemIndex) => (
                      <span className="ofpv__item" key={`${itemIndex}:${item}`}>
                        {item}
                      </span>
                    ))}
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="ofpv__pad ofpv__pad--plain">
            <span className="ofpv__subject ofpv__subject--plain">{subject}</span>
            <span className="ofpv__kicker">{kicker}</span>
            {/* The one format that shows the letter unparsed: its own line
                breaks are the layout, so they are preserved with pre-wrap. */}
            <p className="ofpv__plain-body">{body}</p>
          </div>
        )}
      </div>
    </div>
  );
}
