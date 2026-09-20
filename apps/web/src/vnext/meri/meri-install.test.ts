import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  configureMeriInstallDocument,
  MeriInstallStore,
  type MeriBeforeInstallPromptEvent,
} from './meri-install.js';

function mediaQuery(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(display-mode: standalone)',
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  };
}

function installPrompt(outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', {
    cancelable: true,
  }) as MeriBeforeInstallPromptEvent;
  const prompt = vi.fn().mockResolvedValue(undefined);
  Object.defineProperties(event, {
    prompt: { value: prompt },
    userChoice: { value: Promise.resolve({ outcome, platform: 'web' }) },
  });
  return { event, prompt };
}

const originalMatchMedia = window.matchMedia;
let store: MeriInstallStore;

describe('MeriInstallStore', () => {
  beforeEach(() => {
    store = new MeriInstallStore();
    window.matchMedia = vi.fn(() => mediaQuery(false));
    document.head.innerHTML = '<meta name="theme-color" content="#01226A">';
  });

  afterEach(() => {
    store.reset();
    window.matchMedia = originalMatchMedia;
  });

  test('retains the browser event for a late UI subscriber', () => {
    store.connect(window);
    const { event } = installPrompt('accepted');

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(store.getSnapshot().canInstall).toBe(true);
    const subscriber = vi.fn();
    store.subscribe(subscriber);
    expect(store.getSnapshot().canInstall).toBe(true);
  });

  test('opens the install flow once and records acceptance', async () => {
    store.connect(window);
    const { event, prompt } = installPrompt('accepted');
    window.dispatchEvent(event);

    await expect(store.requestInstall()).resolves.toBe('accepted');

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({
      canInstall: false,
      isInstalled: true,
      isInstalling: false,
    });
    await expect(store.requestInstall()).resolves.toBe('unavailable');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test('clears a dismissed one-shot prompt and accepts a later browser prompt', async () => {
    store.connect(window);
    const first = installPrompt('dismissed');
    window.dispatchEvent(first.event);

    await expect(store.requestInstall()).resolves.toBe('dismissed');
    expect(store.getSnapshot()).toMatchObject({ canInstall: false, isInstalled: false });

    const second = installPrompt('accepted');
    window.dispatchEvent(second.event);
    expect(store.getSnapshot().canInstall).toBe(true);
  });

  test('clears the prompt when the browser reports installation', () => {
    store.connect(window);
    window.dispatchEvent(installPrompt('accepted').event);

    window.dispatchEvent(new Event('appinstalled'));

    expect(store.getSnapshot()).toMatchObject({ canInstall: false, isInstalled: true });
  });

  test('does not offer installation inside an already standalone window', () => {
    window.matchMedia = vi.fn(() => mediaQuery(true));
    store.connect(window);
    const { event, prompt } = installPrompt('accepted');

    window.dispatchEvent(event);

    expect(store.getSnapshot()).toMatchObject({ canInstall: false, isStandalone: true });
    expect(prompt).not.toHaveBeenCalled();
  });

  test('stays unavailable when the browser does not emit an install event', () => {
    store.connect(window);
    expect(store.getSnapshot().canInstall).toBe(false);
  });
});

describe('configureMeriInstallDocument', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#01226A">';
  });

  test('adds install metadata idempotently and gives vNext a light app frame', () => {
    configureMeriInstallDocument(document);
    configureMeriInstallDocument(document);

    expect(document.head.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe(
      '/meri-manifest.json',
    );
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe(
      '/meri-icons/apple-touch-icon.png',
    );
    expect(document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#FFFFFF',
    );
    expect(
      document.head
        .querySelector('meta[name="apple-mobile-web-app-title"]')
        ?.getAttribute('content'),
    ).toBe('Meri');
  });
});
