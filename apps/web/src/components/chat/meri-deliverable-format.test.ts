import { describe, expect, test } from 'vitest';
import { deliverableFormatFor, isMeriDeliverableFormat } from './meri-deliverable-format.js';

describe('deliverable format from the request wording', () => {
  test.each([
    ['Write a two-page office brief on HR 1 for the client folder.', 'docx'],
    ['Write a two-page office brief on HR 1 as a Word document.', 'docx'],
    ['Compare the House and Senate marks for these PEs in an Excel workbook.', 'xlsx'],
    ['Put the FY27 marks in a spreadsheet.', 'xlsx'],
    ['Build a six-slide quarterly update deck for the client.', 'pptx'],
    ['Make PowerPoint slides for Thursday.', 'pptx'],
    ['A memo that walks through the slides from the hearing.', 'docx'],
    ['A workbook and a deck on the same topic.', 'docx'],
  ] as const)('%s -> %s', (request, format) => {
    expect(deliverableFormatFor(request)).toBe(format);
  });

  test('recognizes only the three Office formats', () => {
    expect(['docx', 'xlsx', 'pptx'].every(isMeriDeliverableFormat)).toBe(true);
    expect(isMeriDeliverableFormat('pdf')).toBe(false);
    expect(isMeriDeliverableFormat('markdown')).toBe(false);
  });
});
