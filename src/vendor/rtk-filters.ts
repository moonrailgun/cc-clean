// Apache-2.0 RTK CLI filters pinned in third_party/rtk/UPSTREAM.md.
import { pipeFilters } from './rtk-pipe.ts';
import { nativeFilters, matchNativeFilter } from './rtk-native.ts';
import { filterRtkRule, matchRtkRule } from './rtk-rules.ts';

export type RtkFilter = string;
const ruleExecutables = new Set('just brew tofu ty swift pio ps yadm ollama ansible-playbook pulumi oxlint markdownlint ping make hadolint mix nx pnpm biome helm gcc g++ pre-commit quarto systemctl jj terraform task rsync du shopify turbo yamllint skopeo poetry shellcheck uv df ssh xcodebuild mise composer trunk mvn java gradle dotnet basedpyright gcloud jq bundle stat jira sops iptables liquibase fail2ban-client'.split(' '));

function gitArgs(argv: string[]): string[] | undefined {
  const args = argv.slice(1);
  while (args[0]?.startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree'].includes(args[0]) && args.length > 1) args.splice(0, 2);
    else if (/^--(?:git-dir|work-tree)=.+/.test(args[0]) || ['--no-pager', '--no-optional-locks'].includes(args[0])) args.shift();
    else return;
  }
  return args;
}

export function matchRtkFilter(argv: string[] | undefined): RtkFilter | undefined {
  if (!argv?.length || argv.join(' ').length > 4096) return;
  const [exe, ...rest] = argv;
  if (exe === 'rg' && rest.includes('--files')) {
    if (rest.every(arg => !arg.startsWith('-') || ['--files', '--hidden', '--no-ignore', '-g', '--glob'].includes(arg))) return 'find';
    return;
  }
  if (['rg', 'grep'].includes(exe)) {
    if (!rest.some(arg => /^--(?:json|files(?:-with(?:out)?-match(?:es)?)?|count(?:-matches)?|replace|passthru|context|before-context|after-context|only-matching|null(?:-data)?|heading|no-filename|no-line-number|quiet|silent|color)(?:=|$)|^-[^-]*[ABClLqUozZch]/.test(arg))) return 'grep';
    return;
  }
  if (exe === 'find') {
    if (rest.every(arg => !arg.startsWith('-') || ['-type', '-name', '-iname', '-path', '-maxdepth', '-mindepth', '-print', '-not'].includes(arg))) return 'find';
    return;
  }
  if (exe === 'fd') {
    if (rest.every(arg => !arg.startsWith('-') || ['--hidden', '--no-ignore', '--type', '-t', '--extension', '-e', '--max-depth', '-d', '--absolute-path', '-a'].includes(arg))) return 'find';
    return;
  }
  if (exe === 'git') {
    const args = gitArgs(argv);
    if (!args) return;
    if (args[0] === 'status') return 'git-status';
    if (args[0] === 'log' && !args.some(arg => /^--(?:format|pretty|raw|numstat|stat|patch)|^-[pcz]/.test(arg))) return 'git-log';
    if (args[0] === 'diff' && !args.some(arg => /^--(?:stat|numstat|shortstat|dirstat|name|raw|word-diff|color-words)|^-z/.test(arg))) return 'git-diff';
    if (['log', 'diff'].includes(args[0])) return;
    const native = matchNativeFilter(['git', ...args]);
    return native && `native:${native}`;
  }
  if (exe === 'gh' && rest[0] === 'pr' && rest[1] === 'diff' || exe === 'glab' && rest[0] === 'mr' && rest[1] === 'diff') {
    if (!rest.some(arg => /^--(?:name|stat|raw)/.test(arg))) return 'git-diff';
    return;
  }
  if (exe === 'gt' && ['status', 'diff'].includes(rest[0])) return matchRtkFilter(['git', ...rest]);
  if (exe === 'cargo' && rest[0] === 'test') return 'cargo-test';
  if (exe === 'go' && ['test', 'build'].includes(rest[0])) return `go-${rest[0]}`;
  if (exe === 'ruff' && ['check', 'format'].includes(rest[0])) return `ruff-${rest[0]}`;
  if (exe === 'sqlfluff' && rest[0] === 'lint') return 'sqlfluff-lint';
  if (['pytest', 'ctest', 'tsc', 'vitest', 'mypy', 'prettier', 'phpunit', 'pest', 'paratest', 'ecs', 'phpstan', 'pint'].includes(exe)) return exe;
  const native = matchNativeFilter(argv);
  if (native) return `native:${native}`;
  if (!ruleExecutables.has(exe)) return;
  // Preserve token boundaries: a quoted argument cannot turn into a subcommand.
  const command = argv.map(arg => /^[\w./:@%+=,*-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ');
  const rule = matchRtkRule(command);
  return rule && `rule:${rule}`;
}

export function filterRtkOutput(filter: RtkFilter, input: string): string {
  // Bound Rust-to-JS regex backtracking and parser allocation on historical data.
  if (Buffer.byteLength(input) > 1_048_576) return input;
  const normalized = input.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(normalized)) return input;
  let result: string;
  if (filter.startsWith('rule:')) {
    if (normalized.split('\n').some(line => line.length > 4096)) return input;
    result = filterRtkRule(filter.slice(5), normalized);
  } else {
    const registry = filter.startsWith('native:') ? nativeFilters : pipeFilters;
    const key = filter.startsWith('native:') ? filter.slice(7) : filter;
    if (!Object.hasOwn(registry, key)) return input;
    result = registry[key](normalized);
  }
  return result !== normalized && Buffer.byteLength(result) < Buffer.byteLength(input) ? result : input;
}
