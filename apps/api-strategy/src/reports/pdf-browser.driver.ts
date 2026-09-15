import { existsSync } from "node:fs";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Prints the executive-report HTML to PDF with a headless Chromium launched
 * per export — no always-running browser service. The browser binary resolves
 * from (in order): `STRATEGY_PDF_CHROMIUM_PATH`, a Debian/Ubuntu system
 * chromium (the container image), then the host's installed ms-playwright
 * chromium via playwright-core's own registry (local dev — no hardcoded
 * revision). Set `STRATEGY_PDF_ENABLED=false` to take PDF out of the
 * advertised formats; export then fails fast with a clear 503, never a hang.
 */

export interface PdfPrintInput {
  html: string;
  footerTemplate: string;
}

const LAUNCH_TIMEOUT_MS = 15_000;
const PRINT_TIMEOUT_MS = 90_000;

type Chromium = typeof import("playwright-core").chromium;

@Injectable()
export class PdfBrowserDriver {
  private readonly logger = new Logger(PdfBrowserDriver.name);
  private readonly enabled: boolean;
  private readonly explicitPath: string | null;

  constructor(config: ConfigService) {
    this.enabled =
      (config.get<string>("STRATEGY_PDF_ENABLED") ?? "true").trim() !== "false";
    const path = (config.get<string>("STRATEGY_PDF_CHROMIUM_PATH") ?? "").trim();
    this.explicitPath = path || null;
  }

  get available(): boolean {
    return this.enabled && this.resolveExecutable() !== null;
  }

  get unavailableReason(): string | null {
    if (!this.enabled) return "PDF export is disabled in this environment.";
    if (!this.resolveExecutable()) {
      return "No Chromium executable is available for PDF rendering.";
    }
    return null;
  }

  async print(input: PdfPrintInput): Promise<Buffer> {
    const executable = this.resolveExecutable();
    if (!this.enabled || !executable) {
      throw new Error(this.unavailableReason ?? "PDF export is unavailable.");
    }
    const chromium = this.loadChromium();
    let browser: import("playwright-core").Browser | null = null;
    // Hard bound on the whole render so a stuck page cannot hold the export
    // slot: on timeout we force-close the browser (which rejects pending
    // page.pdf) and surface a timeout error.
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      void browser?.close().catch(() => undefined);
    }, PRINT_TIMEOUT_MS);
    try {
      browser = await chromium.launch({
        executablePath: executable,
        headless: true,
        timeout: LAUNCH_TIMEOUT_MS,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--font-render-hinting=none",
        ],
      });
      const page = await browser.newPage();
      await page.setContent(input.html, {
        waitUntil: "load",
        timeout: PRINT_TIMEOUT_MS,
      });
      // Give @font-face data-URIs a tick to apply before measuring for print.
      await page.evaluate(
        () =>
          (
            globalThis as unknown as {
              document?: { fonts?: { ready: Promise<unknown> } };
            }
          ).document?.fonts?.ready ?? Promise.resolve(),
      );
      const pdf = await page.pdf({
        format: "Letter",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: `<div></div>`,
        footerTemplate: input.footerTemplate,
        margin: { top: "0.7in", bottom: "0.8in", left: "0.7in", right: "0.7in" },
        preferCSSPageSize: false,
      });
      if (timedOut) throw new Error("PDF render timed out");
      return pdf;
    } catch (error) {
      if (timedOut) throw new Error("PDF render timed out");
      throw error;
    } finally {
      clearTimeout(watchdog);
      if (browser) {
        await browser.close().catch((error: unknown) => {
          this.logger.warn(
            `chromium close failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
        });
      }
    }
  }

  /** Lazy-require so the service boots and tests run without playwright. */
  private loadChromium(): Chromium {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("playwright-core") as typeof import("playwright-core"))
      .chromium;
  }

  private resolveExecutable(): string | null {
    if (this.explicitPath && existsSync(this.explicitPath)) {
      return this.explicitPath;
    }
    for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (existsSync(candidate)) return candidate;
    }
    // Local dev: ask playwright-core for the host's installed chromium rather
    // than pinning a revision; returns undefined when nothing is installed.
    try {
      const registered = this.loadChromium().executablePath();
      if (registered && existsSync(registered)) return registered;
    } catch {
      // No compatible browser installed for this playwright version.
    }
    return null;
  }
}
