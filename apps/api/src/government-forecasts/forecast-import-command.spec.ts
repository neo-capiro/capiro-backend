import {
  FORECAST_IMPORT_USAGE,
  parseImportArgs,
  qualifyImport,
} from './forecast-import-command.js';

describe('finite publisher import command', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const args = [
    '--input',
    'synthetic.xml',
    '--edition',
    '202510',
    '--sha256',
    'a'.repeat(64),
    '--observed-at',
    '2026-10-31T00:00:00Z',
  ];
  it('help requires no source/database and default is read-only', () => {
    expect(parseImportArgs(['--help'], now)).toEqual({ help: true });
    expect(FORECAST_IMPORT_USAGE).toContain('no database connection');
    expect(parseImportArgs(args, now)).toMatchObject({ apply: false, failure: false });
  });
  it.each(
    [
      [],
      ['--apply'],
      ['--input'],
      ['--input', '--edition', '202510'],
      [...args.slice(0, -1)],
      [...args, '--input', 'other.xml'],
      [...args, '--unknown'],
      ['--record-failure', '--observed-at', '2026-10-31T00:00:00Z'],
      [...args.slice(0, -1), '2026-02-30T00:00:00Z'],
      [...args.slice(0, -1), '2026-11-02T00:00:00Z'],
    ].map((input) => ({ input })),
  )('refuses malformed or unallocated inputs $input', ({ input }) => {
    expect(() => parseImportArgs(input, now)).toThrow();
  });
  it('rejects an absent argument slot rather than indexing through it', () => {
    expect(() => parseImportArgs(new Array<string>(1), now)).toThrow('Invalid import arguments');
  });
  it('explicit failure mode cannot silently act as source ingestion', () => {
    expect(
      parseImportArgs(
        ['--record-failure', '--observed-at', '2026-10-31T00:00:00Z', '--apply'],
        now,
      ),
    ).toMatchObject({ failure: true, apply: true });
    expect(() => parseImportArgs([...args, '--record-failure', '--apply'], now)).toThrow();
  });
  it('refuses modified source bytes before parsing/publication', () => {
    expect(() =>
      qualifyImport('<modified/>', { edition: '202510', sha256: 'a'.repeat(64) }),
    ).toThrow('hash');
  });
});
