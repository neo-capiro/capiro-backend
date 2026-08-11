import { useState, type HTMLAttributes } from 'react';

/**
 * Identity/Mark — canonical Capiro vNext identity mark.
 *
 * Mirrors the design-system component set (`Identity/Mark`, componentKey
 * `84e85e68…`), whose documented axes are semantic *kind* and *size* with
 * editable initials, name, metadata and metadata visibility.
 *
 * The Directory vNext handoff (`963:3064`) is explicit about the semantics, and
 * the semantics win over any single fixture instance that draws a person as a
 * square: **people are circular; offices, committees and programs use
 * non-person (rounded-rect) geometry.** That distinction is how a reader tells a
 * person apart from an org unit at a glance, so it is encoded here rather than
 * left to each caller.
 */
export type IdentityKind = 'person' | 'office' | 'committee' | 'program';
export type IdentitySize = 'sm' | 'md' | 'lg';

export interface IdentityMarkProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  kind: IdentityKind;
  /** Display name. Drives the accessible label and the initials fallback. */
  name: string;
  size?: IdentitySize;
  /** Explicit initials override; derived from `name` when omitted. */
  initials?: string;
  /** Photo/logo. Falls back to initials if it is absent or fails to load. */
  imageUrl?: string | null;
  /** Mono metadata line rendered beside the mark when `metadataVisible`. */
  metadata?: string | null;
  metadataVisible?: boolean;
}

/**
 * Two initials from the first and last meaningful word, so "Rep. Elaine Morgan"
 * reads EM rather than RE. Falls back to a single glyph for mononyms.
 */
export function identityInitials(name: string): string {
  const words = name
    .replace(/\b(?:rep|sen|dr|mr|mrs|ms|hon|gen|adm|col|maj|capt|lt|sgt)\.?\b/gi, ' ')
    .split(/[\s·,]+/)
    .filter((word) => /[a-z0-9]/i.test(word));
  if (words.length === 0) return '—';
  const first = words[0]![0]!;
  const last = words.length > 1 ? words[words.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}

export function IdentityMark({
  kind,
  name,
  size = 'md',
  initials,
  imageUrl,
  metadata,
  metadataVisible = false,
  className = '',
  ...props
}: IdentityMarkProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !imageFailed;
  const glyph = initials?.trim() || identityInitials(name);

  const mark = (
    <span
      className={`capiro-identity-mark capiro-identity-mark--${kind} capiro-identity-mark--${size}${
        metadataVisible ? '' : ` ${className}`
      }`.trim()}
      // The name is carried by the adjacent copy whenever metadata is visible,
      // and by the mark itself when it stands alone.
      role="img"
      aria-label={metadataVisible ? undefined : name}
      aria-hidden={metadataVisible || undefined}
      {...(metadataVisible ? {} : props)}
    >
      {showImage ? (
        <img
          className="capiro-identity-mark__image"
          src={imageUrl ?? undefined}
          alt=""
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="capiro-identity-mark__initials">{glyph}</span>
      )}
    </span>
  );

  if (!metadataVisible) return mark;

  return (
    <span className={`capiro-identity ${className}`.trim()} {...props}>
      {mark}
      <span className="capiro-identity__copy">
        <span className="capiro-identity__name">{name}</span>
        {/* An unknown metadata line is stated as unknown, never blanked. */}
        <span className="capiro-identity__meta">{metadata?.trim() ? metadata : '—'}</span>
      </span>
    </span>
  );
}
