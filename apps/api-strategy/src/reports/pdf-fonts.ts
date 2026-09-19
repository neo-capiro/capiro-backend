import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Embedded Inter subsets (SIL Open Font License 1.1) so the rendered PDF keeps
 * the reference typography without a network fetch at export time. The woff2
 * files live in `reports/assets/` (latin 400/600/700); when they are absent the
 * document falls back to the system sans stack and still renders correctly.
 *
 * Asset resolution uses `__dirname` (this package compiles to CommonJS
 * Node16): dist/reports/pdf-fonts.js -> dist/reports/assets, and ts-jest keeps
 * the same module directory layout for src.
 */
export interface PdfFontFace {
  family: string;
  weight: number;
  dataUri: string;
}

const ASSET_FILES: Array<{ file: string; weight: number }> = [
  { file: "inter-latin-400.woff2", weight: 400 },
  { file: "inter-latin-600.woff2", weight: 600 },
  { file: "inter-latin-700.woff2", weight: 700 },
];

let cached: PdfFontFace[] | null = null;

export function loadPdfFontFaces(): PdfFontFace[] {
  if (cached) return cached;
  const dir = join(__dirname, "assets");
  const faces: PdfFontFace[] = [];
  for (const { file, weight } of ASSET_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    faces.push({
      family: "Inter",
      weight,
      dataUri: `data:font/woff2;base64,${bytes.toString("base64")}`,
    });
  }
  cached = faces;
  return faces;
}

export function pdfFontFaceCss(): string {
  return loadPdfFontFaces()
    .map(
      (face) => `@font-face{font-family:'${face.family}';font-style:normal;` +
        `font-weight:${face.weight};font-display:swap;src:url("${face.dataUri}") format('woff2');}`,
    )
    .join("\n");
}
