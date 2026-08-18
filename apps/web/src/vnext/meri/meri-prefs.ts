/**
 * Shared Meri vNext preference vocabulary.
 * Values are persisted through /api/clio/vnext/preferences, not browser storage.
 */
export type MeriWindowChrome = 'undocked' | 'maximized' | 'docked';
export type MeriContextSection = 'context' | 'sources' | 'actions' | 'memory';

export interface MeriRailPrefs {
  collapsed: boolean;
  openSection: MeriContextSection | null;
}
