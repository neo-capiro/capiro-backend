import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHousePdfRows, parseSenatePdfRows } from './community-funding.parser.js';
import { readHouseCpfWorkbook } from './community-funding.xlsx.js';
import type { ExtractedFundingRow } from './community-funding.types.js';

const root = path.resolve(__dirname, '../../..');
const data = path.join(root, 'scripts/__data__/cpf_cds_source_documents');
const tool = path.join(root, 'scripts/__tools__/extract_cpf_cds_pdf.py');
const python = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
function extract(profile: 'house'|'senate', file: string) {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cpf-cds-')), `${profile}.json`);
  const child=spawnSync(python, [tool,'--profile',profile,path.join(data,file),output], {encoding:'utf8',timeout:120_000});
  if (child.status !== 0) throw new Error(`extractor failed status=${child.status} signal=${child.signal}: ${child.stderr || child.stdout}`);
  return JSON.parse(fs.readFileSync(output,'utf8')) as {rows:ExtractedFundingRow[];warnings:unknown[];pageCount:number};
}
describe('real FY2026 CPF/CDS source rehearsal', () => {
  jest.setTimeout(120_000);
  it('extracts and parses the House CJS PDF in natural order', () => {
    const artifact=extract('house','house_fy2026_cjs_cpf_table.pdf'), parsed=parseHousePdfRows(artifact.rows,2026,'CJS');
    expect({pages:artifact.pageCount,expected:937,extracted:artifact.rows.length,rejected:parsed.rejected.length}).toEqual({pages:66,expected:937,extracted:937,rejected:0});
    expect(parsed.candidates.slice(0,5).map(x=>[x.recipientName,x.requestedAmountUsd,x.requesterName])).toEqual([
      ['Johnson C. Smith University','1031000.00','Adams'],['California State University of San Bernardino (CSUSB)','1031000.00','Aguilar'],
      ['Hope Through Housing Foundation','1031000.00','Aguilar'],['Bothwell Regional Health Center','750200.00','Alford'],
      ['Curators of the University of Missouri','4200000.00','Alford']]);
  });
  it('extracts and parses the Senate Agriculture PDF and recommendation stage', () => {
    const artifact=extract('senate','senate_fy2026_ag_cds.pdf'), parsed=parseSenatePdfRows(artifact.rows,2026,'Agriculture');
    expect({pages:artifact.pageCount,expected:233,extracted:artifact.rows.length,rejected:parsed.rejected.length}).toEqual({pages:11,expected:233,extracted:233,rejected:0});
    expect(parsed.candidates.slice(0,5).map(x=>[x.recipientName,x.requestedAmountUsd,x.requesterName,x.amountStageRaw])).toEqual([
      ['Dale Bumpers National Rice Research Center','3100000.00','Boozman','senate_recommendation'],
      ['Dale Bumpers National Rice Research Center','6550000.00','Boozman','senate_recommendation'],
      ['ARS, Hilo','4000000.00','Schatz','senate_recommendation'],
      ['University of Kentucky Martin-Gatton College of Agriculture, Food and Environment.','10000000.00','McConnell','senate_recommendation'],
      ['USDA BARC','3000000.00','Van Hollen','senate_recommendation']]);
  });
  it('reads all real House consolidated XLSX data rows', async () => {
    const result=await readHouseCpfWorkbook(path.join(data,'house_fy2026_cpf_consolidated.xlsx'),2026);
    expect(result.sheetName).toBe('asRequestedCPFs_FY26'); expect(result.sourceRows).toBe(5414);
    expect(result.candidates).toHaveLength(5363); expect(result.rejected).toHaveLength(51);
    expect(result.rejected[0]).toEqual({page:null,row:129,reason:'missing required text field'});
    expect(result.candidates.slice(0,5).map(x=>[x.requesterName,x.recipientName,x.projectTitle,x.requestedAmountUsd])).toEqual([
      ['Alma Adams',"My Brother's Keeper Charlotte-Mecklenburg",'Youth Impact Office','200000.00'],
      ['Alma Adams','Center for Employment Opportunities','Job Training & Career Pathways for North Carolina’s Returning Citizens','250000.00'],
      ['Alma Adams','Johnson C. Smith University','Johnson C. Smith University: Workforce Skills Enhancement through Equipment','1396000.00'],
      ['Alma Adams','The Center for Community Transitions, Inc. (CCT)','Second Chance Employment & In-Custody Behavioral Health Support','700000.00'],
      ['Alma Adams','University of North Carolina at Charlotte','Technology Improvements for Airfield Pavement and Operations. Charlotte Douglas International Airport (CLT)','2500000.00'],
    ]);
    expect(result.candidates.slice(0,5).every(x=>x.finalAmountUsd===null && x.amountStageRaw==='amount_requested')).toBe(true);
  });
});
