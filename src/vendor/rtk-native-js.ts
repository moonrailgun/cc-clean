// SPDX-License-Identifier: Apache-2.0
// Ported from RTK 0.49.0 src/cmds/js/{npm,pnpm,bun,deno,ng,next,prisma,lint,playwright}_cmd.rs.
// Pinned revision: 653efb6ed02bd287d686c50e830dd1009356904f. See third_party/rtk/NATIVE.md.
import { clean, compactPath, counts, json, lines, object, string, testSummary, truncate, uint, type Filter, type Obj } from './rtk-native-common.ts';

function npm(input: string): string {
  if (!/^(?:> .*@\S+ |npm (?:WARN|notice)|[⸩⸨])/m.test(input)) return input;
  return lines(input).filter(line => !(line.startsWith('>') && line.includes('@')) && !/^\s*npm (?:WARN|notice)/.test(line) && !/[⸩⸨]/.test(line) && !(line.includes('...') && line.length < 10) && line.trim()).join('\n') || 'ok';
}
function pnpmInstall(input: string): string {
  if (!/^(?:Progress: resolved |Packages: [+-]\d|(?:devD|d)ependencies:|Done in \d)/m.test(input)) return input;
  const out = lines(input).filter(line => !line.includes('Progress') && !line.includes('│') && !line.includes('%')).flatMap(line => /error|ERR|ERROR/.test(line) ? [line] : /packages in|dependencies/.test(line) || /^[+-]/.test(line) ? [line.trim()] : []);
  return out.join('\n') || 'ok';
}
function bunPackage(input: string): string {
  const text = clean(input);
  if (!/^bun (?:install|add|remove) v\d/m.test(text)) return input;
  return lines(text).filter(line => { const s = line.trim(); return s && s !== 'Resolving dependencies' && !s.startsWith('Resolved, downloaded') && !(/^bun (?:install|add|remove) v/.test(s) && s.split(/\s+/).length <= 4); }).join('\n') || 'ok';
}
function bunList(input: string): string {
  const data = json(input);
  let deps: string[];
  if (object(data) && Object.keys(data).length && Object.values(data).every(v => object(v) && string(v.version))) {
    deps = Object.entries(data).map(([name, v]) => `${name}@${(v as Obj).version}`);
  } else {
    const text = clean(input);
    if (!/^[\s│]*[├└]──\s+\S+@\S+/m.test(text)) return input;
    deps = [...new Set(lines(text).filter(line => /^[├└│]/.test(line.trimStart())).map(line => line.trimStart().replace(/^[├└│─ ]+/, '').trimEnd()).filter(Boolean))];
  }
  deps.sort();
  return `${deps.length} deps\n${deps.join('\n')}`;
}
function deno(input: string): string {
  const text = clean(input);
  if (!/^\s*Download https?:\/\//m.test(text)) return input;
  return lines(text).filter(line => line.trim() && !line.trimStart().startsWith('Download ')).join('\n') || 'ok';
}
function ngBuild(input: string): string {
  const chunks = input.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const cells = (s: string) => s.trimEnd().split('|').map(s => s.trim());
  const header = (s: string) => { const c = cells(s); return /^(?:Initial|Lazy) chunk files/.test(s) && /^(?:Initial|Lazy) chunk files$/.test(c[0]) && c[1] === 'Names' && c[2] === 'Raw size' && (c.length === 3 || c.length === 4 && c[3] === 'Estimated transfer size') ? c.length : 0; };
  const row = (s: string, n: number) => { const c = cells(s); return c.length === n && (/\.(?:m?js|css)$/.test(c[0]) || c[0] === '' && c[1] === 'Initial total') && !!c[1] && c.slice(2).every(s => /^(?:\d+(?:\.\d+)? (?:bytes|[kMGT]?B)|-)$/.test(s)); };
  let columns = 0, saw = false;
  const out = chunks.map((line, i) => {
    const text = clean(line), n = header(text);
    if (n && chunks[i + 1] !== undefined && row(clean(chunks[i + 1]), n)) { columns = n; saw = true; }
    else if (!(columns && row(text, columns))) { if (text.trim()) columns = 0; return line; }
    return cells(text).join(' | ') + (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '');
  }).join('');
  return saw ? out.replace(/^❯ Building\.\.\.(\r?\n)✔ Building\.\.\.\1/, '') : input;
}

function prisma(input: string, command: string): string {
  const ls = lines(input);
  if (!/(?:Prisma schema loaded|Generated Prisma Client|prisma migrate|Your database is now in sync)/.test(input)) return input;
  const count = (r: RegExp) => ls.filter(line => r.test(line)).length;
  if (command === 'generate') {
    if (!/Generated Prisma Client|Prisma Client generated|models? generated/.test(input)) return input;
    let models = 0, enums = 0, types = 0;
    for (const line of ls) {
      if (/[█▀▄┌└│]/.test(line)) continue;
      const n = line.split(/\s+/).find(s => /^\d+$/.test(s));
      if (!n) continue;
      if (line.includes('model') && line.includes('generated')) models = +n;
      if (line.includes('enum')) enums = +n;
      if (line.includes('type')) types = +n;
    }
    return `Prisma Client generated${models || enums || types ? `\n  • ${models} models, ${enums} enums, ${types} types` : ''}${ls.some(line => !/[█▀▄┌└│]/.test(line) && line.includes('node_modules') && line.includes('@prisma')) ? '\n  • Output: node_modules/@prisma/client' : ''}`;
  }
  if (command === 'migrate-status') {
    const found = ls.find(line => /^\d+ migrations? found in .+$/.test(line))?.match(/^\d+/)?.[0];
    if (found === undefined || !uint(+found) || ls.filter(line => line.trim()).at(-1) !== 'Database schema is up to date!') return input;
    return `Migrations: ${+found} applied, 0 pending`;
  }
  if (command === 'migrate-deploy') {
    const text = ls.join('\n').trimEnd();
    if (/(?:^|\n)No pending migrations to apply\.$/.test(text)) return '0 migration(s) deployed';
    // Progress can be captured only in part; count the complete final list instead.
    const applied = /(?:^|\n)The following migration\(s\) have been applied:\n\nmigrations\/\n((?:  └─ [^/\n]+\/\n    └─ migration\.sql\n)+)\nAll migrations have been successfully applied\.$/.exec(text);
    return applied ? `${applied[1].trimEnd().split('\n').length / 2} migration(s) deployed` : input;
  }
  if (command === 'db-push') {
    if (!/Your database is now in sync|already in sync|CREATE TABLE|ALTER TABLE/.test(input)) return input;
    const added = count(/CREATE TABLE/), modified = count(/ALTER|ADD COLUMN/), dropped = count(/DROP/);
    return `Schema pushed to database${added || modified || dropped ? `\n  + ${added} tables, ~ ${modified} columns, - ${dropped} dropped` : ''}`;
  }
  if (!/migration.*202\S*_|CREATE TABLE|ALTER TABLE/.test(input)) return input;
  const name = ls.filter(s => s.includes('migration') && s.includes('_')).at(-1)?.match(/202\S*/)?.[0];
  const added = count(/CREATE TABLE/), modified = count(/ALTER TABLE/), relations = count(/(?=.*(?:FOREIGN KEY|REFERENCES))(?=.*\bTABLE\s+\S)/), indexes = count(/CREATE (?:UNIQUE )?INDEX\s+\S/);
  return `${name ? `Migration: ${name}\n` : ''}Changes:\n${added ? `  + ${added} table(s)\n` : ''}${modified ? `  ~ ${modified} table(s) modified\n` : ''}${relations ? `  + ${relations} relation(s)\n` : ''}${indexes ? `  ~ ${indexes} index(es)\n` : ''}\n${/applied|✓/.test(input) ? 'Applied | Pending: 0\n' : ''}`.trim();
}

interface Dependency { name: string; version: string; dev: boolean }
function pnpmList(input: string, cap = true): string {
  const data = json(input);
  const deps: Dependency[] = [];
  const visit = (name: string, value: unknown, dev: boolean, depth: number): boolean => {
    if (depth > 100 || !object(value) || value.version !== undefined && !string(value.version)) return false;
    if (string(value.version)) deps.push({ name, version: value.version, dev });
    for (const key of ['dependencies', 'devDependencies']) {
      if (value[key] === undefined) continue;
      if (!object(value[key])) return false;
      for (const [child, v] of Object.entries(value[key]).sort(([a], [b]) => a.localeCompare(b))) if (!visit(child, v, dev || key === 'devDependencies', depth + 1)) return false;
    }
    return true;
  };
  if (Array.isArray(data)) {
    for (const v of data) if (!object(v) || !string(v.name) || !visit(v.name, v, false, 0)) return input;
  } else {
    if (!/^(?:devDependencies|dependencies):/m.test(input)) return input;
    let dev = false;
    for (const line of lines(input)) {
      const s = line.trim();
      if (s === 'devDependencies:') { dev = true; continue; }
      if (s === 'dependencies:') { dev = false; continue; }
      if (/[│├└]/.test(line) || line.includes('Legend:') || !s) continue;
      const word = s.split(/\s+/)[0], at = word.lastIndexOf('@');
      if (at > 0 && at < word.length - 1) deps.push({ name: word.slice(0, at), version: word.slice(at + 1), dev });
    }
    if (!deps.length) return input;
  }
  const prod = deps.filter(d => !d.dev), dev = deps.filter(d => d.dev);
  const out = [`${deps.length} packages (${prod.length} prod / ${dev.length} dev)`];
  for (const [label, group] of [['prod', prod], ['dev', dev]] as const) if (group.length) {
    out.push(`[${label}]`, ...group.slice(0, cap ? 20 : undefined).map(d => `  ${d.name} ${d.version}`));
    if (cap && group.length > 20) out.push(`  … +${group.length - 20} more`);
  }
  return out.join('\n');
}
function pnpmOutdated(input: string): string {
  const data = json(input);
  let deps: { name: string; current: string; latest: string }[] = [];
  if (object(data) && Object.values(data).every(v => object(v) && string(v.current) && string(v.latest))) {
    deps = Object.entries(data).sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => ({ name, current: (v as Obj).current as string, latest: (v as Obj).latest as string }));
  } else {
    if (!/^Package\s+Current\s+Wanted\s+Latest/m.test(input)) return input;
    for (const line of lines(input)) {
      if (/[│├└─]/.test(line) || /^(?:Legend:|Package)/.test(line) || !line.trim()) continue;
      const [name, current, , latest] = line.trim().split(/\s+/);
      if (!latest) return input;
      deps.push({ name, current, latest });
    }
  }
  const outdated = deps.filter(d => d.current !== d.latest).length;
  if (!outdated) return 'All packages up-to-date';
  return [`${outdated} outdated packages (of ${deps.length})`, ...deps.slice(0, 10).filter(d => d.current !== d.latest).map(d => `${d.name}: ${d.current} → ${d.latest}`), ...(outdated > 10 ? [`\n... +${outdated - 10} more`] : [])].join('\n');
}

function eslint(input: string): string {
  const data = json(input);
  if (!Array.isArray(data) || !data.every(v => object(v) && string(v.filePath) && uint(v.errorCount) && uint(v.warningCount) && Array.isArray(v.messages) && v.messages.every(m => object(m) && (m.ruleId == null || string(m.ruleId)) && [1, 2].includes(m.severity as number) && string(m.message) && uint(m.line) && uint(m.column)) && v.errorCount === v.messages.filter(m => m.severity === 2).length && v.warningCount === v.messages.filter(m => m.severity === 1).length)) return input;
  const entries = data as { filePath: string; errorCount: number; warningCount: number; messages: { ruleId: string | null }[] }[];
  const errors = entries.reduce((n, v) => n + v.errorCount, 0), warnings = entries.reduce((n, v) => n + v.warningCount, 0);
  if (!errors && !warnings) return 'ESLint: No issues found';
  const files = entries.filter(v => v.messages.length).sort((a, b) => b.messages.length - a.messages.length);
  const rules = (v: typeof entries) => counts(v.flatMap(v => v.messages.flatMap(m => m.ruleId ? [m.ruleId] : [])));
  const out = [`ESLint: ${errors} errors, ${warnings} warnings in ${files.length} files`];
  const allRules = rules(entries);
  if (allRules.length) out.push('Top rules:', ...allRules.slice(0, 10).map(([name, n]) => `  ${name} (${n}x)`), '');
  out.push('Top files:');
  for (const v of files.slice(0, 10)) out.push(`  ${compactPath(v.filePath)} (${v.messages.length} issues)`, ...rules([v]).slice(0, 3).map(([name, n]) => `    ${name} (${n})`));
  if (files.length > 10) out.push(`\n… +${files.length - 10} more files`);
  return out.join('\n');
}
function pylint(input: string): string {
  const data = json(input);
  if (!Array.isArray(data) || !data.every(v => object(v) && ['type', 'module', 'obj', 'path', 'symbol', 'message', 'message-id'].every(k => string(v[k])) && uint(v.line) && uint(v.column))) return input;
  const ds = data as Record<string, string>[];
  if (!ds.length) return 'Pylint: No issues found';
  const files = counts(ds.map(v => v.path)), types = Object.fromEntries(counts(ds.map(v => v.type)));
  const out = [`Pylint: ${ds.length} issues in ${files.length} files`];
  if (types.error || types.warning) out.push(`  ${types.error ?? 0} errors, ${types.warning ?? 0} warnings${types.convention || types.refactor ? `, ${types.convention ?? 0} conventions, ${types.refactor ?? 0} refactors` : ''}`);
  const symbols = (v: typeof ds) => counts(v.map(v => `${v.symbol} (${v['message-id']})`));
  out.push('Top rules:', ...symbols(ds).slice(0, 10).map(([s, n]) => `  ${s} (${n}x)`), '', 'Top files:');
  for (const [file, n] of files.slice(0, 10)) out.push(`  ${compactPath(file)} (${n} issues)`, ...symbols(ds.filter(v => v.path === file)).slice(0, 3).map(([s, n]) => `    ${s} (${n})`));
  if (files.length > 10) out.push(`\n… +${files.length - 10} more files`);
  return out.join('\n');
}
function nextBuild(input: string): string {
  const text = clean(input);
  if (!/(?:Next\.js|Route \((?:app|pages)\))/.test(text) || !/Compiled|Built in|already optimized|Cache|Ready/.test(text)) return input;
  let statics = 0, dynamics = 0, partials = 0, warnings = 0, errors = 0, time = '';
  let inRoutes = false, tableRoutes = 0;
  const bundles: { route: string; size: number }[] = [];
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (/^Route \((?:app|pages)\)/.test(line)) {
      if (inRoutes || !/^Route \((?:app|pages)\)\s+Size\s+First Load JS$/.test(line)) return input;
      inRoutes = true; tableRoutes = 0;
    } else if (inRoutes) {
      if (!line) {
        if (!tableRoutes) return input;
        inRoutes = false;
      } else {
        const route = /^(?:[┌├└]\s+)?([○●◐ƒλ])\s+(\/\S*)\s+(\d+(?:\.\d+)?)\s*(kB|B)\s+(\d+(?:\.\d+)?)\s*(kB|B)$/.exec(line);
        if (!route) return input;
        const size = +route[5] / (route[6] === 'B' ? 1000 : 1);
        if (!Number.isFinite(+route[3]) || !Number.isFinite(size)) return input;
        if (/[○●]/.test(route[1])) statics++;
        else if (route[1] === '◐') partials++;
        else dynamics++;
        tableRoutes++;
        bundles.push({ route: route[2], size });
        continue;
      }
    }
    if (/warning/i.test(line)) warnings++;
    if (/error/i.test(line) && !line.includes('0 error')) errors++;
    if (/Compiled|in/.test(line)) { const m = /(\d+(?:\.\d+)?)\s*(s|ms)/.exec(line); if (m) time = m[1] + m[2]; }
  }
  if (!bundles.length || inRoutes) return input;
  const out = ['Next.js Build', `${bundles.length} routes (${statics} static, ${dynamics} dynamic${partials ? `, ${partials} partial` : ''})`, ''];
  out.push('Bundles:', ...bundles.sort((a, b) => b.size - a.size).slice(0, 10).map(b => `  ${truncate(b.route, 30).padEnd(30)} ${Math.round(b.size).toString().padStart(6)} kB`));
  if (bundles.length > 10) out.push(`\n  ... +${bundles.length - 10} more routes`);
  out.push('');
  out.push(`${time ? `Time: ${time} | ` : ''}Errors: ${errors} | Warnings: ${warnings}`);
  return out.join('\n');
}

function playwright(input: string): string {
  const data = json(input);
  const failures: { name: string; error: string }[] = [];
  if (object(data) && object(data.stats) && ['expected', 'unexpected', 'skipped'].every(k => uint((data.stats as Obj)[k]))) {
    // Pinned RTK omits flaky and global failures from its summary; preserve those reports.
    if (!Array.isArray(data.suites) || data.stats.flaky !== undefined && data.stats.flaky !== 0 || data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length)) return input;
    const statuses = {expected: 0, unexpected: 0, skipped: 0};
    const visit = (suites: unknown, depth: number): boolean => {
      if (!Array.isArray(suites) || depth > 100) return false;
      for (const suite of suites) {
        if (!object(suite) || !string(suite.title) || suite.file !== undefined && !string(suite.file) || !Array.isArray(suite.specs ?? [])) return false;
        for (const spec of (suite.specs ?? []) as unknown[]) {
          if (!object(spec) || !string(spec.title) || typeof spec.ok !== 'boolean' || !Array.isArray(spec.tests ?? [])) return false;
          let error = 'Test failed';
          for (const run of (spec.tests ?? []) as unknown[]) {
            if (!object(run) || !string(run.status) || !Object.hasOwn(statuses,run.status) || !Array.isArray(run.results ?? [])) return false;
            statuses[run.status as keyof typeof statuses]++;
            for (const attempt of (run.results ?? []) as unknown[]) {
              if (!object(attempt) || !string(attempt.status) || !Array.isArray(attempt.errors ?? []) || !(attempt.errors as unknown[] | undefined ?? []).every(e => object(e) && (e.message === undefined || string(e.message)))) return false;
              if (run.status === 'unexpected' && /^(failed|timedOut)$/.test(attempt.status) && error === 'Test failed') error = ((attempt.errors as Obj[] | undefined)?.[0]?.message as string | undefined) ?? error;
            }
          }
          if (!spec.ok) failures.push({ name: spec.title, error });
        }
        if (!visit(suite.suites ?? [], depth + 1)) return false;
      }
      return true;
    };
    if (!visit(data.suites, 0) || Object.entries(statuses).some(([key,count])=>data.stats && (data.stats as Obj)[key]!==count) || data.stats.duration !== undefined && (typeof data.stats.duration !== 'number' || !Number.isFinite(data.stats.duration) || data.stats.duration < 0)) return input;
    return testSummary(data.stats.expected as number, data.stats.unexpected as number, data.stats.skipped as number, failures, (data.stats.duration as number | undefined) ?? 0);
  }
  const text = clean(input);
  if (/\b[1-9]\d*\s+flaky\b/.test(text)) return input;
  if (!/^\s*(?:Running \d+ tests? using|\d+ (?:passed|failed|skipped)\s*\()/m.test(text)) return input;
  let passed = 0, failed = 0, skipped = 0;
  for (const m of text.matchAll(/(\d+)\s+(passed|failed|flaky|skipped)/g)) { if (m[2] === 'passed') passed = +m[1]; if (m[2] === 'failed') failed = +m[1]; if (m[2] === 'skipped') skipped = +m[1]; }
  if (!passed && !failed && !skipped) return input;
  for (const m of text.matchAll(/[×✗]\s+.*?›\s+([^›]+\.spec\.[tj]sx?)/g)) failures.push({ name: m[0], error: '' });
  const d = /\((\d+(?:\.\d+)?)(ms|s|m)\)/.exec(text);
  return testSummary(passed, failed, skipped, failures, d ? +d[1] * (d[2] === 'm' ? 60000 : d[2] === 's' ? 1000 : 1) : undefined);
}

export const jsFilters: Record<string, Filter> = {
  npm, 'pnpm-install': pnpmInstall, 'pnpm-list': pnpmList, 'pnpm-list-all': input => pnpmList(input, false), 'pnpm-outdated': pnpmOutdated,
  'bun-package': bunPackage, 'bun-list': bunList, deno, 'ng-build': ngBuild, 'next-build': nextBuild,
  ...Object.fromEntries(['generate', 'migrate-dev', 'migrate-status', 'migrate-deploy', 'db-push'].map(name => [`prisma-${name}`, (input: string) => prisma(input, name)])),
  eslint, pylint, playwright,
};
