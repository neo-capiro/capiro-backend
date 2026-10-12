/** Refuse accidental disposable-database rehearsal before any child process. */
export function requirePhase8DbRun(scriptName, argv) {
  const usage = `Usage: node scripts/${scriptName} --run`;
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (argv.length !== 1 || argv[0] !== '--run') {
    console.error(usage);
    process.exit(2);
  }
}
