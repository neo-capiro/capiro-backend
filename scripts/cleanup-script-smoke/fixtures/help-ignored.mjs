// Owned adversarial fixture: ignores --help and runs "full work" with no usage
// line. The runner must classify this as `help-ignored`, not a pass.
console.log('did work:', process.argv.slice(2).join(' ') || '(no args)');
process.exit(0);
