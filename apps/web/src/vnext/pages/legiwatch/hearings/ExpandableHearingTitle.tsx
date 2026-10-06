import { useState } from 'react';
import './hearings.css';

/** Preserve the complete source title without allowing it to dominate a list. */
export function ExpandableHearingTitle({ title }: { title: string }) {
  const [expanded, setExpanded] = useState(false);
  return <span className="lw-hearing-title">
    <span className={expanded ? 'lw-hearing-title__text' : 'lw-hearing-title__text lw-hearing-title__text--clamped'}>{title}</span>
    {title.length > 180 ? <button type="button" className="lw-backlink lw-hearing-title__expand" aria-expanded={expanded}
      onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}
      onKeyDown={(event) => event.stopPropagation()}>{expanded ? 'Show less' : 'Show full title'}</button> : null}
  </span>;
}
