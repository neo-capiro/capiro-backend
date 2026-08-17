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

// JSDOM implements neither half of the object-URL API (it has no way to hand
// out a real blob: URL). Every download in this app — CSV, PDF, .ics — builds
// a Blob, createObjectURL's it, clicks a synthetic <a>, then revokes it, so
// testing any of them throws `createObjectURL does not exist` without these.
// Defined as real (no-op) methods rather than left absent so `vi.spyOn` can
// replace them per test.
if (typeof URL !== 'undefined' && !URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:jsdom';
  URL.revokeObjectURL = () => undefined;
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

// JSDOM has no layout engine, so it doesn't implement scrollIntoView either.
// Any chat/transcript view that autoscrolls to its latest turn on mount or
// update (e.g. VNextOutreachWorkspace's chat pane) throws
// `scrollIntoView is not a function` without this no-op stub.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
