/**
 * Path predicate for VNextRouter: the Bill 360 module owns exactly what the
 * canonical route tree matches for it — `/bills/:billId`, one non-empty
 * segment (an optional trailing slash is the same match to React Router).
 *
 * Anything else under /bills (the bare index, extra segments) falls through
 * to the canonical tree, which resolves it to the 404 page — identical to
 * app.capiro.ai. Kept in its own module (mirroring engagement-route-state.ts)
 * so routing tests can consume the real predicate without pulling the page
 * body in.
 */
export function isVNextBillPath(pathname: string): boolean {
  return /^\/bills\/[^/]+\/?$/.test(pathname);
}
