import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Current behavior and ownership contract. Exact extraction snapshot evidence
// is a separate explicit script under docs/backend-runtime-cleanup-20261016.
// No application/framework/compiler/child-process import is needed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const serviceSource = read('apps/api/src/directory/directory.service.ts');
const helperSource = read('apps/api/src/directory/directory-detail-mappers.ts');
const typeImport = "import type { DirectoryMemberDetail, DirectoryStaffDetail } from './directory-detail.types.js';\n";
const definitions = [
  ['mapMemberOffices', "DirectoryMemberDetail['offices']"],
  ['mapLeaderships', "DirectoryMemberDetail['leaderships']"],
  ['mapContactMethods', "DirectoryMemberDetail['socialContacts']"],
  ['mapStaffRoles', "DirectoryMemberDetail['staffRoles']"],
  ['mapStaffIssues', "DirectoryMemberDetail['staffIssues']"],
  ['mapStaffPositions', "DirectoryStaffDetail['positions']"],
  ['mapStaffOfficeAddresses', "DirectoryStaffDetail['officeAddresses']"],
];
const names = definitions.map(([name]) => name);
const normalizeLines = source => source.split('\n').map(line => line.trim()).filter(Boolean).join('\n');

function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, 'one exact finite source operand');
  return source.replace(from, to);
}

function inspectOwnership(service, helper) {
  assert.equal(helper.slice(0, helper.indexOf('export function ')), typeImport + '\n', 'the pure module has only its declared type import');
  assert.doesNotMatch(helper.replace(typeImport, ''), /\b(?:import|require)\s*(?:\(|['"]|\{)/, 'the pure helper has no runtime import or require port');
  assert.deepEqual([...helper.matchAll(/^export function (\w+)\(/gm)].map(match => match[1]), names);
  const imported = [...service.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/directory-detail-mappers\.js['"];?/g)];
  assert.equal(imported.length, 1, 'one canonical helper import');
  assert.deepEqual(imported[0][1].split(',').map(name => name.trim()).filter(Boolean).sort(), [...names].sort());
  const parts = definitions.map(([name, type], index) => {
    const declaration = 'export function ' + name + '(raw: unknown): ' + type + ' {\n';
    const start = helper.indexOf(declaration);
    assert.ok(start >= 0, name + ': helper signature');
    const end = index + 1 < names.length ? helper.indexOf('export function ' + names[index + 1] + '(', start) : helper.length;
    assert.ok(end > start);
    const part = helper.slice(start, end).trimEnd() + '\n';
    assert.ok(part.endsWith('\n}\n'), name + ': complete pure function');
    const body = part.slice(part.indexOf('\n') + 1, part.lastIndexOf('\n}'));
    assert.equal(normalizeLines(service).includes(normalizeLines(body)), false, name + ': copied algorithm outside its canonical owner');
    const wrapper = '  private ' + name + '(raw: unknown): ' + type + ' {\n    return ' + name + '(raw);\n  }\n';
    assert.equal(service.split(wrapper).length, 2, name + ': exact raw forwarding wrapper');
    assert.equal([...service.matchAll(new RegExp('^  private ' + name + '\\(', 'gm'))].length, 1, name + ': one private method owner');
    return part;
  });
  return { parts };
}

// Check the finite source boundary before native stripping/loading. This does
// not pin unrelated service bytes, mapper body hashes, caller count or layout.
inspectOwnership(serviceSource, helperSource);
const stripped = stripTypeScriptTypes(helperSource, { mode: 'strip' });
const subject = await import('data:text/javascript;base64,' + Buffer.from(stripped).toString('base64'));

function assertCases(name, cases) {
  for (const raw of [undefined, null, false, 0, '', 'not-an-array', { row: 'not-an-array' }])
    assert.deepEqual(subject[name](raw), [], name + ': nonarray input');
  assert.deepEqual(subject[name]([null, undefined, false, 0, '', 'not-a-record']), [], name + ': filtered primitive entries');
  for (const { raw, expected } of cases) {
    const before = structuredClone(raw);
    assert.deepEqual(subject[name](raw), expected, name + ': complete DTO output');
    assert.deepEqual(raw, before, name + ': caller input unchanged');
  }
}

test('member offices preserve raw field projection, finite-ID coercion and district/class strings', () => {
  assertCases('mapMemberOffices', [{
    raw: [
      { office: { office_id: '42', name: 'House' }, office_type_id: 'HM', state_id: 'CA', district_no: 0,
        party: 'D', senate_class: 2, outgoing_status: false, status: 'In office', start_date: 'start', end_date: '', updated_at: 'u' },
      { office: { office_id: null, name: '' }, office_type_id: 0, state_id: false, district_no: '',
        party: '', senate_class: null, outgoing_status: '', status: 0, start_date: false, end_date: 0, updated_at: '' },
      {},
    ],
    expected: [
      { officeId: 42, name: 'House', officeTypeId: 'HM', state: 'CA', district: '0', party: 'D', senateClass: '2',
        outgoingStatus: false, status: 'In office', startDate: 'start', endDate: '', updatedAt: 'u' },
      { officeId: 0, name: '', officeTypeId: 0, state: false, district: '', party: '', senateClass: null,
        outgoingStatus: '', status: 0, startDate: false, endDate: 0, updatedAt: '' },
      { officeId: null, name: null, officeTypeId: null, state: null, district: null, party: null, senateClass: null,
        outgoingStatus: null, status: null, startDate: null, endDate: null, updatedAt: null },
    ],
  }]);
});

test('leaderships preserve ordering, nullish defaults, falsy values and legacy array-object admission', () => {
  assertCases('mapLeaderships', [{
    raw: [{}, { position: 'Chair', start_date: 's', end_date: 0, updated_at: false }, []],
    expected: [
      { position: null, startDate: null, endDate: null, updatedAt: null },
      { position: 'Chair', startDate: 's', endDate: 0, updatedAt: false },
      { position: null, startDate: null, endDate: null, updatedAt: null },
    ],
  }]);
});

test('contact methods retain only string contacts including empty and untrimmed values', () => {
  assertCases('mapContactMethods', [{
    raw: [{}, { contact_string: 42 }, { contact_string: '', contact_type: 0, updated_at: false },
      { contact_string: ' raw ', contact_type: 'Email', updated_at: 'u' }],
    expected: [{ type: 0, value: '', updatedAt: false }, { type: 'Email', value: ' raw ', updatedAt: 'u' }],
  }]);
});

test('staff roles preserve nested nullish member fallback and zero-producing coercions', () => {
  assertCases('mapStaffRoles', [{
    raw: [{}, { staffer: { member_id: null }, member_id: '41', role_name: 'LD', updated_at: 'u' },
      { staffer: { member_id: '' }, member_id: 99, role_name: false, updated_at: 0 },
      { member_id: null }, { member_id: 'not-number' }],
    expected: [
      { memberId: null, roleName: null, updatedAt: null },
      { memberId: 41, roleName: 'LD', updatedAt: 'u' },
      { memberId: 0, roleName: false, updatedAt: 0 },
      { memberId: 0, roleName: null, updatedAt: null },
      { memberId: null, roleName: null, updatedAt: null },
    ],
  }]);
});

test('staff issues preserve issue text, nullish defaults and finite-ID conversions', () => {
  assertCases('mapStaffIssues', [{
    raw: [{}, { member_id: '41', issue_name: ' Space ', updated_at: 'u' },
      { member_id: null, issue_name: '', updated_at: false },
      { member_id: false, issue_name: 0, updated_at: 0 }, { member_id: 'broken' }],
    expected: [
      { memberId: null, issueName: null, updatedAt: null },
      { memberId: 41, issueName: ' Space ', updatedAt: 'u' },
      { memberId: 0, issueName: '', updatedAt: false },
      { memberId: 0, issueName: 0, updatedAt: 0 },
      { memberId: null, issueName: null, updatedAt: null },
    ],
  }]);
});

test('staff positions preserve strict flags, nested member choice and preferred-name whitespace semantics', () => {
  const empty = { officeId: null, officeName: null, memberId: null, title: null, positionType: null,
    isCurrent: false, isOnLeave: false, startDate: null, endDate: null, updatedAt: null, member: null };
  assertCases('mapStaffPositions', [{
    raw: [{},
      { office: { office_id: null, name: 'Desk' }, member: { member_id: '7', profile: {
        preferred_first_name: '', first_name: 'Fallback', preferred_last_name: null, last_name: '  Name  ' },
        party: false, state_id: '', district_no: null, office_type_id: 0 }, position_title: 0,
        position_type: false, is_current: 1, is_on_leave: 'true', start_date: 0, end_date: '', updated_at: false },
      { member: { member_id: 0, profile: { first_name: ' Ada ', last_name: ' Lovelace ' },
        party: 'I', state_id: 'CA', district_no: 0, office_type_id: false }, is_current: true, is_on_leave: true },
      { member: [] }],
    expected: [empty,
      { officeId: 0, officeName: 'Desk', memberId: 7, title: 0, positionType: false,
        isCurrent: false, isOnLeave: false, startDate: 0, endDate: '', updatedAt: false,
        member: { memberId: 7, fullName: 'Name', party: null, state: '', district: null, officeTypeId: '0' } },
      { ...empty, memberId: 0, isCurrent: true, isOnLeave: true,
        member: { memberId: 0, fullName: 'Ada   Lovelace', party: 'I', state: 'CA', district: '0', officeTypeId: 'false' } },
      { ...empty, member: { memberId: null, fullName: null, party: null, state: null, district: null, officeTypeId: null } }],
  }]);
});

test('staff office addresses preserve all fields, finite IDs, false values and strict main-office flag', () => {
  const empty = { addressId: null, officeId: null, officeName: null, label: null, address1: null, address2: null,
    city: null, state: null, zip: null, zipExt: null, phone: null, fax: null, isMain: false, publicNotes: null, updatedAt: null };
  assertCases('mapStaffOfficeAddresses', [{
    raw: [{}, { id: null, office: { office_id: '9', name: 0 }, title: '', address1: 'a1', address2: 0,
      city: false, state_id: 'DC', zip: '', zip_ext: 123, phone: 'p', fax: false, is_main: 1, public_notes: 0, updated_at: '' },
    { id: 'bad', office: { office_id: false }, is_main: true }],
    expected: [empty,
      { addressId: 0, officeId: 9, officeName: 0, label: '', address1: 'a1', address2: 0, city: false, state: 'DC',
        zip: '', zipExt: 123, phone: 'p', fax: false, isMain: false, publicNotes: 0, updatedAt: '' },
      { ...empty, officeId: 0, isMain: true }],
  }]);
});

test('seven raw forwarding wrappers retain one pure algorithm owner while unrelated service edits remain free', () => {
  const proof = inspectOwnership(serviceSource, helperSource);
  const wrongArgument = replaceOnce(serviceSource, 'return mapMemberOffices(raw);', 'return mapMemberOffices([]);');
  assert.throws(() => inspectOwnership(wrongArgument, helperSource));
  const copiedAlgorithm = serviceSource + '\n' + proof.parts[0].replace('export function mapMemberOffices(', 'function copiedMemberOffices(');
  assert.throws(() => inspectOwnership(copiedAlgorithm, helperSource));
  const runtimeImport = "import 'node:fs';\n" + helperSource;
  assert.throws(() => inspectOwnership(serviceSource, runtimeImport));
  const runtimeCall = helperSource.replace('  return ', "  require('node:fs');\n  return ");
  assert.notEqual(runtimeCall, helperSource);
  assert.throws(() => inspectOwnership(serviceSource, runtimeCall));
  assert.doesNotThrow(() => inspectOwnership('// unrelated future service comment\n' + serviceSource, helperSource));
});
