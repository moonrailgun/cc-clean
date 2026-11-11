// Interpret literal command syntax only; historical commands are never evaluated.
export function historyCommand(command: unknown, depth = 0): string[] | undefined {
  if (typeof command !== 'string' || command.length > 16_384 || depth > 3 || /[\x00-\x08\x0a-\x1f\x7f]/.test(command)) return;
  const segments: {word: string; assignment: boolean}[][] = [[]];
  let word = '', started = false, quote = '', start = 0;
  const flush = () => {
    if (started) segments.at(-1)!.push({word, assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(command.slice(start))});
    word = ''; started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (!started && char !== ' ' && char !== '\t') start = i;
    if (quote === "'") {
      if (char === quote) quote = ''; else word += char;
    } else if (char === '\\') {
      if (++i === command.length) return;
      if (quote === '"' && !'"\\$`'.includes(command[i])) word += '\\';
      word += command[i]; started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else if ('$`'.includes(char)) return;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char; started = true;
    } else if (char === ' ' || char === '\t') flush();
    else if (char === '&' && command[i + 1] === '&') {
      flush(); if (!segments.at(-1)!.length) return;
      segments.push([]); i++;
    } else if (';&|<>`$#(){}'.includes(char)) return;
    else { word += char; started = true; }
  }
  if (quote) return;
  flush();
  for (const words of segments.slice(0, -1)) {
    const segment = words.map(token => token.word);
    const path = segment[1] === '--' ? segment[2] : segment[1];
    if (segment[0] !== 'cd' || segment.length !== (segment[1] === '--' ? 3 : 2) || !path || path.startsWith('-')) return;
  }
  const final = segments.at(-1)!;
  while (final[0]?.assignment) final.shift();
  return historyArgv(final.map(token => token.word), depth);
}

export function historyArgv(input: unknown, depth = 0): string[] | undefined {
  if (!Array.isArray(input) || !input.length || !input.every(arg => typeof arg === 'string') || depth > 3) return;
  const args = [...input] as string[];
  const assignments = () => { while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? '')) args.shift(); };
  if (!args.length) return;
  args[0] = args[0].split('/').at(-1)!;
  if (args[0] === 'env') {
    if (args.length === 1) return args;
    args.shift();
    while (args[0]?.startsWith('-')) {
      const flag = args.shift();
      if (flag === '--') break;
      if (flag === '-i' || flag === '--ignore-environment') continue;
      if ((flag === '-u' || flag === '--unset') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(args[0] ?? '')) { args.shift(); continue; }
      return;
    }
    assignments();
    return historyArgv(args, depth + 1);
  }
  if (['sh', 'bash', 'zsh'].includes(args[0]))
    return args.length === 3 && ['-c', '-lc'].includes(args[1]) ? historyCommand(args[2], depth + 1) : undefined;
  if (['npx', 'bunx'].includes(args[0])) {
    args.shift();
    while (['--no-install', '-y', '--yes', '--'].includes(args[0])) args.shift();
    if (!args.length || args[0].startsWith('-')) return;
    return historyArgv(args, depth + 1);
  }
  if ((args[0] === 'pnpm' && ['exec', 'dlx'].includes(args[1])) || args[0] === 'npm' && args[1] === 'exec') {
    args.splice(0, 2);
    if (args.at(0) === '--') args.shift();
    if (!args.length || args[0].startsWith('-')) return;
    return historyArgv(args, depth + 1);
  }
  if (args[0] === 'uv' && args[1] === 'run') {
    args.splice(0, 2);
    if (args.at(0) === '--') args.shift();
    if (!args.length || args[0].startsWith('-')) return;
    return historyArgv(args, depth + 1);
  }
  if (/^python(?:3(?:\.\d+)?)?$/.test(args[0]) && args[1] === '-m' && ['pytest', 'mypy', 'ruff', 'pip'].includes(args[2]))
    return historyArgv(args.slice(2), depth + 1);
  if (args[0] === 'node') {
    const entry = /(?:^|\/)node_modules\/(?:\.bin\/(tsc|vitest|jest|eslint|prettier)|typescript\/bin\/(tsc)|vitest\/(vitest)\.mjs)$/.exec(args[1] ?? '');
    if (!entry) return;
    return [entry[1] ?? entry[2] ?? entry[3], ...args.slice(2)];
  }
  if (args[0] === 'cd' || args[0] === 'npm' && ['run', 'run-script', 'test'].includes(args[1])) return;
  return args;
}
