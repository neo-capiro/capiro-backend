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

// JSDOM has no layout engine, so it doesn't implement ResizeObserver either.
// DistrictNexusMap (and anything else that measures its own box to redraw)
// observes its container on mount, so rendering it throws `ResizeObserver is
// not defined` without this.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
