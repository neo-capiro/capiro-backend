export type WebPresentation = 'canonical' | 'vnext';

/** Pure runtime-surface resolver kept separate so both branches are testable. */
export function resolveWebPresentation(webSurface?: string | null): WebPresentation {
  return webSurface?.trim().toLowerCase() === 'vnext' ? 'vnext' : 'canonical';
}
