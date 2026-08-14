export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

/** `--flag value` -> flags.flag = "value"; a `--flag` immediately followed by another `--flag` or nothing is a boolean. */
export function parseFlags(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const name = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { positional, flags };
}
