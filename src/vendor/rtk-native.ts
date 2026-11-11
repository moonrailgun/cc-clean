// SPDX-License-Identifier: Apache-2.0
// Historical-text adapters derived from RTK 0.49.0, commit 653efb6ed02bd287d686c50e830dd1009356904f.
import { jsFilters } from './rtk-native-js.ts';
import { rustFilters } from './rtk-native-rust.ts';
import { rubyFilters } from './rtk-native-ruby.ts';
import { systemFilters } from './rtk-native-system.ts';
import { extraFilters } from './rtk-native-extra.ts';
import { systemTextFilters } from './rtk-native-system-text.ts';
import { cloudFilters, matchCloudFilter } from './rtk-native-cloud.ts';
import { buildFilters, matchBuildFilter } from './rtk-native-build.ts';
import { mavenFilters, matchMavenFilter } from './rtk-native-maven.ts';
import { gitNativeFilters, matchGitNativeFilter } from './rtk-native-git.ts';
export * from './rtk-native-helpers.ts';
export * from './rtk-native-find.ts';
export * from './rtk-native-search.ts';
export { filterEnvironment, filterJson, summarizeDependencies } from './rtk-native-system-text.ts';
export const nativeFilters: Record<string, (input: string) => string> = { ...jsFilters, ...systemFilters, ...rustFilters, ...rubyFilters, ...extraFilters, ...systemTextFilters, ...cloudFilters, ...buildFilters, ...mavenFilters, ...gitNativeFilters };
export function matchNativeFilter(argv: string[]): string | undefined {
  const [exe, sub, next] = argv;
  if (argv.some(a => ['--help', '-h', '--watch', '--interactive', '--verbose'].includes(a))) return undefined;
  const delegated=matchCloudFilter(argv)??matchBuildFilter(argv)??matchMavenFilter(argv)??matchGitNativeFilter(argv);if(delegated)return delegated;
  const has = (...flags: string[]) => argv.some((arg, i) => flags.some(flag => arg === `${flag}=json` || arg === flag && argv[i + 1] === 'json'));
  if (exe === 'cargo') { if(sub==='nextest'&&next!=='run')return undefined;const name = `cargo-${sub}`; return name in rustFilters ? name : undefined; }
  if (exe === 'black' && !argv.some(arg=>['--diff','--color','--code','-c'].includes(arg))) return 'black';
  if ((exe === 'env' || exe === 'printenv') && argv.length === 1) return 'env';
  if (exe === 'ls') {
    const flags=argv.slice(1).filter(arg=>arg.startsWith('-'));
    if(flags.some(arg=>!/^-[laAh]+$/.test(arg))||!flags.some(arg=>arg.includes('l')))return undefined;
    return flags.some(arg=>/[aA]/.test(arg))?'ls-long-all':'ls-long';
  }
  if (exe === 'rspec' || exe === 'rubocop') return exe;
  if (exe === 'rake' && sub === 'test') return 'rake-test';
  if (exe === 'npm' && ['install', 'i', 'ci', 'run', 'exec', 'uninstall', 'update'].includes(sub)) return 'npm';
  if (exe === 'pnpm') {
    if (['install', 'i', 'add', 'remove', 'update'].includes(sub)) return 'pnpm-install';
    if (['list', 'ls'].includes(sub)) return argv.some(a => ['--prod', '--dev', '-P', '-D'].includes(a)) ? 'pnpm-list-all' : 'pnpm-list';
    if (sub === 'outdated') return 'pnpm-outdated';
  }
  if (exe === 'bun') { if (['install', 'add', 'remove'].includes(sub)) return 'bun-package'; if (sub === 'pm' && next === 'ls') return 'bun-list'; }
  if (exe === 'deno' && ['check', 'lint', 'test', 'task', 'run', 'cache', 'install'].includes(sub)) return 'deno';
  if (exe === 'ng' && sub === 'build' && !argv.includes('-w')) return 'ng-build';
  if (exe === 'next' && sub === 'build') return 'next-build';
  if (exe === 'prisma') { const name = `prisma-${sub}${['migrate', 'db'].includes(sub) ? `-${next}` : ''}`; return name in jsFilters ? name : undefined; }
  if (exe === 'eslint' && has('-f', '--format')) return 'eslint';
  if (exe === 'pylint' && has('-f', '--output-format')) return 'pylint';
  if (exe === 'playwright' && sub === 'test') return 'playwright';
  if (/^pip[23]?$/.test(exe ?? '') && sub === 'list' && has('--format')) return argv.includes('--outdated') || argv.includes('-o') ? 'pip-outdated' : 'pip-list';
  if (exe === 'tree' && !argv.some(a => ['-J', '-X', '-H', '--fromfile'].includes(a))) return 'tree';
  if (exe === 'php' && argv.some(a=>a==='-l'||a==='--syntax-check')) return 'php-lint';
  if (exe === 'go' && sub === 'vet') return 'go-vet';
  if (exe === 'golangci-lint' && sub === 'run') {
    if(argv.includes('--output.json.path=stdout')) return 'golangci-v2';
    if(has('--out-format')) return 'golangci-v1';
  }
  if(exe === 'sbt') {const task=sub?.split(/\s/)[0].split(/[/:]/).at(-1);if(['test','testOnly','testQuick'].includes(task??''))return 'sbt-test';if(task==='compile'||task==='run')return `sbt-${task}`;}
  if(exe === 'php' && sub?.endsWith('run-tests.php')) return 'phpt';
  if(exe === 'php' && sub?.endsWith('artisan') && next!=='test') return 'artisan';
  if(exe === 'psql' && !argv.some(a=>['-A','--no-align','--csv','-H','--html'].includes(a))) return 'psql';
  if (exe === 'wc') {
    const flags = argv.slice(1).filter(a => /^-[lwcm]+$/.test(a)).join('').replace(/-/g, '');
    if (argv.slice(1).some(a => a.startsWith('--') || a.startsWith('-') && !/^-[lwcm]+$/.test(a))) return undefined;
    return `wc-${new Set(flags).size === 0 ? 'full' : new Set(flags).size === 1 ? 'single' : 'mixed'}`;
  }
  if (exe === 'ast-grep' && sub === 'run' && !argv.some(a => /^(?:--json|--heading|--color|--interactive)/.test(a))) return 'ast-grep';
  return undefined;
}
