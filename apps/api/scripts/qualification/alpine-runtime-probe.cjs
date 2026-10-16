/* Offline qualification only. LibSQL uses :memory: SELECT only; no external DB, migrations or secrets. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { selectedPlatform } = require('./qualification-platform.cjs');
const platform = selectedPlatform();
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30000 });
function assertDumbInitVersion(file = 'dumb-init', args = ['--version'], { timeout = 30000 } = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'dumb-init version command must exit successfully');
  assert.match(result.stdout + result.stderr, /dumb-init v?1\.2\.5/);
}
function contained(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function elfMetadata(data) {
  assert(data.length >= 64 && data.subarray(0, 4).toString('hex') === '7f454c46', 'native artifact must be ELF');
  assert.equal(data[4], 2, 'ELF64 required'); assert.equal(data[5], 1, 'little-endian ELF required');
  const number = offset => { const value = data.readBigUInt64LE(offset); assert(value <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(value); };
  const sectionOffset = number(40), sectionSize = data.readUInt16LE(58), sectionCount = data.readUInt16LE(60);
  assert(sectionSize >= 64 && sectionCount > 0 && sectionCount <= 8192, 'bounded ELF sections required');
  assert(sectionOffset + sectionSize * sectionCount <= data.length, 'truncated ELF sections');
  const section = index => {
    assert(index < sectionCount);
    const offset = sectionOffset + index * sectionSize;
    const value = { type: data.readUInt32LE(offset + 4), offset: number(offset + 24), size: number(offset + 32), link: data.readUInt32LE(offset + 40) };
    if (value.type !== 8) assert(value.offset + value.size <= data.length, 'truncated ELF section');
    return value;
  };
  const needed = [], search = []; let soname = null;
  for (let i = 0; i < sectionCount; i++) {
    const dynamic = section(i); if (dynamic.type !== 6) continue;
    const strings = section(dynamic.link); assert.equal(strings.type, 3); assert.equal(dynamic.size % 16, 0);
    for (let offset = dynamic.offset; offset < dynamic.offset + dynamic.size; offset += 16) {
      const tag = number(offset); if (tag === 0) break;
      if (![1, 14, 15, 29].includes(tag)) continue; // Dynamic strings, never arbitrary matching bytes.
      const start = number(offset + 8); assert(start < strings.size);
      const end = data.indexOf(0, strings.offset + start);
      assert(end >= 0 && end < strings.offset + strings.size, 'unterminated ELF dependency');
      const value = data.toString('utf8', strings.offset + start, end);
      if (tag === 1) needed.push(value);
      else if (tag === 14) soname = value;
      else search.push({ kind: tag === 15 ? 'RPATH' : 'RUNPATH', value });
    }
  }
  const glibc = needed.some(name => name === 'libc.so.6' || /^ld-linux-/.test(name));
  const musl = needed.some(name => /^libc\.musl-|^ld-musl-/.test(name));
  assert(!(glibc && musl), 'conflicting ELF libc dependencies');
  return { class: 64, machine: data.readUInt16LE(18), needed, soname, search, libc: glibc ? 'glibc' : musl ? 'musl' : null };
}
function boundedChild(file, args, { timeout = 30000, maxBuffer = 1024 * 1024 } = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout, maxBuffer, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', NODE_ENV: 'production', TMPDIR: '/dev/shm', HOME: '/nonexistent',
      CAPIRO_QUALIFICATION_ARCH: platform.cpu } });
  return { status: result.status, signal: result.signal, error: result.error ? { code: result.error.code || 'CHILD_ERROR' } : null,
    stdout: (result.stdout || '').slice(0, maxBuffer), stderr: (result.stderr || '').slice(0, maxBuffer) };
}
async function collectChecks(checks, emit = () => {}) {
  const rows = [];
  for (const check of checks) {
    let row;
    try { row = { name: check.name, status: 'PASS', value: await check.run() }; }
    catch (error) { row = { name: check.name, status: 'HOLD', error: { code: error.code || error.name || 'ERROR', message: String(error.message).slice(0, 4096) }, ...(error.child ? { child: error.child } : {}), ...(error.evidence ? { evidence: error.evidence } : {}) }; }
    rows.push(row); emit(row);
  }
  return { status: rows.every(row => row.status === 'PASS') ? 'PASS' : 'HOLD', rows };
}
function createReceiptStream(write = line => console.log(line)) {
  let count = 0;
  return { emit: (kind, value) => write('CORE_NATIVE_RECEIPT ' + JSON.stringify({ sequence: ++count, kind, value })), write, get count() { return count; } };
}
function compactGateSummary(report, outcome, fatal) {
  const gates = report.gates || [], failed = gates.filter(row => row.status !== 'PASS');
  const bounded = value => String(value || '').slice(0, 512);
  return { status: report.status, outcome, gateCount: gates.length, failedCount: failed.length,
    failures: failed.slice(0, 32).map(row => ({ name: bounded(row.name), code: bounded(row.error?.code), message: bounded(row.error?.message) })),
    ...(fatal ? { fatal: { code: bounded(fatal.code || fatal.name), message: bounded(fatal.message) } } : {}) };
}
function completeReceiptReport(report, stream, kind, summary) {
  stream.emit(kind, summary); report.receiptCount = stream.count;
  stream.write(JSON.stringify(report, null, 2));
}
function binaryFormat(data) {
  const magicHex = data.subarray(0, 16).toString('hex');
  if (data.subarray(0, 4).toString('hex') === '7f454c46') return { format: 'ELF', magicHex, elf: elfMetadata(data) };
  if (data.length >= 8 && data.subarray(0, 8).toString('hex') === '0061736d01000000') return { format: 'WEBASSEMBLY_V1', magicHex, native: false };
  if (data.length >= 64 && data.toString('ascii', 0, 2) === 'MZ') {
    const offset = data.readUInt32LE(60);
    assert(offset >= 64 && offset + 24 <= data.length && data.toString('hex', offset, offset + 4) === '50450000', 'invalid/truncated PE signature');
    const machine = data.readUInt16LE(offset + 4), count = data.readUInt16LE(offset + 6), optional = data.readUInt16LE(offset + 20);
    assert(count > 0 && count <= 96 && optional >= 2 && offset + 24 + optional + count * 40 <= data.length, 'bounded PE headers required');
    const kind = data.readUInt16LE(offset + 24);
    assert([0x10b, 0x20b].includes(kind) && optional >= (kind === 0x20b ? 112 : 96), 'unsupported/truncated PE optional header');
    if ([0xaa64, 0x8664].includes(machine)) assert.equal(kind, 0x20b, 'PE machine/header contradiction');
    if (machine === 0x14c) assert.equal(kind, 0x10b, 'PE machine/header contradiction');
    return { format: 'PE', magicHex, os: 'win32', cpu: ({ 0xaa64: 'arm64', 0x8664: 'x64', 0x14c: 'ia32' })[machine] || null, machine, validation: 'BOUNDED_HEADER_ONLY' };
  }
  if (data.length >= 32 && data.readUInt32LE(0) === 0xfeedfacf) {
    const cpuType = data.readUInt32LE(4), commands = data.readUInt32LE(16), size = data.readUInt32LE(20);
    assert([2, 6, 8].includes(data.readUInt32LE(12)), 'unsupported Mach-O file type');
    assert(commands > 0 && commands <= 4096 && 32 + size <= data.length, 'bounded Mach-O load commands required');
    let offset = 32;
    for (let i = 0; i < commands; i++) { assert(offset + 8 <= 32 + size, 'truncated Mach-O command'); const length = data.readUInt32LE(offset + 4); assert(length >= 8 && offset + length <= 32 + size, 'invalid Mach-O command size'); offset += length; }
    assert.equal(offset, 32 + size, 'Mach-O command table size mismatch');
    return { format: 'MACH_O_64_LE', magicHex, os: 'darwin', cpu: ({ 0x100000c: 'arm64', 0x1000007: 'x64' })[cpuType] || null, cpuType, validation: 'BOUNDED_HEADER_ONLY' };
  }
  return { format: 'UNKNOWN', magicHex, native: null };
}
// Exact published quickjs-wasi@2.2.0 bytes; source-only format provenance, never native or runtime acceptance.
const quickjsWasm = {
  'base64': [12518, 'f51012d6c63195a53ca9f2daa6c3de6b0995873888c8106979813015b3388adc'],
  'crypto': [187423, '3c0ca1e0ecbca51f88ae22ae5da75ee83e6f87170ec8c7efc2ec9ba52b1bd913'],
  'encoding': [12780, '50af2847297183c0be2f97948cd83473b0888b424b98af51aaf4200160dce77f'],
  'headers': [14232, 'fcc7d25dfdda38d1d57d0a532540f3baa56a957f76f85548919716a174ac9037'],
  'structured-clone': [9648, '76356bc2983ce24b6c503a0cb1fa0308e09c18e60aa38d44ca737454ee769c06'],
  'url': [920499, '54167390c210290f0703752527000ba44885606c4ed1ae12be30462c147a9215'],
};
function wasmVendorEvidence(owner, relative, bytes, sha256) {
  if (['pdfjs-dist', '@prisma/client', 'prisma'].includes(owner.name)) return require('./runtime-closure-contract.cjs').lockedWasmEvidence(owner, relative, bytes, sha256);
  const key = Object.keys(quickjsWasm).find(name => relative === `extensions/${name}/${name}.so`);
  const expected = key && quickjsWasm[key];
  return { package: `${owner.name}@${owner.version}`, relative, sha256, bytes,
    verified: owner.name === 'quickjs-wasi' && owner.version === '2.2.0' && !!expected && expected[0] === bytes && expected[1] === sha256,
    tarballSHA256: 'f4dd386c2e705ffb8692a8afdc1e3b8ff09c6b8ef3aee48d0537ff71d8839cd1',
    scope: 'VENDOR_BYTE_IDENTITY_AND_WASM_V1_HEADER_ONLY', nativeLoad: 'NOT_APPLICABLE', providerOperation: 'UNRUN' };
}
function inspectArtifact(file, options = {}) {
  let row = { file: path.resolve(file), format: 'UNREADABLE_OR_INVALID_ARTIFACT' };
  try {
    const stat = fs.statSync(file), basename = path.basename(file);
    const named = /\.node$|\.(?:dll|dylib|wasm)$|\.so(?:\.[0-9]+)*$|^schema-engine(?:-(?:linux|darwin|windows).*)?$/.test(basename)
      && !/\.(?:js|json|map|sha256|gz)$/.test(basename);
    assert(stat.isFile(), 'regular artifact required');
    const descriptor = fs.openSync(file, 'r'), header = Buffer.alloc(4);
    try { fs.readSync(descriptor, header, 0, 4, 0); } finally { fs.closeSync(descriptor); }
    const magic = header.toString('hex');
    const recognized = ['7f454c46', '0061736d', 'cffaedfe', 'cefaedfe', 'feedface', 'feedfacf',
      'cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca'].includes(magic) || header.toString('ascii', 0, 2) === 'MZ';
    if (!named && !recognized) return null;
    assert(stat.size <= 512 * 1024 * 1024, 'bounded regular artifact required');
    const data = fs.readFileSync(file);
    row = { file: fs.realpathSync(file), bytes: stat.size, mode: stat.mode & 0o777, sha256: createHash('sha256').update(data).digest('hex'), magicHex: data.subarray(0, 16).toString('hex'), format: 'UNKNOWN' };
    row.binary = binaryFormat(data); row.format = row.binary.format;
    row.classification = classifyNativeArtifact(file, options);
    assert(row.format !== 'UNKNOWN', 'unknown artifact format; no native operation or exemption justified');
    if (row.format === 'WEBASSEMBLY_V1') assert(row.classification.vendor?.verified, 'WASM header identified; vendor provenance unknown');
  } catch (error) { row.inspectionError = { code: error.code || error.name, message: String(error.message).slice(0, 2048) }; }
  return row;
}
function fileIdentity(file) {
  file = fs.realpathSync(file); const stat = fs.statSync(file);
  assert(stat.isFile() && stat.size <= 512 * 1024 * 1024, 'bounded regular file required');
  const data = fs.readFileSync(file);
  return { file, bytes: data.length, mode: stat.mode & 0o777, sha256: createHash('sha256').update(data).digest('hex'), elf: elfMetadata(data) };
}
function parseLoaderMappings(output) {
  return output.split('\n').flatMap(line => {
    const match = /^\s*(\S+)\s+=>\s+(\/\S+)\s+\(0x[0-9a-f]+\)\s*$/.exec(line);
    return match ? [{ dependency: match[1], file: match[2] }] : [];
  });
}
const unwindSymbols = ['_Unwind_Resume', '_Unwind_GetIP', '_Unwind_GetCFA', '_Unwind_FindEnclosingFunction', '_Unwind_Backtrace',
  '_Unwind_GetLanguageSpecificData', '_Unwind_GetIPInfo', '_Unwind_GetRegionStart', '_Unwind_SetGR', '_Unwind_SetIP',
  '_Unwind_GetTextRelBase', '_Unwind_GetDataRelBase', '__deregister_frame', '__register_frame', '_Unwind_Resume_or_Rethrow', '_Unwind_RaiseException'];
// Inspection only: definitions and calculated addresses never establish actual process symbol lookup.
function elfSymbolFacts(data, names = unwindSymbols) {
  const elf = elfMetadata(data); assert.equal(elf.machine, platform.machine, `provider must be ${platform.cpu}`);
  assert(names.length <= 64 && names.every(name => /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name)), 'bounded symbol names required');
  const wanted = new Set(names), number = offset => { assert(offset >= 0 && offset + 8 <= data.length); const n = data.readBigUInt64LE(offset); assert(n <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(n); };
  const range = (offset, size) => assert(Number.isSafeInteger(offset + size) && offset >= 0 && size >= 0 && offset + size <= data.length, 'ELF table outside bytes');
  const sectionOffset = number(40), sectionSize = data.readUInt16LE(58), count = data.readUInt16LE(60);
  const sections = Array.from({ length: count }, (_, index) => {
    const at = sectionOffset + index * sectionSize;
    const row = { index, type: data.readUInt32LE(at + 4), offset: number(at + 24), size: number(at + 32), link: data.readUInt32LE(at + 40), entrySize: number(at + 56) };
    if (row.type !== 8) range(row.offset, row.size); return row;
  });
  const strings = (table, offset) => {
    assert(table?.type === 3 && offset >= 0 && offset < table.size, 'invalid symbol string table');
    const end = data.indexOf(0, table.offset + offset); assert(end >= 0 && end < table.offset + table.size && end - table.offset - offset <= 4096, 'bounded terminated ELF string required');
    return data.toString('utf8', table.offset + offset, end);
  };
  const versions = new Map(); let versionRows = 0;
  for (const s of sections.filter(row => [0x6ffffffd, 0x6ffffffe].includes(row.type))) {
    const table = sections[s.link]; let relative = 0;
    while (relative < s.size) {
      assert(++versionRows <= 4096, 'ELF version table bound');
      const at = s.offset + relative, definition = s.type === 0x6ffffffd, header = definition ? 20 : 16;
      assert(relative + header <= s.size && data.readUInt16LE(at) === 1, 'invalid/truncated ELF version header');
      const auxCount = data.readUInt16LE(at + (definition ? 6 : 2)); assert(auxCount > 0 && auxCount <= 4096, 'ELF version auxiliary bound');
      let aux = relative + data.readUInt32LE(at + (definition ? 12 : 8));
      for (let index = 0; index < auxCount; index++) {
        const size = definition ? 8 : 16; assert(aux >= relative + header && aux + size <= s.size, 'ELF version auxiliary outside table');
        const pos = s.offset + aux, id = definition ? data.readUInt16LE(at + 4) : data.readUInt16LE(pos + 6);
        const name = strings(table, data.readUInt32LE(pos + (definition ? 0 : 8)));
        if (!definition || index === 0) {
          const key = id & 0x7fff, value = { name, kind: definition ? 'DEFINITION' : 'REQUIREMENT', flags: definition ? data.readUInt16LE(at + 2) : data.readUInt16LE(pos + 4) };
          assert(!versions.has(key) || JSON.stringify(versions.get(key)) === JSON.stringify(value), 'ambiguous ELF version index'); versions.set(key, value);
        }
        const next = data.readUInt32LE(pos + (definition ? 4 : 12));
        if (index + 1 < auxCount) { assert(next >= size, 'invalid ELF version auxiliary chain'); aux += next; }
      }
      const next = data.readUInt32LE(at + (definition ? 16 : 12)); if (!next) break;
      assert(next >= header && relative + next > relative && relative + next < s.size, 'invalid ELF version chain'); relative += next;
    }
  }
  const tables = sections.filter(row => row.type === 11); assert(tables.length > 0 && tables.length <= 4, 'dynamic symbol table unavailable/bounded');
  const symbols = []; let inspected = 0;
  for (const s of tables) {
    assert(s.entrySize === 24 && s.size % 24 === 0 && s.size / 24 <= 262144, 'bounded ELF64 dynamic symbols required');
    const versym = sections.filter(row => row.type === 0x6fffffff && row.link === s.index); assert(versym.length <= 1, 'ambiguous symbol versions');
    if (versym.length) assert(versym[0].size === (s.size / 24) * 2, 'truncated symbol versions');
    for (let index = 0; index < s.size / 24; index++) {
      assert(++inspected <= 262144, 'total dynamic symbol bound'); const at = s.offset + index * 24;
      const name = strings(sections[s.link], data.readUInt32LE(at)); if (!wanted.has(name)) continue;
      assert(symbols.length < 256, 'matching symbol bound');
      const info = data[at + 4], sectionIndex = data.readUInt16LE(at + 6), version = versym.length ? data.readUInt16LE(versym[0].offset + index * 2) : null;
      assert(sectionIndex < count || [0xfff1, 0xfff2].includes(sectionIndex), 'unsupported/invalid extended symbol section index');
      const id = version === null ? null : version & 0x7fff;
      symbols.push({ name, index, tableSection: s.index, defined: sectionIndex !== 0, sectionIndex,
        value: '0x' + data.readBigUInt64LE(at + 8).toString(16), bytes: '0x' + data.readBigUInt64LE(at + 16).toString(16),
        binding: info >> 4, type: info & 15, visibility: data[at + 5] & 3,
        version: { index: id, hidden: version !== null && !!(version & 0x8000), descriptor: id !== null && id > 1 ? versions.get(id) || { status: 'UNKNOWN_VERSION_INDEX' } : null } });
    }
  }
  const programOffset = number(32), programSize = data.readUInt16LE(54), programCount = data.readUInt16LE(56);
  assert(programCount > 0 && programCount <= 128 && programSize >= 56, 'bounded program headers required'); range(programOffset, programCount * programSize);
  const loads = [];
  for (let index = 0; index < programCount; index++) {
    const at = programOffset + index * programSize; if (data.readUInt32LE(at) !== 1) continue;
    const offset = number(at + 8), fileSize = number(at + 32), memorySize = number(at + 40); range(offset, fileSize); assert(fileSize <= memorySize, 'invalid PT_LOAD sizes');
    loads.push({ offset, fileSize, memorySize, virtualAddress: '0x' + data.readBigUInt64LE(at + 16).toString(16), alignment: '0x' + data.readBigUInt64LE(at + 48).toString(16), flags: data.readUInt32LE(at + 4) });
  }
  assert(loads.length > 0, 'PT_LOAD unavailable');
  return { elf, symbols, loads, inspectedDynamicSymbols: inspected, missingNames: [...wanted].filter(name => !symbols.some(row => row.name === name)), actualProcessLookup: 'UNOBSERVED' };
}
function mappedSymbolFacts(data, maps, file, names = unwindSymbols) {
  assert(Buffer.byteLength(maps) <= 256 * 1024, 'map text bound'); const facts = elfSymbolFacts(data, names), ranges = [];
  for (const line of maps.split('\n')) {
    const match = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S+)\s+([0-9a-f]+)\s+\S+\s+\S+\s+(\/.*)$/.exec(line);
    if (match?.[5] !== file) continue; assert(ranges.length < 128, 'per-provider map range bound');
    const start = BigInt('0x' + match[1]), end = BigInt('0x' + match[2]); assert(end > start, 'invalid map range');
    ranges.push({ start: '0x' + match[1], end: '0x' + match[2], permissions: match[3], offset: '0x' + match[4] });
  }
  const biases = new Set();
  for (const m of ranges) for (const segment of facts.loads) {
    const delta = BigInt(segment.offset) - BigInt(m.offset), alignment = BigInt(segment.alignment);
    if (delta < 0n || alignment < 1n || delta >= alignment || BigInt(segment.virtualAddress) < delta) continue;
    const bias = BigInt(m.start) - (BigInt(segment.virtualAddress) - delta); if (bias >= 0n) biases.add('0x' + bias.toString(16));
  }
  const candidates = facts.symbols.filter(s => s.defined && s.sectionIndex < 0xff00 && [0, 1, 2].includes(s.type)).map(s => ({ name: s.name, symbolIndex: s.index,
    addresses: [...biases].map(bias => { const address = BigInt(bias) + BigInt(s.value); return { address: '0x' + address.toString(16), inMappedRange: ranges.some(m => BigInt(m.start) <= address && address < BigInt(m.end)) }; }) }));
  return { ...facts, mapRanges: ranges, loadBiasCandidates: [...biases], calculatedSymbolAddresses: candidates, addressScope: 'CALCULATED_CANDIDATES_NOT_OBSERVED_LOOKUP; TLS/IFUNC/absolute/common symbols have no ordinary calculated address', status: ranges.length && biases.size === 1 ? 'STATIC_PROVIDER_FACTS_ONLY' : 'MAPPING_BIAS_UNPROVEN' };
}
function collectSymbolProviders(mapped, maps, addon, names = unwindSymbols, { read = file => fs.readFileSync(file) } = {}) {
  const rows = [], allowed = ['/app/node_modules/.pnpm', '/lib', '/usr/lib', '/usr/local/bin', '/usr/local/lib'];
  for (const identity of [addon, ...mapped.filter(row => row.file !== addon.file)].slice(0, 16)) {
    let row = { file: identity.file, sha256: identity.sha256, bytes: identity.bytes, actualProcessLookup: 'UNOBSERVED' };
    try {
      assert(allowed.some(root => contained(root, identity.file)), 'provider escapes observed roots');
      const data = read(identity.file); assert(data.length <= 512 * 1024 * 1024 && data.length === identity.bytes, 'provider size changed/bound');
      assert.equal(createHash('sha256').update(data).digest('hex'), identity.sha256, 'provider hash changed');
      row.facts = mappedSymbolFacts(data, maps, identity.file, names);
      assert.equal(createHash('sha256').update(read(identity.file)).digest('hex'), identity.sha256, 'provider changed after inspection');
      row.status = row.facts.status;
    } catch (error) { row.status = 'PROVIDER_FACTS_UNVERIFIED'; row.error = { code: error.code || error.name, message: String(error.message).slice(0, 2048) }; }
    rows.push(row);
  }
  return { requestedSymbols: names, providers: rows, providerSetTruncated: mapped.length + (mapped.some(row => row.file === addon.file) ? 0 : 1) > 16,
    actualProcessLookup: 'UNOBSERVED', policy: 'NO_NEW_SYMBOL_EXEMPTION; static exports/maps are not accepted runtime lookup proof' };
}
function assertRuntimeLibc(receipt, evidence) {
  try {
    assert.equal(evidence.inspectionErrors?.length || 0, 0, 'incomplete mapping/loader evidence');
    return verifyRuntimeLibc(receipt, evidence);
  } catch (error) { error.evidence = { receipt, runtimeEvidence: evidence }; throw error; }
}
function verifyRuntimeLibc(receipt, evidence) {
  assert.equal(receipt.elf.machine, platform.machine); assert.notEqual(receipt.state, 'INCOMPATIBLE');
  assert.equal(evidence.addon.file, receipt.file); assert.equal(evidence.addon.sha256, receipt.sha256);
  assert(evidence.dlopen.some(row => row.file === receipt.file && row.sha256 === receipt.sha256), 'exact addon dlopen identity missing');
  assert(evidence.mapped.some(row => row.file === receipt.file && row.sha256 === receipt.sha256), 'actual mapped addon identity missing');
  assert.equal(evidence.runtime.platform, 'linux'); assert.equal(evidence.runtime.arch, platform.cpu);
  assert.equal(evidence.runtime.glibc, null, 'glibc runtime contradicts musl');
  const musl = evidence.musl;
  assert.equal(musl.file, evidence.expectedLoader.file); assert.equal(musl.sha256, evidence.expectedLoader.sha256);
  assert.equal(musl.elf.machine, platform.machine);
  assert.match(evidence.banner, new RegExp(`^musl libc \\(${platform.bannerCpu}\\)\\s+Version \\d+\\.\\d+\\.\\d+`));
  assert(['/lib', '/usr/lib'].some(root => contained(root, musl.file)), 'musl runtime escapes system library roots');
  assert(evidence.mapped.some(row => row.file === musl.file && row.sha256 === musl.sha256), 'actual mapped musl identity missing');
  assert(!evidence.mapped.some(row => row.elf.libc === 'glibc' || row.elf.soname === 'libc.so.6'), 'mapped glibc evidence contradicts musl');
  assert(evidence.mapped.every(row => ['/app/node_modules/.pnpm', '/lib', '/usr/lib', '/usr/local/bin', '/usr/local/lib'].some(root => contained(root, row.file))), 'unexplained mapped library outside deployed/system roots');
  assert.equal(evidence.loader.unexplained.length, 0, 'unexplained loader resolution failure');
  assert(evidence.loader.status === 0 || evidence.loader.nodeSymbols.length > 0, 'loader failure has no explained Node API symbols');
  const libcNeeds = receipt.elf.needed.filter(name => name === 'libc.so' || /^libc\.musl-|^ld-musl-/.test(name));
  if (receipt.elf.libc === null) assert(libcNeeds.length > 0, 'unknown dependency ABI has no resolvable libc evidence');
  for (const dependency of libcNeeds) {
    const matches = evidence.resolved.filter(row => row.dependency === dependency);
    assert.equal(matches.length, 1, 'unique actual loader libc resolution required');
    assert.equal(matches[0].file, musl.file); assert.equal(matches[0].sha256, musl.sha256);
  }
  return { ...receipt, staticState: receipt.state, state: 'COMPATIBLE', libc: 'musl', runtimeEvidence: evidence };
}
async function observeNativeLoad(file, operation = () => require(file)) {
  const addon = fileIdentity(file), expectedLoader = fileIdentity(platform.loader);
  const bannerResult = boundedChild(platform.loader, ['--version'], { maxBuffer: 128 * 1024 });
  const banner = (bannerResult.stdout + bannerResult.stderr).trim();
  const list = boundedChild(platform.loader, ['--list', addon.file], { maxBuffer: 256 * 1024 });
  const nodeSymbols = [], unexplained = [];
  for (const line of list.stderr.split('\n').filter(Boolean)) {
    const prefix = `Error relocating ${addon.file}: `;
    const symbol = line.startsWith(prefix) ? line.slice(prefix.length).match(/^((?:napi_|node_api_|uv_|_ZN2v8|_ZN4node)[A-Za-z0-9_]+): symbol not found$/) : null;
    if (symbol) nodeSymbols.push(symbol[1]); else unexplained.push(line.slice(0, 1024));
  }
  const dlopen = [], original = process.dlopen;
  process.dlopen = function(module, filename, ...args) { const identity = fileIdentity(filename); dlopen.push({ file: identity.file, sha256: identity.sha256 }); return original.call(this, module, filename, ...args); };
  let value, operationError;
  try { value = await operation(); } catch (error) { operationError = error; } finally { process.dlopen = original; }
  const inspectionErrors = [];
  const inspect = file => { try { return fileIdentity(file); } catch (error) {
    inspectionErrors.push({ file, code: error.code || error.name, message: String(error.message).slice(0, 2048) }); return null;
  } };
  let maps = '';
  try { maps = fs.readFileSync('/proc/self/maps', 'utf8'); assert(Buffer.byteLength(maps) <= 256 * 1024, 'mapped text exceeds bound'); }
  catch (error) { inspectionErrors.push({ source: '/proc/self/maps', message: String(error.message).slice(0, 2048) }); maps = maps.slice(0, 256 * 1024); }
  const paths = [...new Set(maps.split('\n').flatMap(line => {
    const match = /^[0-9a-f]+-[0-9a-f]+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line);
    return match ? [match[1]] : [];
  }))];
  if (paths.length > 256) inspectionErrors.push({ source: '/proc/self/maps', message: 'mapped object count exceeds bound' });
  const mapped = paths.slice(0, 256).map(inspect).filter(Boolean);
  const mappings = parseLoaderMappings(list.stdout);
  if (mappings.length > 256) inspectionErrors.push({ source: 'loader stdout', message: 'resolved object count exceeds bound' });
  const resolved = mappings.slice(0, 256).map(row => ({ dependency: row.dependency, ...inspect(row.file) }));
  const symbolProviders = unexplained.length ? collectSymbolProviders(mapped, maps, addon) : null;
  const evidence = { addon, expectedLoader, musl: inspect(platform.loader), banner, bannerResult,
    runtime: { platform: process.platform, arch: process.arch, glibc: process.report.getReport().header.glibcVersionRuntime || null },
    mapped, mappedPaths: paths.slice(0, 256), resolved, dlopen, inspectionErrors, symbolProviders,
    operationCompleted: !operationError, addonAfter: inspect(addon.file),
    searchPolicy: 'FIXED_CREDENTIAL_FREE_ENV_NO_LD_OVERRIDES; ELF RPATH/RUNPATH retained',
    loader: { ...list, nodeSymbols, unexplained } };
  // Record evidence before policy assertions; main flushes it after the bounded gate summary.
  if (require.main === module) {
    (report.nativeObservations ||= []).push(evidence);
    const line = 'CORE_NATIVE_EVIDENCE ' + JSON.stringify(evidence);
    if (['--native-child', '--libsql-child', '--sharp-child', '--dispatcher-child'].includes(process.argv[2])) console.log(line);
    else bufferReceipt(line);
  }
  if (operationError) { operationError.evidence = { runtimeEvidence: evidence }; throw operationError; }
  try {
    assert(!bannerResult.error && !bannerResult.signal, 'musl identity query failed');
    assert(!list.error && !list.signal, 'loader observation unavailable');
    assert.equal(evidence.addonAfter?.sha256, addon.sha256, 'addon bytes changed during load');
  } catch (error) { error.evidence = { runtimeEvidence: evidence }; throw error; }
  return { value, evidence };
}
async function nativeChild(file) {
  const receipt = classifyNativeArtifact(file);
  assert.equal(receipt.format, 'ELF', 'only inspected ELF addons may enter native Linux load');
  assert.notEqual(receipt.state, 'INCOMPATIBLE', 'incompatible raw load forbidden');
  const observed = await observeNativeLoad(receipt.file);
  return { receipt: assertRuntimeLibc(receipt, observed.evidence) };
}
async function libsqlChild(manifest) {
  const root = fs.realpathSync('/app/node_modules/.pnpm'); manifest = fs.realpathSync(manifest);
  assert(contained(root, manifest), 'LibSQL owner escapes deployed store');
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(metadata.name, 'libsql'); assert.equal(metadata.version, '0.5.29');
  const ownerRequire = createRequire(manifest), entry = fs.realpathSync(ownerRequire.resolve('./'));
  assert(contained(path.dirname(manifest), entry), 'LibSQL entry escapes owner');
  const entrySha256 = createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
  assert.equal(entrySha256, 'cc6f0fb815d302185ba69d4f749b423dfe304add1c58d6ff687842f8c1e39152', 'LibSQL dispatcher differs from integrity-verified vendor source');
  const dependencyName = platform.libsql;
  assert.equal(metadata.optionalDependencies?.[dependencyName], metadata.version);
  const bindingManifest = resolveInstalledManifest(manifest, dependencyName, root);
  assert(bindingManifest, 'LibSQL selected optional package missing');
  const native = fs.realpathSync(ownerRequire.resolve(dependencyName)), receipt = classifyNativeArtifact(native);
  assert.equal(receipt.owner.root, path.dirname(bindingManifest)); assert.equal(receipt.owner.name, dependencyName);
  assert.equal(receipt.owner.version, metadata.version);
  const nativeProof = platform.cpu === 'arm64'
    ? { sha256: 'e4a292a56e0b4baf88f22ab5ade36e4ea0991a11577b1c31a6fe19f5e4218fb9', bytes: 8731816 }
    : { sha256: 'bed7fdfd3f4139dab101ebafdec8a74ec62799fd65714f1a98918c905597e63d', bytes: 9906912 };
  assert.equal(receipt.sha256, nativeProof.sha256, 'LibSQL native bytes differ from integrity-verified vendor artifact');
  assert.equal(receipt.bytes, nativeProof.bytes);
  assert.notEqual(receipt.state, 'INCOMPATIBLE', 'incompatible LibSQL binding load forbidden');
  const observed = await observeNativeLoad(native, () => {
    const Database = ownerRequire(entry), db = new Database(':memory:');
    try { assert.equal(db.memory, true); const row = db.prepare('SELECT 7 AS qualification_value').get(); assert.equal(row.qualification_value, 7); return row; }
    finally { db.close(); assert.equal(db.open, false); }
  });
  return { relation: 'RETAINED_STORE_LIBSQL_OWNER', applicationReachability: 'UNPROVEN_NO_DIRECT_API_DEPENDENCY',
    manifest, entry, entrySha256, bindingManifest, query: 'SELECT 7 AS qualification_value', database: ':memory:', value: observed.value,
    receipt: assertRuntimeLibc(receipt, observed.evidence) };
}
function parseChildProof(result) {
  if (result.error || result.signal || result.status !== 0) {
    const error = new Error('Bounded child failed; captured output retained in child receipt'); error.child = result;
    const records = result.stdout.split('\n').filter(line => line.startsWith('CORE_NATIVE_EVIDENCE '));
    try { error.evidence = { observations: records.map(line => JSON.parse(line.slice('CORE_NATIVE_EVIDENCE '.length))) }; }
    catch { error.evidence = { status: 'TRUNCATED_OR_INVALID_CHILD_EVIDENCE', rawChildRetained: true }; }
    throw error;
  }
  const records = result.stdout.split('\n').filter(line => line.startsWith('CORE_NATIVE_CHILD '));
  assert.equal(records.length, 1, 'exactly one child proof required');
  return JSON.parse(records[0].slice('CORE_NATIVE_CHILD '.length));
}
function childReceipt(mode, target) {
  return parseChildProof(boundedChild(process.execPath, [__filename, mode, target]));
}
function resolvedNativeBinding(manifest, dependencyName, { root = '/app/node_modules/.pnpm' } = {}) {
  root = fs.realpathSync(root); manifest = fs.realpathSync(manifest);
  assert(contained(root, manifest), 'dispatcher manifest escapes deployed store');
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert(typeof metadata.version === 'string');
  assert.equal(metadata.optionalDependencies?.[dependencyName], metadata.version, 'dispatcher native optional pin mismatch');
  const bindingManifest = resolveInstalledManifest(manifest, dependencyName, root);
  assert(bindingManifest, 'dispatcher native optional package missing');
  const owner = JSON.parse(fs.readFileSync(bindingManifest, 'utf8'));
  assert.equal(owner.name, dependencyName); assert.equal(owner.version, metadata.version);
  const ownerRoot = path.dirname(bindingManifest), files = walk(ownerRoot).filter(file => file.endsWith('.node'));
  assert.equal(files.length, 1, 'one exact resolved native addon required');
  const receipt = classifyNativeArtifact(files[0], { root });
  assert.equal(receipt.owner.root, ownerRoot); assert.equal(receipt.owner.name, dependencyName); assert.equal(receipt.owner.version, owner.version);
  assert.notEqual(receipt.state, 'INCOMPATIBLE', 'incompatible dispatcher binding load forbidden');
  return { bindingManifest, receipt };
}
function readDeployedPackage(manifest, { imageRoot = '/app' } = {}) {
  imageRoot = fs.realpathSync(imageRoot); manifest = fs.realpathSync(manifest);
  const stat = fs.statSync(manifest);
  assert(contained(imageRoot, manifest) && stat.isFile() && stat.size <= 1024 * 1024, 'bounded contained package manifest required');
  const data = fs.readFileSync(manifest), metadata = JSON.parse(data);
  assert(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'package manifest object required');
  for (const key of ['os', 'cpu', 'libc']) assert(metadata[key] === undefined || (Array.isArray(metadata[key]) && metadata[key].every(value => typeof value === 'string')), `invalid package ${key}`);
  return { metadata, row: { manifest, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length,
    name: typeof metadata.name === 'string' ? metadata.name : null, version: typeof metadata.version === 'string' ? metadata.version : null,
    os: metadata.os || null, cpu: metadata.cpu || null, libc: metadata.libc || null,
    format: typeof metadata.name === 'string' && typeof metadata.version === 'string' ? 'NAMED_PACKAGE_MANIFEST' : 'PACKAGE_SCOPE_METADATA' } };
}
function sourceIdentity(file, { imageRoot = '/app', maximumBytes = 65536, content = true } = {}) {
  assert(Number.isInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 65536, 'source prefix byte bound');
  const real = fs.realpathSync(file); assert(contained(fs.realpathSync(imageRoot), real), 'source escapes deployed root');
  assert(/\.(?:[cm]?js|json)$/.test(real), 'source type outside fixed JS/JSON contract');
  const stat = fs.statSync(real); assert(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'bounded regular vendor source required');
  const data = fs.readFileSync(real), hash = createHash('sha256').update(data).digest('hex');
  assert(data.length === stat.size && hash === createHash('sha256').update(fs.readFileSync(real)).digest('hex'), 'source changed during inspection');
  const prefix = data.subarray(0, maximumBytes);
  // Base64 preserves exact source bytes without evaluating code or interpreting terminal escapes.
  return { file: real, sha256: hash, bytes: data.length, contentBase64: content ? prefix.toString('base64') : null,
    capturedBytes: content ? prefix.length : 0, sourceComplete: data.length <= maximumBytes, scope: 'STATIC_SOURCE_BYTES_NOT_EXECUTED' };
}
function vendorSelectorSources(manifest, { imageRoot = '/app' } = {}) {
  const result = { manifest, status: 'UNPROVEN', selectedPayload: 'UNOBSERVED', sources: [], errors: [], packageRelationIsNotPayloadSelection: true };
  try {
    manifest = fs.realpathSync(manifest); const owner = fs.realpathSync(path.dirname(manifest));
    const pkg = readDeployedPackage(manifest, { imageRoot });
    assert(['@openai/codex-security', 'onnxruntime-node'].includes(pkg.metadata.name), 'unapproved selector owner');
    result.owner = pkg.row; result.ownerRoot = owner;
    try { result.entry = fs.realpathSync(createRequire(manifest).resolve('./')); assert(contained(owner, result.entry), 'vendor entry escapes owner'); }
    catch (error) { result.errors.push({ source: 'owner-entry-resolution', message: String(error.message).slice(0, 2048) }); }
    const pending = [owner], files = []; let visited = 0;
    while (pending.length) {
      const dir = pending.shift(); assert(++visited <= 256 && path.relative(owner, dir).split(path.sep).length <= 12, 'vendor directory traversal bound');
      const entries = fs.readdirSync(dir, { withFileTypes: true }); assert(entries.length <= 2048, 'vendor directory entry bound');
      for (const item of entries) {
        const file = path.join(dir, item.name);
        if (item.isDirectory() && item.name !== 'node_modules' && item.name !== '.git') pending.push(file);
        else if (item.isFile() && /\.[cm]?js$/.test(item.name)) { assert(files.length < 128, 'vendor JS file set bound'); files.push(file); }
        else if (item.isSymbolicLink() && /\.[cm]?js$/.test(item.name)) result.errors.push({ file, message: 'Unfollowed vendor JS symlink; source inventory incomplete' });
      }
    }
    if (result.entry && !files.includes(result.entry)) files.unshift(result.entry);
    files.sort((a, b) => (a === result.entry ? -1 : b === result.entry ? 1 : a.localeCompare(b)));
    let total = 0;
    for (const file of files) {
      try {
        assert(total < 256 * 1024, 'owner source capture budget exhausted');
        const row = sourceIdentity(file, { imageRoot, maximumBytes: Math.min(65536, 256 * 1024 - total) });
        assert(contained(owner, row.file), 'vendor source escapes physical owner');
        row.relation = row.file === result.entry ? 'OWNER_RESOLVED_ENTRY' : 'OWNER_SOURCE_SELECTION_UNVERIFIED';
        result.sources.push(row); total += row.capturedBytes;
        if (!row.sourceComplete) result.errors.push({ file, message: 'Vendor source prefix only; selector interpretation incomplete' });
      } catch (error) { result.errors.push({ file, message: String(error.message).slice(0, 2048) }); }
    }
    result.discoveredSourceFiles = files.length; result.capturedSourceBytes = total;
  } catch (error) { result.errors.push({ source: manifest, message: String(error.message).slice(0, 2048) }); }
  return result;
}
function staticImportCandidates(source) {
  assert(Buffer.byteLength(source) <= 65536, 'static scan source bound');
  const edges = []; // Lexical candidates only: strings/comments/transforms can create false positives; never proof of graph completeness.
  const pattern = /\b(?:require\s*\(\s*|import\s*\(\s*|from\s*|import\s*)(['"])([^'"\r\n]{1,256})\1/g;
  for (const match of source.matchAll(pattern)) { assert(edges.length < 128, 'source import candidate bound'); edges.push({ specifier: match[2], offset: match.index }); }
  return edges;
}
function apiReachabilityEvidence(entry = '/app/apps/api/dist/main.js', { imageRoot = '/app', maximumNodes = 64 } = {}) {
  const result = { entry, status: 'UNPROVEN', scope: 'BOUNDED_LEXICAL_IMPORT_CANDIDATES_NOT_COMPLETE_GRAPH', nodes: [], edges: [], errors: [],
    vendorReachability: { '@openai/codex-security': 'UNPROVEN', 'onnxruntime-node': 'UNPROVEN' }, applicationExecuted: false };
  const pending = [entry], seen = new Set(); let bytes = 0;
  while (pending.length) {
    const file = pending.shift(); if (seen.has(file)) continue;
    if (result.nodes.length >= maximumNodes || bytes >= 512 * 1024) { result.errors.push({ source: file, message: 'API candidate graph budget exhausted' }); break; }
    seen.add(file);
    try {
      const row = sourceIdentity(file, { imageRoot, maximumBytes: Math.min(65536, 512 * 1024 - bytes), content: false });
      result.nodes.push(row); bytes += Math.min(row.bytes, 65536);
      if (!row.sourceComplete) { result.errors.push({ source: file, message: 'API source exceeds scan bound; edges incomplete' }); continue; }
      const source = fs.readFileSync(row.file, 'utf8'); assert.equal(createHash('sha256').update(source).digest('hex'), row.sha256, 'graph source changed');
      const candidates = staticImportCandidates(source);
      for (const candidate of candidates) {
        if (result.edges.length >= 256) { result.errors.push({ source: file, message: 'API edge budget exhausted' }); break; }
        const edge = { source: row.file, sourceSha256: row.sha256, ...candidate, status: 'UNRESOLVED' };
        try {
          const resolved = createRequire(row.file).resolve(candidate.specifier);
          if (!path.isAbsolute(resolved)) edge.status = 'BUILTIN_OR_NONFILE';
          else {
            edge.resolved = fs.realpathSync(resolved); assert(contained(fs.realpathSync(imageRoot), edge.resolved), 'graph resolution escapes image');
            edge.status = 'OWNER_RESOLVED_LEXICAL_CANDIDATE';
            if (/\.[cm]?js$/.test(edge.resolved) && !seen.has(edge.resolved)) pending.push(edge.resolved);
          }
        } catch (error) { edge.error = String(error.message).slice(0, 2048); }
        result.edges.push(edge);
      }
    } catch (error) { result.errors.push({ source: file, message: String(error.message).slice(0, 2048) }); }
  }
  result.reason = 'No AST/control-flow/config/plugin proof: dynamic edges, comments/string matches and conditional imports are not resolved by this lexical inventory. No unused/active-package conclusion is authorized.';
  return result;
}
function qualificationInputBindings() {
  const result = { scope: 'FIXED_OPTIONAL_READ_ONLY_PROVENANCE_MOUNTS', status: 'UNPROVEN', inputs: [] };
  for (const file of ['/qualification/source-commit.txt', '/qualification/pnpm-lock.yaml']) {
    try {
      const real = fs.realpathSync(file); assert(contained('/qualification', real), 'qualification input escapes mount root');
      const stat = fs.statSync(real); assert(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'qualification input byte bound');
      const data = fs.readFileSync(real);
      result.inputs.push({ file: real, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length,
        source: file.endsWith('.txt') && /^[a-f0-9]{40}\n$/.test(data.toString()) ? data.toString().trim() : null });
    } catch (error) { result.inputs.push({ file, status: 'UNAVAILABLE_OR_UNVERIFIED', error: String(error.message).slice(0, 2048) }); }
  }
  result.limit = 'Actual mount identity must be joined to the separately reviewed frozen Git source/lock manifest by the coordinator. Existence or a copied hash alone does not prove source/installed-lock equivalence.';
  return result;
}
async function retainedDispatcher(manifest) {
  const root = fs.realpathSync('/app/node_modules/.pnpm'); manifest = fs.realpathSync(manifest);
  assert(contained(root, manifest), 'dispatcher owner escapes store');
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8')), ownerRequire = createRequire(manifest);
  const allowed = { '@napi-rs/canvas': ['0.1.80', '1.0.9'], esbuild: ['0.21.5', '0.28.2'], '@swc/core': ['1.16.2'] };
  assert(allowed[metadata.name]?.includes(metadata.version), 'unreviewed retained dispatcher/version');
  const entry = fs.realpathSync(ownerRequire.resolve('./'));
  assert(contained(path.dirname(manifest), entry), 'dispatcher entry escapes owner');
  const result = { relation: 'RETAINED_STORE_DISPATCHER', manifest, entry, name: metadata.name, version: metadata.version };
  if (metadata.name !== 'esbuild') {
    const dependencyName = metadata.name === '@napi-rs/canvas' ? platform.canvas : platform.swc;
    const expected = resolvedNativeBinding(manifest, dependencyName, { root });
    const observed = await observeNativeLoad(expected.receipt.file, () => {
      const dispatcher = ownerRequire(entry);
      if (metadata.name === '@napi-rs/canvas') assert.equal(dispatcher.createCanvas(2, 2).width, 2);
      else assert(dispatcher.transformSync('const value: number = 1', { jsc: { parser: { syntax: 'typescript' } } }).code);
    });
    assert(observed.evidence.dlopen.every(row => contained(expected.receipt.owner.root, row.file)), 'dispatcher loaded an unexplained native binding');
    result.bindingManifest = expected.bindingManifest;
    result.bindings = [assertRuntimeLibc(expected.receipt, observed.evidence)];
  } else {
    const dispatcher = ownerRequire(entry);
    assert(dispatcher.transformSync('const value: number = 1', { loader: 'ts' }).code);
    const name = platform.esbuild;
    assert.equal(metadata.optionalDependencies?.[name], metadata.version);
    const binaryManifest = resolveInstalledManifest(manifest, name, root); assert(binaryManifest, 'esbuild native optional missing');
    const nativePackage = JSON.parse(fs.readFileSync(binaryManifest, 'utf8'));
    assert.equal(nativePackage.name, name); assert.equal(nativePackage.version, metadata.version);
    const binary = fileIdentity(path.join(path.dirname(binaryManifest), 'bin', 'esbuild'));
    assert(contained(path.dirname(binaryManifest), binary.file)); assert.equal(binary.elf.machine, platform.machine);
    const execution = boundedChild(binary.file, ['--version']);
    assert(!execution.error && !execution.signal && execution.status === 0, 'esbuild binary version execution failed');
    assert.equal(execution.stdout.trim(), metadata.version);
    result.binary = { ...binary, execution, selectionLimit: 'OWNER_RESOLVED_PLATFORM_BINARY; transform passed, service child selection not independently observed' };
  }
  if (metadata.name === 'esbuild') result.bindings = Object.keys(require.cache).filter(file => file.endsWith('.node')).map(file => assertActiveBinding(file));
  return result;
}
function classifyNativeArtifact(file, { root = '/app/node_modules/.pnpm' } = {}) {
  root = fs.realpathSync(root); file = fs.realpathSync(file);
  assert(contained(root, file) && file !== root, 'native artifact escapes inventory root');
  const stat = fs.statSync(file); assert(stat.isFile() && stat.size <= 512 * 1024 * 1024, 'bounded regular native file required');
  let ownerRoot = path.dirname(file), metadata;
  while (contained(root, ownerRoot)) {
    const manifest = path.join(ownerRoot, 'package.json');
    if (fs.existsSync(manifest)) {
      assert(contained(ownerRoot, fs.realpathSync(manifest)) && fs.statSync(manifest).isFile(), 'package manifest escapes owner');
      metadata = JSON.parse(fs.readFileSync(manifest, 'utf8')); break;
    }
    if (ownerRoot === root) break;
    ownerRoot = path.dirname(ownerRoot);
  }
  assert(metadata && typeof metadata.name === 'string' && typeof metadata.version === 'string', 'native package identity missing');
  for (const key of ['os', 'cpu', 'libc']) assert(metadata[key] === undefined || (Array.isArray(metadata[key]) && metadata[key].length > 0 && metadata[key].every(value => typeof value === 'string')), `invalid package ${key}`);
  const data = fs.readFileSync(file), binary = binaryFormat(data), elf = binary.elf;
  const owner = { root: ownerRoot, name: metadata.name, version: metadata.version, os: metadata.os || null, cpu: metadata.cpu || null, libc: metadata.libc || null };
  const sha256 = createHash('sha256').update(data).digest('hex');
  const allows = (list, target) => !list || (!list.includes(`!${target}`) && (!list.some(value => !value.startsWith('!')) || list.includes(target)));
  if (binary.format !== 'ELF') {
    const relative = path.relative(ownerRoot, file).split(path.sep).join('/');
    if (!bundledPayloadRelative({ file, owner })) {
      if (binary.os) assert(allows(owner.os, binary.os), 'package/format OS constraint disagreement');
      if (binary.cpu) assert(allows(owner.cpu, binary.cpu), 'package/format CPU constraint disagreement');
    }
    const vendor = binary.format === 'WEBASSEMBLY_V1' ? wasmVendorEvidence(owner, relative, data.length, sha256) : null;
    return { file, sha256, bytes: data.length, owner, format: binary.format, binary, vendor, libc: null,
      state: binary.os && binary.cpu ? 'INCOMPATIBLE' : 'UNKNOWN',
      reasons: binary.os ? ['positive-foreign-format-os'] : ['NON_NATIVE_OR_UNKNOWN_FORMAT'], nativeQualification: 'NOT_ESTABLISHED' };
  }
  const declaredCpu = owner.cpu && owner.cpu.filter(value => !value.startsWith('!'));
  const machineByCpu = { arm64: 183, x64: 62, arm: 40, ia32: 3, ppc64: 21, s390x: 22, riscv64: 243 };
  if (declaredCpu?.length === 1 && machineByCpu[declaredCpu[0]]) assert.equal(elf.machine, machineByCpu[declaredCpu[0]], 'package/ELF cpu disagreement');
  const observedCpu = Object.keys(machineByCpu).find(cpu => machineByCpu[cpu] === elf.machine);
  if (observedCpu) assert(allows(owner.cpu, observedCpu), 'package/ELF cpu constraint disagreement');
  if (elf.libc) assert(allows(owner.libc, elf.libc), 'package/ELF libc constraint disagreement');
  const reasons = [];
  if (!allows(owner.os, 'linux')) reasons.push('package-os');
  if (!allows(owner.cpu, platform.cpu) || elf.machine !== platform.machine) reasons.push('package-or-elf-cpu');
  const positiveLibc = owner.libc && owner.libc.filter(value => !value.startsWith('!'));
  const declaredLibc = positiveLibc && positiveLibc.length === 1 && ['glibc', 'musl'].includes(positiveLibc[0]) ? positiveLibc[0] : null;
  if (declaredLibc && elf.libc) assert.equal(declaredLibc, elf.libc, 'package/ELF libc disagreement');
  const libc = declaredLibc || elf.libc;
  if (!allows(owner.libc, 'musl') || libc === 'glibc') reasons.push('package-or-elf-libc');
  const state = reasons.length ? 'INCOMPATIBLE' : libc === 'musl' ? 'COMPATIBLE' : 'UNKNOWN';
  return { file, sha256, bytes: data.length, owner, format: 'ELF', binary, elf, libc, state, reasons };
}
function assertActiveBinding(file, options) {
  const receipt = classifyNativeArtifact(file, options);
  assert.equal(receipt.state, 'COMPATIBLE', `active native binding is not proven ${platform.cpu}/musl: ${receipt.owner.name}`);
  return receipt;
}
function resolveInstalledManifest(parentManifest, dependencyName, root) {
  const resolution = require('./runtime-closure-contract.cjs').physicalDependencyLookup(dependencyName);
  const paths = createRequire(parentManifest).resolve.paths(resolution.physicalLookupSpecifier);
  for (const lookup of paths || []) {
    const candidate = path.join(lookup, dependencyName);
    if (!fs.existsSync(candidate)) continue;
    const ownerRoot = fs.realpathSync(candidate), manifest = path.join(ownerRoot, 'package.json');
    assert(contained(root, ownerRoot) && fs.existsSync(manifest), 'resolved dependency owner is not in deployed store');
    const resolvedManifest = fs.realpathSync(manifest);
    assert(contained(ownerRoot, resolvedManifest), 'dependency manifest escapes owner');
    return resolvedManifest;
  }
  return null;
}
function bundledPayloadRelative(receipt) {
  const relative = path.relative(receipt.owner.root, receipt.file).split(path.sep).join('/');
  const bundled = (receipt.owner.name === '@openai/codex-security' && relative.startsWith('_bundled_plugin/mcp/native/')) ||
    (receipt.owner.name === 'onnxruntime-node' && relative.startsWith('bin/napi-v6/'));
  return bundled ? relative : null;
}
function assertOptionalInactive(receipt, parentManifests, { root = '/app/node_modules/.pnpm', imageRoot = '/app' } = {}) {
  const evidence = packageDependencyEvidence(receipt, parentManifests, { root, imageRoot });
  const relative = bundledPayloadRelative(receipt);
  if (relative) {
    const error = new Error('Bundled payload format/owner observed; payload dispatcher selection remains UNVERIFIED');
    error.code = 'BUNDLED_PAYLOAD_SELECTION_UNVERIFIED';
    error.evidence = { payload: receipt, relative, payloadRelation: 'BUNDLED_PAYLOAD_OF_PACKAGE', packageRelations: evidence,
      interpretation: 'Package required/optional and semver admission do not establish payload activation or inactivity' };
    throw error;
  }
  assert(evidence.every(row => row.relation === 'optionalDependencies'), 'incompatible artifact has a required deployed dependency owner');
  return evidence;
}
function installedVersionAdmission(range, version, root) {
  assert(typeof range === 'string' && range.length <= 256 && typeof version === 'string' && version.length <= 128, 'bounded package version declaration required');
  if (range === version) return { admitted: true, basis: 'EXACT_INSTALLED_VERSION' };
  // Use the existing locked deployed node-semver library, never a handwritten range evaluator or network install.
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter(row => row.isDirectory() && row.name.startsWith('semver@')).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifest = path.join(root, entry.name, 'node_modules/semver/package.json');
    if (!fs.existsSync(manifest)) continue;
    const packageRoot = fs.realpathSync(path.dirname(manifest));
    assert(contained(root, packageRoot), 'semver library escapes deployed store');
    const observed = readDeployedPackage(manifest, { imageRoot: root }), metadata = observed.metadata;
    if (metadata.name !== 'semver' || !/^7\.\d+\.\d+$/.test(metadata.version)) continue;
    const ownerRequire = createRequire(manifest), main = fs.realpathSync(ownerRequire.resolve('./'));
    assert(contained(packageRoot, main), 'semver entry escapes owner');
    const semver = ownerRequire(main);
    assert(semver.valid(version) && semver.validRange(range), 'invalid installed semantic version or range');
    return { admitted: semver.satisfies(version, range), basis: 'DEPLOYED_NODE_SEMVER', range,
      version, manifest, manifestSHA256: observed.row.sha256, engineVersion: metadata.version, entry: main, entrySHA256: createHash('sha256').update(fs.readFileSync(main)).digest('hex') };
  }
  throw new Error('Installed semver range engine unavailable; version admission UNVERIFIED');
}
function packageDependencyEvidence(receipt, parentManifests, { root = '/app/node_modules/.pnpm', imageRoot = '/app' } = {}) {
  root = fs.realpathSync(root);
  imageRoot = fs.realpathSync(imageRoot);
  assert.equal(receipt.state, 'INCOMPATIBLE', 'only incompatible artifacts may request an inactive exemption');
  assert(parentManifests.length <= 30000, 'bounded dependency owner set required');
  const evidence = [];
  for (const parent of [...new Set(parentManifests.map(file => fs.realpathSync(file)))]) {
    assert(contained(imageRoot, parent) && fs.statSync(parent).isFile(), 'optional parent escapes deployed image');
    const metadata = JSON.parse(fs.readFileSync(parent, 'utf8'));
    const dependencyName = receipt.owner.name;
    const optional = metadata.optionalDependencies?.[dependencyName];
    const required = metadata.dependencies?.[dependencyName];
    if (optional === undefined && required === undefined) continue;
    assert(typeof metadata.name === 'string' && typeof metadata.version === 'string', 'dependency parent identity missing');
    const resolvedManifest = resolveInstalledManifest(parent, dependencyName, root);
    if (!resolvedManifest || path.dirname(resolvedManifest) !== receipt.owner.root) continue;
    const child = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
    assert.equal(child.name, dependencyName); assert.equal(child.version, receipt.owner.version);
    const relation = optional !== undefined ? 'optionalDependencies' : 'dependencies';
    const declaredVersion = optional !== undefined ? optional : required;
    const versionAdmission = installedVersionAdmission(declaredVersion, child.version, root);
    assert(versionAdmission.admitted, 'installed dependency version not admitted by owner declaration');
    evidence.push({ parentManifest: parent, parentName: metadata.name, parentVersion: metadata.version,
      dependencyName, declaredVersion, resolvedManifest, resolvedOwnerRoot: receipt.owner.root, relation, versionAdmission,
      dependencyResolution: require('./runtime-closure-contract.cjs').physicalDependencyLookup(dependencyName) });
  }
  assert(evidence.length > 0, 'incompatible artifact lacks verified optional dependency ownership');
  return evidence;
}
async function sharpDispatcherProbe(manifest, { root = '/app/node_modules/.pnpm' } = {}) {
  root = fs.realpathSync(root); manifest = fs.realpathSync(manifest);
  const ownerRoot = path.dirname(manifest);
  assert(contained(root, manifest) && fs.statSync(manifest).isFile(), 'Sharp owner escapes store');
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(metadata.name, 'sharp'); assert.equal(metadata.version, '0.35.5');
  const ownerRequire = createRequire(manifest), entry = fs.realpathSync(ownerRequire.resolve('./'));
  assert(contained(ownerRoot, entry) && fs.statSync(entry).isFile(), 'Sharp entry escapes owner');
  const expectedName = platform.sharp;
  assert.equal(metadata.optionalDependencies?.[expectedName], metadata.version, 'Sharp optional binding pin mismatch');
  const bindingManifest = fs.realpathSync(ownerRequire.resolve(`${expectedName}/package`));
  assert(contained(root, bindingManifest) && fs.statSync(bindingManifest).isFile(), 'Sharp optional owner escapes store');
  const expectedRoot = path.dirname(bindingManifest), optional = JSON.parse(fs.readFileSync(bindingManifest, 'utf8'));
  assert.equal(optional.name, expectedName); assert.equal(optional.version, metadata.version);
  const nativeFiles = walk(expectedRoot).filter(file => file.endsWith('.node'));
  assert.equal(nativeFiles.length, 1, 'one inspected Sharp native file required');
  assert.notEqual(classifyNativeArtifact(nativeFiles[0], { root }).state, 'INCOMPATIBLE', 'incompatible Sharp binding load forbidden');
  const observed = await observeNativeLoad(nativeFiles[0], async () => {
    const sharp = ownerRequire(entry);
    return sharp(Buffer.from([17, 31, 47]), { raw: { width: 1, height: 1, channels: 3 } })
      .resize(2, 2, { kernel: 'nearest' }).timeout({ seconds: 5 }).raw().toBuffer({ resolveWithObject: true });
  });
  const pixels = observed.value;
  assert.equal(pixels.info.width, 2); assert.equal(pixels.info.height, 2); assert.equal(pixels.info.channels, 3);
  assert.deepEqual(pixels.data, Buffer.from([17, 31, 47, 17, 31, 47, 17, 31, 47, 17, 31, 47]));
  const selected = Object.keys(require.cache).filter(file => file.endsWith('.node') && contained(expectedRoot, fs.realpathSync(file)));
  assert.equal(selected.length, 1, 'one actual Sharp musl binding required');
  const binding = assertRuntimeLibc(classifyNativeArtifact(selected[0], { root }), observed.evidence);
  assert.equal(binding.owner.root, expectedRoot); assert.equal(binding.owner.name, expectedName);
  assert.equal(binding.owner.version, metadata.version);
  return { relation: 'RETAINED_STORE_SHARP_OWNER', manifest, entry, version: metadata.version, bindingManifest, pixel: [...pixels.data], binding };
}
module.exports = { assertDumbInitVersion, classifyNativeArtifact, assertActiveBinding, assertOptionalInactive, boundedChild, collectChecks, parseLoaderMappings, assertRuntimeLibc, parseChildProof, resolvedNativeBinding, readDeployedPackage, createReceiptStream, completeReceiptReport, inspectArtifact, binaryFormat, wasmVendorEvidence, installedVersionAdmission, packageDependencyEvidence, elfSymbolFacts, mappedSymbolFacts, collectSymbolProviders, sourceIdentity, vendorSelectorSources, staticImportCandidates, apiReachabilityEvidence };
const report = { status: 'STARTED', packages: [], native: [], activeBindings: [] };
const maxBufferedReceiptBytes = 16 * 1024 * 1024;
let pendingReceipts = [], pendingReceiptBytes = 0;
function bufferReceipt(line) {
  pendingReceiptBytes += Buffer.byteLength(line) + 1;
  assert(pendingReceiptBytes <= maxBufferedReceiptBytes, 'bounded probe receipt output required');
  pendingReceipts.push(line);
}
function flushReceipts() {
  for (const line of pendingReceipts) console.log(line);
  pendingReceipts = []; pendingReceiptBytes = 0;
}
function walk(dir, files = [], depth = 0) {
  assert(depth <= 32 && files.length < 200000, 'bounded native directory traversal required');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, files, depth + 1);
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
async function fetchWithWget(url, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('wget', [...extra, '-qO-', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    let data = '', errors = '';
    child.stdout.on('data', chunk => data += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error('wget fixture timeout')); }, 10000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(data) : reject(new Error(`wget failed ${code}: ${errors}`)); });
  });
}
async function fixture(server, protocol, extra = []) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await fetchWithWget(`${protocol}://127.0.0.1:${server.address().port}/health`, extra), 'qualification-health'); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
async function signalProbe() {
  await new Promise((resolve, reject) => {
    const child = spawn('dumb-init', ['--', process.execPath, '-e',
      'process.on("SIGTERM",()=>{console.log("TERM_FORWARDED");process.exit(0)});console.log("READY");setInterval(()=>{},1000)'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', sent = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('signal fixture timeout')); }, 10000);
    child.on('error', reject);
    child.stdout.on('data', data => { output += data; if (!sent && output.includes('READY')) { sent = true; child.kill('SIGTERM'); } });
    child.on('close', code => { clearTimeout(timer); code === 0 && output.includes('TERM_FORWARDED') ? resolve() : reject(new Error('dumb-init did not forward SIGTERM')); });
  });
}
async function main() {
  const appRequire = createRequire('/app/apps/api/package.json');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, platform.cpu);
  assert.equal(process.version, 'v22.23.3'); assert.equal(process.getuid(), 1001); assert.equal(process.getgid(), 1001);
  assert(fs.existsSync(platform.loader), 'musl loader missing');
  assert(!process.report.getReport().header.glibcVersionRuntime, 'glibc runtime detected');
  const stream = createReceiptStream(bufferReceipt);
  report.gates = []; report.artifacts = []; report.sharp = []; report.libsql = []; report.npmPackages = []; report.wasm = [];
  const emit = stream.emit;
  const finish = (kind, summary) => {
    completeReceiptReport(report, stream, kind, summary);
    console.log('CORE_NATIVE_GATE_SUMMARY ' + JSON.stringify(compactGateSummary(report, summary.status || kind)));
    flushReceipts();
  };
  const check = async (name, run) => {
    const result = await collectChecks([{ name, run }], row => { report.gates.push(row); emit('gate', row); });
    return result.rows[0];
  };
  const contract = require('./runtime-closure-contract.cjs');
  let closure;
  const graphGate = await check('production-dependency-closure', () => {
    closure = contract.verifyInstalledClosure();
    const summarize = owner => ({ root: owner.root, manifest: owner.manifest, manifestSHA256: owner.manifestSHA256,
      name: owner.metadata.name, version: owner.metadata.version, snapshot: owner.snapshot,
      integrity: owner.integrity || null, declaredPlatform: owner.declaredPlatform || null, platformAdmission: owner.platformAdmission || null, generatedBy: owner.generatedBy || null });
    report.productionClosure = { status: closure.status, contractSHA256: closure.contractSHA256, target: closure.target,
      visitedNodes: closure.visitedNodes, owners: closure.owners.map(summarize), generated: closure.generated.map(summarize),
      edges: closure.edges, missingOptional: closure.missingOptional, integrityScope: closure.integrityScope,
      traversal: { files: closure.traversal.files.length, directories: closure.traversal.directories, symbolicLinks: closure.traversal.symbolicLinks } };
    emit('production-closure', report.productionClosure); return report.productionClosure;
  });
  if (graphGate.status !== 'PASS') {
    report.status = 'FAIL'; report.fullApiReadiness = 'FULL_API_STARTUP_UNVERIFIED';
    finish('summary', { status: 'HOLD_BEFORE_NATIVE_EXECUTION', gate: graphGate.name });
    process.exitCode = 1; return;
  }
  const files = closure.traversal.files;
  const deployedManifests = [...closure.owners, ...closure.generated].map(owner => owner.manifest);
  for (const parent of ['/app/apps/api/package.json', '/app/packages/shared/package.json', '/app/packages/meriv2-core/package.json', '/app/packages/defense-contracts/package.json', '/app/packages/defense-domain/package.json']) {
    if (fs.existsSync(parent)) deployedManifests.push(parent);
  }
  assert(deployedManifests.length <= 30000, 'bounded deployed package set required');
  const dependencyParents = new Map(), deployedMetadata = new Map();
  for (const manifest of deployedManifests) {
    let metadata;
    try { const observed = readDeployedPackage(manifest); metadata = observed.metadata; deployedMetadata.set(manifest, metadata); report.npmPackages.push(observed.row); emit('npm-package', observed.row); }
    catch (error) {
      const row = { manifest, format: 'UNREADABLE_OR_INVALID_MANIFEST', error: String(error.message).slice(0, 2048) };
      report.npmPackages.push(row); emit('npm-package', row);
      await check('manifest:' + manifest, () => { throw error; }); continue;
    }
    for (const name of new Set([...Object.keys(metadata.dependencies || {}), ...Object.keys(metadata.optionalDependencies || {})])) {
      if (!dependencyParents.has(name)) dependencyParents.set(name, []);
      dependencyParents.get(name).push(manifest);
    }
  }
  assert(files.length <= 200000, 'bounded deployed file set required');
  // Emit the complete observed native set before invoking ANY addon or dispatcher.
  for (const file of files) {
    const artifact = inspectArtifact(file); if (!artifact) continue;
    if (report.artifacts.length >= 2048) { await check('artifact-set-bound', () => { throw new Error('native artifact set exceeds bound; inventory incomplete'); }); break; }
    report.artifacts.push(artifact); emit('artifact', artifact);
    await check('artifact-production-owner:' + artifact.file, () => {
      assert(!artifact.inspectionError, 'unreadable/unknown native artifact');
      artifact.productionOwner = contract.artifactOwner(file, closure);
      assert.equal(artifact.classification.owner.root, artifact.productionOwner.root, 'nested/unvalidated artifact manifest');
      if (artifact.classification.state === 'INCOMPATIBLE')
        artifact.optionalPreloadProof = assertOptionalInactive(artifact.classification, dependencyParents.get(artifact.classification.owner.name) || []);
      emit('artifact-production-owner', { file: artifact.file, ...artifact.productionOwner });
      return artifact.productionOwner;
    });
    if (artifact.format === 'WEBASSEMBLY_V1') await check('wasm-format:' + artifact.file, () => {
      assert(artifact.classification?.vendor?.verified && artifact.productionOwner, 'unverified WASM provenance');
      const data = fs.readFileSync(file); assert.equal(createHash('sha256').update(data).digest('hex'), artifact.sha256);
      assert(WebAssembly.validate(data), 'WASM format validation failed');
      const value = { file: artifact.file, sha256: artifact.sha256, node: process.version,
        scope: 'NON_NATIVE_FORMAT_ONLY', instantiated: false, codecOperation: 'UNRUN' };
      report.wasm.push(value); emit('wasm-format-validation', value); return value;
    });
    if (file.endsWith('.node')) {
      const row = { file: artifact.file, bytes: artifact.bytes || null, sha256: artifact.sha256 || null, state: 'NOT_LOADED', classification: artifact.classification || null, inspectionError: artifact.inspectionError || null };
      report.native.push(row); emit('native-inventory', row);
    }
  }
  // Collect every known bundled owner's static source contract BEFORE loads or selector policy gates.
  report.vendorSelectors = [];
  const selectorOwners = [...deployedMetadata].filter(([, metadata]) => ['@openai/codex-security', 'onnxruntime-node'].includes(metadata.name));
  for (const [manifest] of selectorOwners.slice(0, 4)) {
    const row = vendorSelectorSources(manifest); report.vendorSelectors.push(row); emit('vendor-selector-sources', row);
  }
  if (selectorOwners.length > 4) { const row = { status: 'UNPROVEN', error: 'Bundled selector owner bound exceeded', observedOwners: selectorOwners.length }; report.vendorSelectors.push(row); emit('vendor-selector-sources', row); }
  report.apiReachability = apiReachabilityEvidence(); emit('api-reachability-candidates', report.apiReachability);
  report.qualificationInputs = qualificationInputBindings(); emit('qualification-input-bindings', report.qualificationInputs);
  if (process.argv.includes('--inventory-only')) {
    report.status = 'INVENTORY_ONLY'; report.mode = 'DIAGNOSTIC_INVENTORY';
    finish('inventory-summary', { npmPackages: report.npmPackages.length, artifacts: report.artifacts.length, native: report.native.length }); return;
  }
  if (report.gates.some(row => row.status !== 'PASS')) {
    report.status = 'FAIL'; report.fullApiReadiness = 'FULL_API_STARTUP_UNVERIFIED';
    finish('summary', { status: 'HOLD_BEFORE_NATIVE_EXECUTION', failures: report.gates.filter(row => row.status !== 'PASS').map(row => row.name) });
    process.exitCode = 1; return;
  }
  for (const artifact of report.artifacts) if (artifact.inspectionError) await check('artifact-inspection:' + artifact.file, () => { throw new Error(artifact.inspectionError.message); });
  await check('vendor-runtime', async () => {
  assert.match(run('openssl', ['version']), /^OpenSSL 3\./);
  assert.match(run('wget', ['--version']), /GNU Wget/, 'GNU wget required');
  assertDumbInitVersion();
  const blocks = fs.readFileSync('/lib/apk/db/installed', 'utf8').split('\n\n');
  report.packages = blocks.filter(Boolean).map(block => Object.fromEntries(block.split('\n').filter(line => /^[PVo]:/.test(line)).map(line => [line[0], line.slice(2)])));
  assert(!report.packages.some(p => ['perl', 'util-linux'].includes(p.o || p.P)), 'Perl/util-linux origin unexpectedly installed');
  const zlib = report.packages.find(p => p.P === 'zlib'); assert(zlib, 'zlib absent');
  assert(['=', '>'].includes(run('apk', ['version', '-t', zlib.V, '1.3.2-r1']).trim()), 'zlib vendor fix missing');
  });
  const ownerSet = name => closure.owners.filter(owner => owner.metadata.name === name).map(owner => owner.manifest);
  const sharpOwners = ownerSet('sharp'), libsqlOwners = ownerSet('libsql');
  // Priority independent fixtures run before raw loads, so a different addon cannot hide Sharp.
  await check('sharp-owner-set', () => assert(sharpOwners.length <= 8, 'bounded production Sharp owner set required'));
  if (sharpOwners.length <= 8) for (const manifest of sharpOwners) await check('sharp:' + manifest, () => { const row = childReceipt('--sharp-child', manifest); report.sharp.push(row); return row; });
  await check('libsql-owner-set', () => assert(libsqlOwners.length <= 8, 'bounded production LibSQL owner set required'));
  if (libsqlOwners.length <= 8) for (const manifest of libsqlOwners) await check('libsql:' + manifest, () => { const row = childReceipt('--libsql-child', manifest); report.libsql.push(row); return row; });
  const familyOwners = closure.owners.filter(owner => ['@napi-rs/canvas', '@swc/core', 'esbuild', 'onnxruntime-node'].includes(owner.metadata.name)).map(owner => owner.manifest);
  report.retainedDispatchers = [];
  for (const manifest of familyOwners) {
    const metadata = deployedMetadata.get(manifest); if (!metadata) continue; // Initial manifest error already retained as HOLD.
    if (!['@napi-rs/canvas', '@swc/core', 'esbuild', 'onnxruntime-node'].includes(metadata.name)) continue;
    if (report.retainedDispatchers.length >= 32) { await check('dispatcher-set-bound', () => { throw new Error('retained dispatcher set exceeds bound'); }); break; }
    const gate = await check('retained-dispatcher:' + manifest, () => {
      assert.notEqual(metadata.name, 'onnxruntime-node', 'ONNX actual inference UNRUN: no approved offline model fixture; raw load is insufficient dispatcher evidence');
      return childReceipt('--dispatcher-child', manifest);
    });
    report.retainedDispatchers.push(gate);
  }
  await check('canvas-dispatcher', async () => {
    const pdfEntry = appRequire.resolve('pdf-parse'), pdfRequire = createRequire(pdfEntry);
    const root = fs.realpathSync('/app/node_modules/.pnpm');
    const manifest = resolveInstalledManifest(pdfEntry, '@napi-rs/canvas', root); assert(manifest, 'API-selected Canvas owner missing');
    const expected = resolvedNativeBinding(manifest, platform.canvas, { root });
    const observed = await observeNativeLoad(expected.receipt.file, () => { const canvas = pdfRequire('@napi-rs/canvas'); assert.equal(canvas.createCanvas(2, 2).width, 2); });
    assert(observed.evidence.dlopen.every(row => contained(expected.receipt.owner.root, row.file)), 'Canvas loaded unexplained native binding');
    report.canvas = { relation: 'API_PDF_PARSE_SELECTED_CANVAS', manifest, bindingManifest: expected.bindingManifest, binding: assertRuntimeLibc(expected.receipt, observed.evidence) };
    return report.canvas;
  });
  await check('esbuild-dispatcher', () => {
    const tsxRequire = createRequire(appRequire.resolve('tsx'));
    assert(tsxRequire('esbuild').transformSync('const value: number = 1', { loader: 'ts' }).code);
  });
  await check('prisma-runtime', () => {
  assert(fs.readFileSync('/app/apps/api/prisma/schema.prisma', 'utf8').includes(platform.prisma));
  const engines = files.filter(file => [ `libquery_engine-${platform.prisma}.so.node`, `schema-engine-${platform.prisma}` ].includes(path.basename(file)));
  assert(engines.some(file => file.endsWith('.so.node')), 'musl query engine absent');
  assert(engines.some(file => path.basename(file).startsWith('schema-engine')), 'musl migration engine absent');
  assert(!files.some(file => [ `libquery_engine-${platform.glibcPrisma}.so.node`, `schema-engine-${platform.glibcPrisma}` ].includes(path.basename(file))), 'glibc Prisma engine retained');
  for (const file of engines.filter(file => path.basename(file).startsWith('schema-engine'))) assert.match(run(file, ['--version']), /schema-engine/);
  const cli = fs.realpathSync('/app/apps/api/node_modules/prisma/build/index.js');
  assert.match(run(process.execPath, [cli, '--version']), /5\.22\.0/);
  for (const verb of ['status', 'deploy']) assert.match(run(process.execPath, [cli, 'migrate', verb, '--help']), /migrate/);
  });
  for (const row of report.native) {
    const gate = await check('native:' + row.file, () => {
      assert(row.classification, 'native inspection failed; load forbidden');
      const receipt = row.classification;
      if (receipt.state === 'INCOMPATIBLE') {
        row.optionalEvidence = assertOptionalInactive(receipt, dependencyParents.get(receipt.owner.name) || []);
        row.state = 'INACTIVE_INCOMPATIBLE_OPTIONAL';
      } else {
        const loaded = childReceipt('--native-child', row.file);
        assert.equal(loaded.receipt.file, row.file); assert.equal(loaded.receipt.sha256, row.sha256);
        row.classification = assertRuntimeLibc(receipt, loaded.receipt.runtimeEvidence); row.state = 'LOADED';
      }
      emit('native-outcome', row); return { file: row.file, state: row.state, sha256: row.sha256 };
    });
    if (gate.status !== 'PASS') { row.state = 'HOLD'; row.failure = gate; emit('native-outcome', row); }
  }
  await check('application-safe-imports', () => {
  appRequire('sanitize-html'); appRequire('./dist/meri/meri-tools.service.js'); appRequire('./dist/memory/memory-candidate.service.js');
  run(process.execPath, ['--no-enable-source-maps', '--check', '/app/apps/api/dist/main.js']);
  });
  await check('active-bindings', () => {
    report.activeBindings = Object.keys(require.cache).filter(file => file.endsWith('.node')).map(file => {
      const receipt = classifyNativeArtifact(file);
      if (report.canvas?.binding.file === receipt.file) return assertRuntimeLibc(receipt, report.canvas.binding.runtimeEvidence);
      return assertActiveBinding(file);
    });
    return report.activeBindings;
  });
  let scratch;
  await check('scratch', () => { scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'core-alpine-probe-')); fs.writeFileSync(path.join(scratch, 'writable'), 'ok'); });
  try {
    await check('entrypoint-dispatch', () => {
      assert(scratch, 'scratch prerequisite unavailable');
      const stubDir = '/qualification/dispatch-fixture';
      const dispatch = execFileSync('/usr/local/bin/entrypoint.sh', ['serve'], {
        encoding: 'utf8', timeout: 10000,
        env: { PATH: `${stubDir}:${process.env.PATH}`, TMPDIR: scratch, NODE_ENV: 'test',
          DB_HOST: '127.0.0.1', DB_PORT: '9', DB_USER: 'qualification', DB_PASSWORD: 'fixture-only', DB_NAME: 'qualification' },
      });
      assert.match(dispatch, /QUALIFICATION_SERVE_DISPATCH/);
      report.startup = 'ENTRYPOINT_DISPATCH_ONLY; full API readiness requires isolated fixture qualification';
    });
    if (!process.argv.includes('--static')) {
      await check('read-only-rootfs', () => {
        const ownedRoot = fs.statSync('/app/tmp');
        assert.equal(ownedRoot.uid, 1001); assert(ownedRoot.mode & 0o200, 'probe needs a normally writable owned directory');
        assert.throws(() => fs.writeFileSync('/app/tmp/.qualification-rootfs-write', 'must fail'), error => error.code === 'EROFS', 'run with read-only rootfs; EACCES is not proof');
      });
      await check('loopback-http', () => fixture(http.createServer((req, res) => res.end('qualification-health')), 'http'));
      await check('loopback-tls', async () => {
        assert(scratch, 'scratch prerequisite unavailable');
        const key = path.join(scratch, 'fixture.key'), cert = path.join(scratch, 'fixture.crt');
        run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert]);
        await fixture(https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => res.end('qualification-health')), 'https', ['--ca-certificate', cert]);
      });
      await check('signal-forwarding', async () => { await signalProbe(); report.signal = 'SIGTERM_FORWARDED'; });
    }
  } finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
  report.status = report.gates.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL';
  report.mode = process.argv.includes('--static') ? 'STATIC_NATIVE' : 'OFFLINE_RUNTIME';
  report.fullApiReadiness = 'FULL_API_STARTUP_UNVERIFIED';
  finish('summary', { status: report.status, npmPackages: report.npmPackages.length, native: report.native.length, artifacts: report.artifacts.length, gates: report.gates.length, failures: report.gates.filter(row => row.status !== 'PASS').map(row => row.name) });
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module && ['--native-child', '--libsql-child', '--sharp-child', '--dispatcher-child'].includes(process.argv[2])) {
  (async () => { const result = await (process.argv[2] === '--native-child' ? nativeChild(process.argv[3]) : process.argv[2] === '--sharp-child' ? sharpDispatcherProbe(process.argv[3]) : process.argv[2] === '--dispatcher-child' ? retainedDispatcher(process.argv[3]) : libsqlChild(process.argv[3])); console.log('CORE_NATIVE_CHILD ' + JSON.stringify(result)); })()
    .catch(error => { console.error(JSON.stringify({ status: 'HOLD', code: error.code || error.name, message: String(error.message).slice(0, 4096), ...(error.evidence ? { evidence: error.evidence } : {}) })); process.exitCode = 1; });
} else if (require.main === module) main().catch(error => { report.status = 'FAIL'; report.error = error.message;
  console.log('CORE_NATIVE_GATE_SUMMARY ' + JSON.stringify(compactGateSummary(report, 'UNCAUGHT_ERROR', error)));
  flushReceipts(); console.error(JSON.stringify(report, null, 2)); process.exitCode = 1; });
