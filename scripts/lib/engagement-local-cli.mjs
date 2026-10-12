// Keep local acceptance entrypoints inert until an operator explicitly selects a run.
// Their proof options are value-bearing and may be repeated; the downstream parsers
// retain their existing last-value-wins behavior.
export const PHASE1_LOCAL_OPTIONS = [
  'sha',
  'evidence-dir',
  'db-port',
  'post-db-port',
  'post-main-port',
  'post-shadow-port',
  'post-web-port',
  'strict-db-port',
  'background-observe-ms',
];

export function requireLocalRun(argv, usage, allowedOptions) {
  if (
    (argv.length === 1 && argv[0] === '--help') ||
    (argv.length === 2 && argv[0] === '--run' && argv[1] === '--help')
  ) {
    console.log(usage);
    process.exit(0);
  }
  if (argv[0] !== '--run') {
    console.error(usage);
    process.exit(2);
  }

  const values = argv.slice(1);
  const allowed = new Set(allowedOptions);
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    const separator = argument.indexOf('=');
    const option = separator < 0 ? argument.slice(2) : argument.slice(2, separator);
    const value = separator < 0 ? values[++index] : argument.slice(separator + 1);
    if (
      !argument.startsWith('--') ||
      !allowed.has(option) ||
      !value ||
      value.startsWith('--')
    ) {
      console.error(usage);
      process.exit(2);
    }
  }
  return values;
}
