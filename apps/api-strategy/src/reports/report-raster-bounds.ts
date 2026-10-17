export interface RasterSize {
  width: number;
  height: number;
}

const MAX_LOGO_SIDE = 4_096;
const MAX_LOGO_PIXELS = 1_000_000;

export function validSize(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_LOGO_SIDE &&
    height <= MAX_LOGO_SIDE &&
    width * height <= MAX_LOGO_PIXELS
  );
}
