/**
 * Section view-model derivation. The draft stores section ordering in
 * `cfg.sections` (string[]), per-section body HTML in `cfg.sectionContent`, and
 * per-section status/flags in `cfg.sectionMeta`. The editor renders each section
 * by its `status` (handoff Q-ED-9). This file turns the raw config into the
 * ordered, resolved view-models the canvas + outline consume.
 */
import type { WsConfig, WsSectionMeta, WsSectionStatus } from '../types.js';
import { htmlWordCount } from './rich-text.js';
import { isStaleSection, staleSectionReason } from './generation-status.js';

export interface SectionView {
  /** Section heading / key into sectionContent + sectionMeta. */
  name: string;
  status: WsSectionStatus;
  smart: boolean;
  tailor: boolean;
  /** Body HTML (may be empty). */
  content: string;
  /** Live word count derived from the body. */
  words: number;
  /**
   * True when this content predates a FAILED regeneration attempt. The text is
   * real, but it is NOT what the last run produced, so the canvas must not
   * present it as freshly generated.
   */
  stale: boolean;
  /** Bounded, user-safe reason for the stale state (empty when not stale). */
  staleReason: string;
}

/** Heuristic: which section name is the auto-populated budget block. */
export function isSmartSection(name: string, meta?: WsSectionMeta): boolean {
  if (meta?.smart != null) return meta.smart;
  return /funding history|budget/i.test(name);
}

export function sectionViews(cfg: WsConfig): SectionView[] {
  const names = cfg.sections ?? [];
  const content = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
  const meta = (cfg.sectionMeta as Record<string, WsSectionMeta> | undefined) ?? {};
  return names.map((name) => {
    const m = meta[name] ?? {};
    const body = content[name] ?? '';
    const smart = isSmartSection(name, m);
    const tailor = !!m.tailor;
    // Resolve a status: explicit meta wins; otherwise infer from body presence.
    let status: WsSectionStatus;
    if (m.status) status = m.status;
    else if (smart) status = 'auto';
    else if (tailor) status = 'tailored';
    else if (body.trim()) status = 'draft';
    else status = 'empty';
    return {
      name,
      status,
      smart,
      tailor,
      content: body,
      words: smart ? (m.words ?? 0) : htmlWordCount(body),
      stale: isStaleSection(m),
      staleReason: staleSectionReason(m),
    };
  });
}

/** Total word count across prose sections (drives the outline counter). */
export function totalWords(views: SectionView[]): number {
  return views.reduce((sum, v) => sum + v.words, 0);
}

/** Rough page estimate (~500 words/page), min 1. */
export function estimatePages(words: number): number {
  return Math.max(1, Math.round(words / 500));
}
