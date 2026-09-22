import { Children, type ReactNode } from 'react';
import type { MeriCitation } from './chat-store.js';

export type EvidenceAccuracy = 'enforce';

function normalizeRemovedMarkerSpacing(parts: ReactNode[]): ReactNode[] {
  const normalized: ReactNode[] = [];
  for (const part of parts) {
    if (typeof part === 'string' && typeof normalized[normalized.length - 1] === 'string') {
      normalized[normalized.length - 1] = `${normalized[normalized.length - 1]}${part}`;
    } else {
      normalized.push(part);
    }
  }
  return normalized.map((part) =>
    typeof part === 'string'
      ? part.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.;:!?])/g, '$1')
      : part,
  );
}

export function splitCitationMarkers(
  text: string,
  citationMap: Map<number, MeriCitation>,
  onOpen: (citation: MeriCitation) => void,
  evidenceAccuracy?: EvidenceAccuracy,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\[(\d{1,3})\]/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    const citation = citationMap.get(Number(match[1]));
    if (!citation && evidenceAccuracy !== 'enforce') continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (citation) {
      parts.push(
        <button
          key={`citation-${citation.n}-${key++}`}
          type="button"
          className="chat-citation"
          data-cite={citation.n}
          title={`View source ${citation.n}`}
          onClick={() => onOpen(citation)}
        >
          [{citation.n}]
        </button>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  if (!parts.length) return [text];
  return evidenceAccuracy === 'enforce' ? normalizeRemovedMarkerSpacing(parts) : parts;
}

export function injectCitationMarkers(
  children: ReactNode,
  citationMap: Map<number, MeriCitation>,
  onOpen: (citation: MeriCitation) => void,
  evidenceAccuracy?: EvidenceAccuracy,
): ReactNode {
  if (citationMap.size === 0 && evidenceAccuracy !== 'enforce') return children;
  return Children.map(children, (child) =>
    typeof child === 'string'
      ? splitCitationMarkers(child, citationMap, onOpen, evidenceAccuracy)
      : child,
  );
}

export function accuracyLinkPresentation(
  href: string | undefined,
  children: ReactNode,
  evidenceAccuracy?: EvidenceAccuracy,
): { children: ReactNode; title?: string } {
  if (evidenceAccuracy !== 'enforce' || !href) return { children };
  if (typeof children !== 'string' || children !== href || href.length <= 56) {
    return { children, title: href };
  }
  try {
    const url = new URL(href);
    const suffix = `${url.pathname}${url.search}${url.hash}`;
    const path = suffix.length > 31 ? `${suffix.slice(0, 30)}…` : suffix;
    return { children: `${url.host}${path}`, title: href };
  } catch {
    return { children, title: href };
  }
}
