import { Injectable } from "@nestjs/common";
import { PdfBrowserDriver } from "./pdf-browser.driver.js";
import { buildPdfReportDocument } from "./pdf-report.document.js";
import { ooxmlSafeValue } from "./report-text.js";
import type {
  ClientLogoAsset,
  ExecutiveReportSnapshot,
  ReportRenderExtras,
} from "./report.types.js";

/**
 * Executive PDF report: the reference client-brief layout rendered from the
 * same snapshot/narrative as the DOCX, printed by headless Chromium. Degrades
 * exactly like the other renderers when optional material (logo, narrative,
 * member detail) is absent.
 */
@Injectable()
export class PdfReportRenderer {
  constructor(private readonly browser: PdfBrowserDriver) {}

  get available(): boolean {
    return this.browser.available;
  }

  get unavailableReason(): string | null {
    return this.browser.unavailableReason;
  }

  async render(
    snapshot: ExecutiveReportSnapshot,
    logo: ClientLogoAsset | null,
    extras: ReportRenderExtras = {},
  ): Promise<Buffer> {
    // Defense in depth for direct renderer callers outside snapshot loading.
    const safeSnapshot = ooxmlSafeValue(snapshot);
    const safeExtras: ReportRenderExtras = {
      narrative: extras.narrative ? ooxmlSafeValue(extras.narrative) : null,
      memberDetails: (extras.memberDetails ?? []).map((detail) =>
        ooxmlSafeValue(detail),
      ),
      memberPhotos: extras.memberPhotos,
    };
    const document = buildPdfReportDocument(safeSnapshot, logo, safeExtras);
    const bytes = await this.browser.print(document);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new Error("PDF renderer returned an empty payload");
    }
    return bytes;
  }
}
