export interface MeriViewport {
  width: number;
  height: number;
}

export interface MeriRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MeriResizeEdge = 'n' | 's' | 'e' | 'w' | 'se' | 'sw';

export const MERI_MIN_WIDTH = 468;
export const MERI_MIN_HEIGHT = 456;

const finiteRect = (rect: MeriRect): boolean =>
  [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);

export function defaultUndockedRect(viewport: MeriViewport): MeriRect {
  const width = Math.min(940, viewport.width - 120);
  const height = Math.min(650, viewport.height - 120);
  return {
    x: Math.round((viewport.width - width) / 2),
    y: Math.round((viewport.height - height) / 2) + 8,
    width,
    height,
  };
}

export function maxUndockedRect(viewport: MeriViewport): MeriRect {
  return {
    x: 14,
    y: 34,
    width: viewport.width - 28,
    height: viewport.height - 82,
  };
}

export function clampUndockedRect(rect: MeriRect, viewport: MeriViewport): MeriRect {
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, 120 - rect.width), viewport.width - 120),
    y: Math.min(Math.max(rect.y, 34), viewport.height - 46),
  };
}

export function resizeUndockedRect(
  start: MeriRect,
  edge: MeriResizeEdge,
  deltaX: number,
  deltaY: number,
  viewport: MeriViewport,
): MeriRect {
  let { x, y, width, height } = start;
  const maxRight = viewport.width - 20;
  const maxBottom = viewport.height - 34;

  if (edge.includes('e')) width = Math.max(MERI_MIN_WIDTH, start.width + deltaX);
  if (edge.includes('s')) height = Math.max(MERI_MIN_HEIGHT, start.height + deltaY);
  if (edge.includes('w')) {
    const nextWidth = Math.max(MERI_MIN_WIDTH, start.width - deltaX);
    x = start.x + (start.width - nextWidth);
    width = nextWidth;
  }
  if (edge.includes('n')) {
    const nextHeight = Math.max(MERI_MIN_HEIGHT, start.height - deltaY);
    y = start.y + (start.height - nextHeight);
    height = nextHeight;
  }

  if (edge.includes('e')) width = Math.min(width, Math.max(MERI_MIN_WIDTH, maxRight - x));
  if (edge.includes('s')) height = Math.min(height, Math.max(MERI_MIN_HEIGHT, maxBottom - y));
  if (edge.includes('w') && x < 14) {
    width -= 14 - x;
    x = 14;
  }
  if (edge.includes('n') && y < 34) {
    height -= 34 - y;
    y = 34;
  }

  return { x, y, width, height };
}

export function parsePersistedUndockedRect(
  raw: string | null,
  viewport: MeriViewport,
): MeriRect | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MeriRect>;
    const rect: MeriRect = {
      x: Number(parsed.x),
      y: Number(parsed.y),
      width: Number(parsed.width),
      height: Number(parsed.height),
    };
    if (!finiteRect(rect)) return null;
    if (rect.width < MERI_MIN_WIDTH || rect.height < MERI_MIN_HEIGHT) return null;
    if (rect.width > viewport.width - 20 || rect.height > viewport.height - 40) return null;
    if (rect.x + rect.width < 120 || rect.x > viewport.width - 120) return null;
    if (rect.y < 34 || rect.y > viewport.height - 46) return null;
    return clampUndockedRect(rect, viewport);
  } catch {
    return null;
  }
}
