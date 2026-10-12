/** Parse offline evaluator commands before opening fixtures, outputs, or runners. */
export function parseEvalCli(options: {
  usage: string;
  valueOptions?: readonly string[];
  actionOptions: readonly string[];
}): { values: Map<string, string>; actions: Set<string> } {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const fail = (message?: string): never => {
    if (message) console.error(message);
    console.error(options.usage);
    process.exit(2);
  };
  if (args.includes('--help') || args.includes('-h')) {
    console.log(options.usage);
    process.exit(0);
  }
  if (args.length === 0) fail();

  const values = new Map<string, string>();
  const actions = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (options.actionOptions.includes(arg)) {
      actions.add(arg);
    } else if (options.valueOptions?.includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) fail(`Missing value for ${arg}`);
      if (!values.has(arg)) values.set(arg, value);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (actions.size === 0 && values.size === 0) fail();
  return { values, actions };
}
