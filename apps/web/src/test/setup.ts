import '@testing-library/jest-dom/vitest';

// JSDOM has no layout engine, so it doesn't implement matchMedia at all. Ant
// Design's responsive Row/Col reads it on mount (via a shared breakpoint
// observer) even when a query never actually matches in a test, so anything
// rendering Row/Col throws `window.matchMedia is not a function` without this.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
