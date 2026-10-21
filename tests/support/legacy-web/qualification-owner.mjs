/** Pure replay-intent preflight; archive bodies still execute every old assertion. */
export function historicalReplayMode(argv) {
  if (argv.length !== 1 || argv[0] !== '--historical-replay') {
    throw new Error('Historical Web qualification requires exactly --historical-replay. Canonical current frontend parity owner: capiro-frontend. See tests/support/legacy-web/QUALIFICATION-OWNERSHIP.json.');
  }
  return 'historical';
}
