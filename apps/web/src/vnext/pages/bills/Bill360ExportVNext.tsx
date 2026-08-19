import { useCallback, useState } from 'react';
import {
  buildFactSheetLines,
  buildFundingCsv,
  downloadBlob,
  slug,
} from '../../../pages/bills/bill-360-export-shared.js';
import type { BillDossierResponse } from '../../../pages/bills/bill-360.types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { DownloadIcon } from './dossier-primitives.js';

/**
 * Bill 360 export (Release R4, §4.5) — vNext chrome over the SAME artifact
 * builders the canonical page uses (bill-360-export-shared.ts), so both
 * surfaces emit byte-identical fact sheets and CSVs. Only the button/toast
 * layer differs: CapiroButton + the vNext toast instead of antd.
 *
 * jsPDF is a bundled dependency, dynamically imported so the ~350 kB chunk is
 * only fetched when someone actually exports.
 */
export function Bill360ExportVNext({ dossier }: { dossier: BillDossierResponse }) {
  const [busy, setBusy] = useState(false);
  const toast = useCapiroToast();
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
      toast.error(`Could not build the PDF: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [dossier, stem, toast]);

  return (
    <span className="b360-export">
      <CapiroButton size="compact" onClick={onPdf} disabled={busy} leadingIcon={<DownloadIcon />}>
        {busy ? 'Building…' : 'Fact sheet (PDF)'}
      </CapiroButton>
      <CapiroButton size="compact" onClick={onCsv} leadingIcon={<DownloadIcon />}>
        Funding (CSV)
      </CapiroButton>
    </span>
  );
}
