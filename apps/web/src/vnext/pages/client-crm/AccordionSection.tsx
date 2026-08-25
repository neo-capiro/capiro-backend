import { useState, type ReactNode } from 'react';
import { UIcon } from './portfolio-primitives.js';
import './accordion-section.css';

/**
 * Phase 4 (vnext UI cleanup — client record restructuring).
 *
 * One always-mounted, independently collapsible section in the record's main
 * content stack (Overview / Timeline / Advocacy history / Intelligence).
 * Replaces the single-tab-at-a-time `role="tabpanel"` body: every section
 * stays in the DOM and reachable regardless of which one is expanded, which
 * is what lets a bookmark like `?tab=relationships&view=history` land on an
 * already-scrolled-to, already-open Timeline without hiding the rest of the
 * record.
 *
 * Card recipe (border/shadow) is the literal value already used for cards
 * elsewhere in this file's module — see `ClientProfileShell.tsx`'s
 * `cap-pf-client__body` siblings and `tabs/FilesTab.tsx`'s section cards,
 * both `0 0 0 1px #E8E5DF,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px
 * rgba(16,24,40,.06)`. This is a plain expand/collapse disclosure, not an
 * ARIA tabs widget — more than one section can be open at once by design.
 */

export interface AccordionSectionProps {
  /** Anchor id — also the scroll target for the route-driven auto-expand. */
  id: string;
  title: string;
  /**
   * One-line description shown under the title, in the clickable header
   * itself (same "label + one-line detail" convention as `DrawerRail`'s own
   * rows) — visible even while collapsed, so a user can tell what a
   * section holds without opening it.
   */
  sub?: string;
  /** Optional real count/summary shown at the right of the header. Omitted
   *  rather than fabricated when no cheap real figure is available. */
  meta?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Lets the caller collect a ref to `scrollIntoView` on route changes. */
  sectionRef?: (node: HTMLElement | null) => void;
}

export function AccordionSection({ id, title, sub, meta, open, onToggle, children, sectionRef }: AccordionSectionProps) {
  const [hover, setHover] = useState(false);
  const bodyId = `${id}-body`;
  return (
    <section id={id} ref={sectionRef} className="cap-pf-accordion">
      <button
        type="button"
        data-testid={`${id}-header`}
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-expanded={open}
        aria-controls={bodyId}
        className={hover ? 'cap-pf-accordion__header cap-pf-accordion__header--hover' : 'cap-pf-accordion__header'}
      >
        <span
          aria-hidden
          className={open ? 'cap-pf-accordion__chevron cap-pf-accordion__chevron--open' : 'cap-pf-accordion__chevron'}
        >
          <UIcon name="ChevronRight" size={16} />
        </span>
        <span className="cap-pf-accordion__heading">
          <span className="cap-pf-accordion__title">{title}</span>
          {sub ? <span className="cap-pf-accordion__sub">{sub}</span> : null}
        </span>
        {meta ? <span className="cap-pf-accordion__meta">{meta}</span> : null}
      </button>
      {open ? (
        <div id={bodyId} className="cap-pf-anim-fade cap-pf-accordion__body">
          {children}
        </div>
      ) : null}
    </section>
  );
}
