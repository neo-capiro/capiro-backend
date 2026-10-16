import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ONE-TIME extraction evidence for source7b6bda7/blob4bce0f9.
// Intentionally not imported by current tests, package scripts or CI jobs.
// Future unrelated Directory edits should not be compared to this snapshot.
const sha = source => createHash('sha256').update(source).digest('hex');
const typeImport = "import type { DirectoryMemberDetail, DirectoryStaffDetail } from './directory-detail.types.js';\n";
const definitions = [
  ['mapMemberOffices', "DirectoryMemberDetail['offices']", '459f92390b95e90d5641b7afb0493f8d9efd496bd87604c5d3cfa2bcc0790306'],
  ['mapLeaderships', "DirectoryMemberDetail['leaderships']", '46b0219db76491529241b1a1e36eec6e74c254ad9f74b5e4b4749a4147fb108c'],
  ['mapContactMethods', "DirectoryMemberDetail['socialContacts']", '78eb99be917e69878fde6d2e5668585e68e43e5fbfaf36c61592cb60598e0ce8'],
  ['mapStaffRoles', "DirectoryMemberDetail['staffRoles']", 'db18a6ee87c224ae4985d97da5e0994f54612270f073b166bf5f58a60abc1ade'],
  ['mapStaffIssues', "DirectoryMemberDetail['staffIssues']", 'd670504f5f8ecf527da5a55624436fd61b2013005c434c942c965a1d8142377c'],
  ['mapStaffPositions', "DirectoryStaffDetail['positions']", '3754bafad32dda4075fd8d73383912482cc7d1df42243497a344e2c231345b26'],
  ['mapStaffOfficeAddresses', "DirectoryStaffDetail['officeAddresses']", '5adba6f1de6b96a8928d91febd7313375b00dfcbf332c77429494f8424f5836a'],
];
const names = definitions.map(([name]) => name);
const importBlock = 'import {\n' + names.map(name => `  ${name},`).join('\n') + "\n} from './directory-detail-mappers.js';\n";
const wrappers = definitions.map(([name, type]) =>
  `  private ${name}(raw: unknown): ${type} {\n    return ${name}(raw);\n  }\n`).join('\n') + '\n';

function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, 'one exact finite source operand');
  return source.replace(from, to);
}

export function verifyDirectoryExtractionSource(service, helper) {
  assert.equal(helper.slice(0, helper.indexOf('export function ')), typeImport + '\n', 'only the declared type import precedes pure functions');
  assert.deepEqual([...helper.matchAll(/^export function (\w+)\(/gm)].map(match => match[1]), names);
  const parts = definitions.map(([name, type, identity], index) => {
    const declaration = `export function ${name}(raw: unknown): ${type} {\n`;
    const start = helper.indexOf(declaration);
    assert.ok(start >= 0, name + ': exact helper signature');
    const end = index + 1 < names.length ? helper.indexOf(`export function ${names[index + 1]}(`, start) : helper.length;
    assert.ok(end > start);
    const part = helper.slice(start, end).trimEnd() + '\n';
    assert.equal(sha(part), identity, name + ': original algorithm bytes after declaration/indent move');
    return part;
  });
  const originalMethods = parts.map(part => part.replace(/^export function /, 'private ')
    .split('\n').map(line => line ? '  ' + line : line).join('\n'));
  const originalRegion = originalMethods.join('\n') + '\n';
  assert.equal(sha(originalRegion), '326acc03ec067f10b00efd107fb301114be777dc6fd1e8daec2ac235db5a70c2');
  let restored = replaceOnce(service, importBlock, '');
  restored = replaceOnce(restored, wrappers, originalRegion);
  assert.equal(sha(restored), 'eeb60d50ffa8492330055bb085a10763363a7959185c6f7ae996b6ac134a1b47',
    'entire former service reconstructs: all callers, signatures, module/receiver behavior and other source retained');
  const member = service.slice(service.indexOf('  async getMemberDetail('), service.indexOf('  async getStaffDetail('));
  const staff = service.slice(service.indexOf('  async getStaffDetail('), service.indexOf('  private buildRosterOnlyStaffDetail('));
  for (const operand of [
    'offices: this.mapMemberOffices(row.member_offices),',
    'officeAddresses: this.mapStaffOfficeAddresses(row.office_member_addresses),',
    'leaderships: this.mapLeaderships(row.leaderships),',
    'socialContacts: this.mapContactMethods(row.social_media),',
    'staffRoles: this.mapStaffRoles(row.staffer_roles),',
    'staffIssues: this.mapStaffIssues(row.staffer_issues),',
  ]) assert.equal(member.split(operand).length, 2, operand);
  for (const operand of [
    'emails: this.mapContactMethods(row.staff_emails),',
    'socialContacts: this.mapContactMethods(row.social_media),',
    'officeAddresses: this.mapStaffOfficeAddresses(row.office_member_addresses),',
    'positions: this.mapStaffPositions(row.positions),',
    "socialContacts: this.mapContactMethods(row.social_media).length ? 'available' : 'not_provided',",
  ]) assert.equal(staff.split(operand).length, 2, operand);
  assert.equal([...service.matchAll(/this\.map(?:MemberOffices|Leaderships|ContactMethods|StaffRoles|StaffIssues|StaffPositions|StaffOfficeAddresses)\(/g)].length, 11);
  return { originalMethods };
}


if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') {
    process.stderr.write('One-time source proof requires explicit --run; it is not a current CI gate.\n');
    process.exitCode = 2;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const read = path => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
    const service = read('apps/api/src/directory/directory.service.ts');
    const helper = read('apps/api/src/directory/directory-detail-mappers.ts');
    verifyDirectoryExtractionSource(service, helper);
    assert.throws(() => verifyDirectoryExtractionSource('// unrelated future service comment\n' + service, helper));
    process.stdout.write(JSON.stringify({ source: '7b6bda7ca75ea86afb36c76f013f550fdd79e42f',
      originalServiceBlob: '4bce0f9ccfe1fe5dbd383ca18b8fd5a602839754', functions: 7, callers: 11,
      originalServiceSha256: 'eeb60d50ffa8492330055bb085a10763363a7959185c6f7ae996b6ac134a1b47',
      unrelatedChangeRefusedByOneTimeSnapshot: true, qualification: 'one-time-source-extraction-proof' }, null, 2) + '\n');
  }
}
