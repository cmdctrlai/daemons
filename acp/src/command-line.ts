/**
 * The agent command the user registered, e.g. `dsh acp` or
 * `qwen --acp --approval-mode default`, split into an executable and its
 * arguments the way a POSIX shell would quote them – without running a shell,
 * so nothing in the string is expanded or executed by us.
 */
export function parseCommandLine(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) args.push(current);
      current = '';
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`Unterminated ${quote} quote in agent command`);
  if (inWord) args.push(current);
  if (args.length === 0) throw new Error('The agent command is empty');
  return args;
}
