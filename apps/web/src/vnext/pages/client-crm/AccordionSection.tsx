import { useState, type ReactNode } from 'react';
import { UIcon } from './portfolio-primitives.js';

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
    <section
      id={id}
      ref={sectionRef}
      style={{
        background: '#ffffff',
        borderRadius: 12,
        boxShadow: '0 0 0 1px #E8E5DF,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)',
        overflow: 'hidden',
        scrollMarginTop: 24,
      }}
    >
      <button
        type="button"
        data-testid={`${id}-header`}
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-expanded={open}
        aria-controls={bodyId}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          gap: 12,
          padding: '20px 24px',
          background: hover ? '#FCFCFD' : 'transparent',
        }}
      >
        <span
          aria-hidden
          style={{
            flex: '0 0 auto',
            display: 'flex',
            color: '#98A2B3',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 150ms cubic-bezier(.2,0,0,1)',
          }}
        >
          <UIcon name="ChevronRight" size={16} />
        </span>
        <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <span style={{ display: 'block', fontSize: 18, fontWeight: 600, letterSpacing: '-0.022em', color: '#101828' }}>
            {title}
          </span>
          {sub ? (
            <span style={{ display: 'block', marginTop: 2, fontSize: 13, lineHeight: '18px', color: '#667085', textWrap: 'pretty' }}>
              {sub}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span
            style={{
              flex: '0 0 auto',
              fontSize: 12.5,
              fontWeight: 500,
              color: '#667085',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            {meta}
          </span>
        ) : null}
      </button>
      {open ? (
        <div id={bodyId} className="cap-pf-anim-fade" style={{ borderTop: '1px solid #F2F4F7', padding: '20px 24px 24px' }}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
