// Client-side "Export PDF" — there is no server PDF endpoint, so we open a
// print-friendly window with the artifact content and invoke the browser's
// print-to-PDF. Content is escaped (never injected as raw HTML).

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface PrintSection {
  heading: string;
  /** Paragraph text, or a list of bullet/numbered items. */
  body?: string;
  items?: string[];
  ordered?: boolean;
}

export function exportArtifactPdf(title: string, subtitle: string, sections: PrintSection[]): void {
  // NB: no `noopener`/`noreferrer` here — those features make window.open return
  // null, so we could never write the print document (this was the "Export PDF
  // does nothing" bug). We need the handle to write + print, and immediately
  // sever the opener below so the print tab still can't reach back into the app.
  const win = window.open('', '_blank', 'width=820,height=1000');
  if (!win) {
    // Popup blocked — surface a hint rather than failing silently.
    // eslint-disable-next-line no-alert
    window.alert('Allow pop-ups for this site to export a PDF.');
    return;
  }
  try {
    win.opener = null;
  } catch {
    /* cross-origin guard already severed it */
  }
  const blocks = sections
    .filter((s) => s.body || (s.items && s.items.length))
    .map((s) => {
      const head = `<h2>${esc(s.heading)}</h2>`;
      if (s.items && s.items.length) {
        const tag = s.ordered ? 'ol' : 'ul';
        return `${head}<${tag}>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</${tag}>`;
      }
      return `${head}<p>${esc(s.body ?? '')}</p>`;
    })
    .join('');
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#1c1a16;max-width:720px;margin:40px auto;padding:0 24px}` +
      `h1{font-size:22px;margin:0 0 2px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#7a756b;margin:22px 0 6px}` +
      `.sub{color:#7a756b;font-size:13px;margin:0 0 8px}ul,ol{margin:6px 0;padding-left:22px}li{margin:3px 0}p{margin:6px 0}</style></head><body>` +
      `<h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div>${blocks}</body></html>`,
  );
  win.document.close();
  win.focus();
  // Give the new document a tick to lay out before printing.
  setTimeout(() => win.print(), 250);
}
