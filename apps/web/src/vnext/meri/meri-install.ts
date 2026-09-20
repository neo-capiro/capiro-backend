import { useSyncExternalStore } from 'react';

export const MERI_MANIFEST_HREF = '/meri-manifest.json';
export const MERI_THEME_COLOR = '#FFFFFF';

const STANDALONE_DISPLAY_QUERY = '(display-mode: standalone)';

export type MeriInstallOutcome = 'accepted' | 'dismissed' | 'failed' | 'unavailable';

export interface MeriBeforeInstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform?: string;
  }>;
}

export interface MeriInstallSnapshot {
  canInstall: boolean;
  isInstalled: boolean;
  isInstalling: boolean;
  isStandalone: boolean;
}

const INITIAL_SNAPSHOT: MeriInstallSnapshot = Object.freeze({
  canInstall: false,
  isInstalled: false,
  isInstalling: false,
  isStandalone: false,
});

type InstallListener = () => void;

function isStandalone(target: Window, mediaQuery: MediaQueryList | null): boolean {
  const navigatorWithStandalone = target.navigator as Navigator & { standalone?: boolean };
  return mediaQuery?.matches === true || navigatorWithStandalone.standalone === true;
}

function isInstallPromptEvent(event: Event): event is MeriBeforeInstallPromptEvent {
  const candidate = event as Partial<MeriBeforeInstallPromptEvent>;
  return typeof candidate.prompt === 'function' && typeof candidate.userChoice?.then === 'function';
}

/**
 * Small external store for Chromium's one-shot install event.
 *
 * It is connected during app bootstrap, before Clerk/billing gates can delay
 * the Meri top bar. A late-mounting install button can therefore still use the
 * event the browser emitted earlier in the page lifecycle.
 */
export class MeriInstallStore {
  private target: Window | null = null;
  private displayModeQuery: MediaQueryList | null = null;
  private promptEvent: MeriBeforeInstallPromptEvent | null = null;
  private snapshot: MeriInstallSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<InstallListener>();

  readonly getSnapshot = (): MeriInstallSnapshot => this.snapshot;

  readonly subscribe = (listener: InstallListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(target: Window): void {
    if (this.target === target) {
      this.refreshDisplayMode();
      return;
    }

    this.disconnect();
    this.target = target;
    this.displayModeQuery =
      typeof target.matchMedia === 'function' ? target.matchMedia(STANDALONE_DISPLAY_QUERY) : null;

    target.addEventListener('beforeinstallprompt', this.handleBeforeInstallPrompt);
    target.addEventListener('appinstalled', this.handleAppInstalled);
    if (typeof this.displayModeQuery?.addEventListener === 'function') {
      this.displayModeQuery.addEventListener('change', this.handleDisplayModeChange);
    } else {
      this.displayModeQuery?.addListener(this.handleDisplayModeChange);
    }
    this.refreshDisplayMode();
  }

  disconnect(): void {
    if (!this.target) return;
    this.target.removeEventListener('beforeinstallprompt', this.handleBeforeInstallPrompt);
    this.target.removeEventListener('appinstalled', this.handleAppInstalled);
    if (typeof this.displayModeQuery?.removeEventListener === 'function') {
      this.displayModeQuery.removeEventListener('change', this.handleDisplayModeChange);
    } else {
      this.displayModeQuery?.removeListener(this.handleDisplayModeChange);
    }
    this.target = null;
    this.displayModeQuery = null;
  }

  readonly requestInstall = async (): Promise<MeriInstallOutcome> => {
    const event = this.promptEvent;
    if (!event || this.snapshot.isInstalling || this.snapshot.isStandalone) {
      return 'unavailable';
    }

    // beforeinstallprompt is single-use. Remove the affordance immediately so
    // repeated clicks cannot race a browser-owned confirmation dialog.
    this.promptEvent = null;
    this.update({ canInstall: false, isInstalling: true });

    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (choice.outcome === 'accepted') {
        this.update({ isInstalled: true });
      }
      return choice.outcome;
    } catch {
      return 'failed';
    } finally {
      this.update({ canInstall: false, isInstalling: false });
    }
  };

  /** Test-only reset for the singleton exported below. */
  reset(): void {
    this.disconnect();
    this.promptEvent = null;
    this.snapshot = INITIAL_SNAPSHOT;
    this.listeners.forEach((listener) => listener());
  }

  private readonly handleBeforeInstallPrompt = (event: Event): void => {
    if (!isInstallPromptEvent(event)) return;
    event.preventDefault();
    if (this.snapshot.isInstalled || this.snapshot.isStandalone) return;
    this.promptEvent = event;
    this.update({ canInstall: true });
  };

  private readonly handleAppInstalled = (): void => {
    this.promptEvent = null;
    this.update({ canInstall: false, isInstalled: true, isInstalling: false });
  };

  private readonly handleDisplayModeChange = (): void => {
    this.refreshDisplayMode();
  };

  private refreshDisplayMode(): void {
    if (!this.target) return;
    const standalone = isStandalone(this.target, this.displayModeQuery);
    if (standalone) this.promptEvent = null;
    this.update({
      canInstall: standalone ? false : Boolean(this.promptEvent),
      isStandalone: standalone,
    });
  }

  private update(next: Partial<MeriInstallSnapshot>): void {
    const snapshot = Object.freeze({ ...this.snapshot, ...next });
    if (
      snapshot.canInstall === this.snapshot.canInstall &&
      snapshot.isInstalled === this.snapshot.isInstalled &&
      snapshot.isInstalling === this.snapshot.isInstalling &&
      snapshot.isStandalone === this.snapshot.isStandalone
    ) {
      return;
    }
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

export const meriInstallStore = new MeriInstallStore();

function upsertLink(documentTarget: Document, rel: string, href: string, marker: string): void {
  let link = documentTarget.head.querySelector<HTMLLinkElement>(
    `link[data-meri-install="${marker}"]`,
  );
  if (!link) {
    link = documentTarget.createElement('link');
    link.dataset.meriInstall = marker;
    documentTarget.head.appendChild(link);
  }
  link.rel = rel;
  link.href = href;
}

function upsertMeta(documentTarget: Document, name: string, content: string): void {
  let meta = documentTarget.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = documentTarget.createElement('meta');
    meta.name = name;
    documentTarget.head.appendChild(meta);
  }
  meta.content = content;
}

export function configureMeriInstallDocument(documentTarget: Document): void {
  upsertLink(documentTarget, 'manifest', MERI_MANIFEST_HREF, 'manifest');
  upsertLink(documentTarget, 'apple-touch-icon', '/meri-icons/apple-touch-icon.png', 'apple-icon');
  upsertMeta(documentTarget, 'theme-color', MERI_THEME_COLOR);
  upsertMeta(documentTarget, 'apple-mobile-web-app-capable', 'yes');
  upsertMeta(documentTarget, 'apple-mobile-web-app-title', 'Meri');
}

/** Register browser events before exposing the manifest to avoid losing the one-shot prompt. */
export function initializeMeriInstallExperience(
  target: Window = window,
  documentTarget: Document = document,
): void {
  meriInstallStore.connect(target);
  configureMeriInstallDocument(documentTarget);
}

export function useMeriInstall(): MeriInstallSnapshot {
  return useSyncExternalStore(
    meriInstallStore.subscribe,
    meriInstallStore.getSnapshot,
    meriInstallStore.getSnapshot,
  );
}
