import { useCallback, useState } from 'react';
import { DownloadOutlined } from '@ant-design/icons';
import { message } from 'antd';
import { buildFactSheetLines, buildFundingCsv, downloadBlob, slug } from './bill-360-export-shared.js';
import type { BillDossierResponse } from './bill-360.types.js';

/**
 * Bill 360 export (Release R4, §4.5).
 *
 * The artifact builders (fact-sheet PDF line model + funding-comparison CSV) live
 * in bill-360-export-shared.ts — UI-free so the vNext surface reuses them — and
 * are re-exported here unchanged for existing importers/tests. This file owns only
 * the canonical (antd) chrome: the two buttons and the failure toast.
 *
 * jsPDF is a bundled dependency, dynamically imported so the ~350 kB chunk is only
 * fetched when someone actually exports (same pattern as strategy/ExportView).
 *
 * DOCX is deliberately NOT wired here. §4.5 makes it conditional ("DOCX when the
 * existing artifact service is reused"); reusing apps/api's artifact service means
 * adding an ArtifactType, a generator, a verifier entry, and a route, which is a
 * server-side change better scoped on its own than bolted onto this button.
 */

export { buildFactSheetLines, buildFundingCsv } from './bill-360-export-shared.js';

export function Bill360Export({ dossier }: { dossier: BillDossierResponse }) {
  const [busy, setBusy] = useState(false);
  const stem = slug(dossier.bill.num || dossier.bill.id);

  const onCsv = useCallback(() => {
    const generatedAt = new Date().toISOString();
    downloadBlob(
      `capiro-bill360-${stem}-funding.csv`,
      'text/csv;charset=utf-8',
      // BOM so Excel reads the UTF-8 scope labels correctly.
      `﻿${buildFundingCsv(dossier, generatedAt)}`,
    );
  }, [dossier, stem]);

  const onPdf = useCallback(async () => {
    setBusy(true);
    try {
      const generatedAt = new Date().toISOString();
      const lines = buildFactSheetLines(dossier, generatedAt);
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
      const marginX = 48;
      const marginTop = 56;
      const bottom = pdf.internal.pageSize.getHeight() - 48;
      const width = pdf.internal.pageSize.getWidth() - marginX * 2;
      let y = marginTop;

      for (const line of lines) {
        pdf.setFont('helvetica', line.heading ? 'bold' : 'normal');
        pdf.setFontSize(line.heading ? 12 : 9.5);
        if (line.heading) y += 8;
        for (const wrapped of pdf.splitTextToSize(line.text, width) as string[]) {
          if (y > bottom) {
            pdf.addPage();
            y = marginTop;
          }
          pdf.text(wrapped, marginX, y);
          y += line.heading ? 16 : 13;
        }
      }
      pdf.save(`capiro-bill360-${stem}-fact-sheet.pdf`);
    } catch (err) {
      message.error(`Could not build the PDF: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [dossier, stem]);

  return (
    <span className="dsr-export">
      <button type="button" className="dsr-btn" onClick={onPdf} disabled={busy}>
        <DownloadOutlined /> {busy ? 'Building…' : 'Fact sheet (PDF)'}
      </button>
      <button type="button" className="dsr-btn" onClick={onCsv}>
        <DownloadOutlined /> Funding (CSV)
      </button>
    </span>
  );
}
