/**
 * Named browser-local adapters for Meri chrome that has no per-user endpoint.
 * Swap these for a real preference API without touching the rest of the shell.
 */

export type MeriWindowChrome = 'undocked' | 'maximized' | 'docked';
export type MeriContextSection = 'context' | 'sources' | 'actions';

const WINDOW_KEY = 'capiro.meri.vnext.window-chrome';
const RAIL_KEY = 'capiro.meri.vnext.context-rail';

export interface MeriRailPrefs {
  collapsed: boolean;
  openSection: MeriContextSection | null;
}

function readJson<T>(key: string): unknown {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function readWindowChrome(): MeriWindowChrome {
  const value = readJson<MeriWindowChrome>(WINDOW_KEY);
  return value === 'maximized' || value === 'docked' || value === 'undocked' ? value : 'undocked';
}

export function writeWindowChrome(value: MeriWindowChrome): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WINDOW_KEY, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}

export function readRailPrefs(): MeriRailPrefs {
  const value = readJson<MeriRailPrefs>(RAIL_KEY);
  if (!value || typeof value !== 'object') {
    return { collapsed: false, openSection: null };
  }
  const collapsed = Boolean((value as MeriRailPrefs).collapsed);
  const open = (value as MeriRailPrefs).openSection;
  const openSection =
    open === 'context' || open === 'sources' || open === 'actions' ? open : null;
  return { collapsed, openSection };
}

export function writeRailPrefs(value: MeriRailPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RAIL_KEY, JSON.stringify(value));
  } catch {
    /* private mode / quota */
  }
}
