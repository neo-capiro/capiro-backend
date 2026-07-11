import { describe, expect, test } from 'vitest';
import {
  clampUndockedRect,
  defaultUndockedRect,
  maxUndockedRect,
  parsePersistedUndockedRect,
  resizeUndockedRect,
} from './meri-geometry.js';

describe('Meri undocked geometry', () => {
  test('builds the centered prototype default rect', () => {
    expect(defaultUndockedRect({ width: 1440, height: 1000 })).toEqual({
      x: 250,
      y: 183,
      width: 940,
      height: 650,
    });
  });

  test('builds the prototype maximized inset rect', () => {
    expect(maxUndockedRect({ width: 1440, height: 1000 })).toEqual({
      x: 14,
      y: 34,
      width: 1412,
      height: 918,
    });
  });

  test('keeps the title bar and at least 120px of the window visible', () => {
    expect(
      clampUndockedRect(
        { x: -900, y: -50, width: 940, height: 650 },
        { width: 1440, height: 1000 },
      ),
    ).toEqual({ x: -820, y: 34, width: 940, height: 650 });
  });

  test('resizes each edge while enforcing minimum dimensions and viewport caps', () => {
    const viewport = { width: 1440, height: 1000 };
    const start = { x: 250, y: 183, width: 940, height: 650 };
    expect(resizeUndockedRect(start, 'se', 700, 500, viewport)).toEqual({
      x: 250,
      y: 183,
      width: 1170,
      height: 783,
    });
    expect(resizeUndockedRect(start, 'w', 800, 0, viewport)).toEqual({
      x: 722,
      y: 183,
      width: 468,
      height: 650,
    });
  });

  test('rejects malformed, undersized, non-finite, and fully off-screen persisted rects', () => {
    const viewport = { width: 1440, height: 1000 };
    expect(
      parsePersistedUndockedRect('{"x":200,"y":100,"width":900,"height":600}', viewport),
    ).toEqual({
      x: 200,
      y: 100,
      width: 900,
      height: 600,
    });
    expect(parsePersistedUndockedRect('not json', viewport)).toBeNull();
    expect(
      parsePersistedUndockedRect('{"x":0,"y":0,"width":100,"height":100}', viewport),
    ).toBeNull();
    expect(
      parsePersistedUndockedRect('{"x":9999,"y":9999,"width":900,"height":600}', viewport),
    ).toBeNull();
  });
});
