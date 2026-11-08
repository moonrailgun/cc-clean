import type { Analysis, Provider, Session, Usage } from './types.ts';
import type { Config } from './config.ts';
import type { Plan, Receipt } from './clean.ts';
import { report, plan, execute } from './app.ts';
import { readStats } from './stats.ts';
import type { CleanupLog } from './history.ts';
import { directoryEntries, scanRoot } from './scan.ts';
import { select, checkbox, withProgress, safe, size, paint, columns, screen, storageRow, table, tree, pager, type Choice, type TreeNode } from './terminal.ts';
export { safe, size } from './terminal.ts';

const providerName = (provider: Provider) => provider === 'claude' ? 'Claude Code' : 'Codex';
function line(value = '') { for (const part of value.split('\n')) console.log(safe(part)); }
function title(value: string, subtitle?: string) {
  console.log('\n' + paint('purple', `  ${value}`));
  if (subtitle) console.log(paint('gray', `  ${subtitle}`));
  line();
}
function section(value: string) { console.log('\n' + paint('bold', `  ➤ ${value}`)); }
function note(value: string) { console.log(paint('gray', `  ◎ ${value}`)); }
function rows(items: { label: string; value: string }[]) {
  for (const row of items) console.log(`  ${paint('cyan', row.value.padStart(14))}  ${safe(row.label)}`);
}
function storageRows(items: { name: string; bytes: number }[], total: number) {
  if (!items.length) { note('No items found.'); return; }
  const max = items.reduce((n, item) => Math.max(n, item.bytes), 0);
  for (const item of items) {
    if (process.stdout.isTTY) console.log(storageRow(item, { width: columns(), total, max }));
    else line(`  ${size(item.bytes).padStart(14)}  ${item.name}`);
  }
}
function usageTable(label: string, entries: [string, Usage][], width = columns()): string[] {
  if (!entries.length) return [];
  const metrics = [
    ['userMessages', 'Messages'], ['toolCalls', 'Tools'], ['inputTokens', 'Input tokens'],
    ['outputTokens', 'Output tokens'], ['cachedTokens', 'Cached tokens'], ['reasoningTokens', 'Reasoning tokens'],
  ] as const;
  const visible = metrics.filter(([key]) => key !== 'reasoningTokens' || entries.some(([, value]) => value[key] !== null));
  return table([label, ...visible.map(([, name]) => name)], entries.map(([name, value]) => [
    name, ...visible.map(([key]) => value[key]?.toLocaleString('en-US') ?? '—'),
  ]), width);
}
export function printReport(data: Analysis, view = 'directories') {
  title(`Analyze ${providerName(data.provider)}`, data.root);
  line(`  Total ${size(data.totalBytes)} · ${data.fileCount} files · ${data.scanComplete ? 'complete' : 'partial'} · ${data.scannedAt}`);
  if (view === 'directories') {
    section('Directories');
    storageRows(data.directories.map(item => ({ name: `${item.name} (${item.files} files)`, bytes: item.bytes })), data.totalBytes);
    section('Categories'); storageRows(data.categories, data.totalBytes);
  } else if (view === 'projects') {
    section('Projects');
    storageRows(data.projects.map(item => ({ name: `${item.path} · ${item.sessions} sessions · ${item.updatedAt}`, bytes: item.bytes })), data.totalBytes);
    note(`Shared ${size(data.sharedBytes)} · Unattributed ${size(data.unattributedBytes)}`);
  } else if (view === 'sessions') {
    section('Sessions');
    storageRows(data.sessions.map(item => ({ name: `${item.id} · ${item.project ?? 'Unknown project'} · ${item.archived ? 'archived' : 'regular'}${item.parentId ? ` · child session (${item.parentId})` : ''} · ${item.updatedAt} · ${item.complete ? 'complete' : 'partial'}`, bytes: item.bytes })), data.totalBytes);
  } else if (view === 'usage') {
    const printTable = (label: string, entries: [string, Usage][]) => { for (const row of usageTable(label, entries)) console.log(row); };
    section('Usage'); printTable('Scope', [['Total', data.usage]]);
    if (data.projects.length) { section('By project'); printTable('Project', data.projects.map(p => [p.path, p.usage])); }
    if (Object.keys(data.usage.byDate).length) { section('By date'); printTable('Date', Object.entries(data.usage.byDate).sort()); }
    if (Object.keys(data.usage.byModel).length) { section('By model'); printTable('Model', Object.entries(data.usage.byModel)); }
    note('— unavailable · Token columns may overlap.');
    const partial = !data.scanComplete || [data.usage, ...data.projects.map(p => p.usage), ...Object.values(data.usage.byDate), ...Object.values(data.usage.byModel)].some(value => !value.verified);
    if (partial || data.warnings.length) note(`${partial ? 'Some data is partial. ' : ''}See Details or --json for scan notes.`);
    return;
  } else {
    const o = data.opportunities;
    section('Images');
    rows([
      { label: `Standalone PNGs (${o.pngCount})`, value: size(o.pngBytes) },
      { label: 'Embedded images', value: size(o.embeddedImageBytes) },
      { label: 'Duplicate image candidates', value: size(o.duplicateImageBytes) },
    ]);
    section('Field sizes'); note('Serialized values; keys and separators excluded. Slim history is available under Clean.');
    storageRows(o.fields.map(item => ({ name: `${item.path} (${item.count})`, bytes: item.bytes })), data.totalBytes);
    section('Record types'); storageRows(o.recordTypes.map(item => ({ name: `${item.type} (${item.count})`, bytes: item.bytes })), data.totalBytes);
  }
  for (const warning of data.warnings.slice(0, 12)) note(warning);
  if (data.warnings.length > 12) note(`Plus ${data.warnings.length - 12} more notes; use --json to see all`);
}
export function printPlan(p: Plan) {
  title(`${providerName(p.provider)} · ${p.actions.length} items`, p.root);
  note('Bulk deletion and history slimming require files last modified more than 72 hours ago.');
  if (p.explicitTarget) note(`Explicit single target: ${p.explicitTarget}. Age limit waived only for this file or a session without descendants.`);
  if (!p.actions.length) note('No eligible cleanup items.');
  for (const a of p.actions) {
    section(`${a.kind} · ${a.targetId} · source size ${size(a.beforeBytes)}`);
    for (const f of a.files) line(`    ${f.path}`);
    if (a.sessionIds) line(`    Related sessions: ${a.sessionIds.join(', ')}`);
    if (a.kind === 'slim-history') {
      line(`    Remove inline images: ${a.slimOptions?.removeImages ? 'yes' : 'no'} · Compact shell output: ${a.slimOptions?.compactTools ? 'yes' : 'no'}`);
      line(`    Images removed: ${a.slimCounts?.images ?? 0} · Tool outputs compacted: ${a.slimCounts?.toolOutputs ?? 0}`);
      line('    Irreversible: original images and omitted output will be unavailable. No undo.');
    }
    line(`    Estimated savings: ${size(a.estimatedSavingsBytes ?? null)}`);
  }
  rows([{ label: 'Estimated savings', value: estimatedSavings(p.actions) }]);
  for (const warning of p.warnings) note(warning);
  note('Estimates use logical bytes; safety checks may skip items. Actual directory changes may differ.');
}
function estimatedSavings(actions: Plan['actions']): string {
  const known = actions.reduce((sum, action) => sum + (action.estimatedSavingsBytes ?? 0), 0);
  const unknown = actions.filter(action => action.estimatedSavingsBytes == null).length;
  return unknown ? `${known ? `${size(known)} + ` : ''}unknown (${unknown} item${unknown === 1 ? '' : 's'})` : size(known);
}
export function printReceipts(receipts: Receipt[]) {
  for (const r of receipts) {
    if (r.status === 'dry-run') { printPlan(r); note('Preview only; no operations executed or savings credited'); continue; }
    title(`${providerName(r.provider)} · ${r.status}`);
    console.log(paint(r.attributionComplete ? 'green' : 'yellow', `  Confirmed reduction: ${r.attributionComplete ? size(r.confirmedReductionBytes) : 'needs review'}`));
    rows([{ label: 'Directory before', value: size(r.rootBeforeBytes) }, { label: 'Directory after', value: size(r.rootAfterBytes) }, { label: 'Directory change', value: size(r.rootBeforeBytes === null || r.rootAfterBytes === null ? null : r.rootBeforeBytes - r.rootAfterBytes) }]);
    for (const [state, symbol] of [['completed', '✓'], ['skipped', '◎'], ['failed', '!']] as const) line(`  ${symbol} ${state}: ${r.actions.filter(a => a.status === state).length} items`);
    for (const a of r.actions.filter(a => a.reason)) note(`${a.targetId}: ${a.reason}`);
    for (const warning of r.warnings) note(warning);
  }
}
export function printStats(data: Awaited<ReturnType<typeof readStats>>, provider: Provider | 'all' = 'all') {
  title('Storage Savings', 'Claude Code and Codex · measured after every cleanup');
  for (const key of ['claude', 'codex'] as const) {
    if (provider !== 'all' && provider !== key) continue;
    const item = data.providers[key];
    section(`${providerName(key)} · ${item.operations.length} operations · ${item.pending} need review`);
    rows([
      { label: 'Space saved', value: size(item.savedBytes) },
      { label: 'Records cleaned', value: String(item.cleanedRecords) },
    ]);
    if (!item.operations.length && !item.pendingOperations.length) note('No cleanup history yet.');
    for (const r of item.operations) printCleanupLog(r);
    for (const r of item.pendingOperations) { printReceipts([r]); printPlan(r); }
  }
  line();
  if (provider === 'all') console.log(paint(data.savedBytes >= 0 ? 'green' : 'yellow', `  Total space saved  ${size(data.savedBytes)}`));
  note('Recorded before/after logical bytes. Unverified operations are excluded from totals.');
}
export function printCleanupLog(r: CleanupLog) {
  title(`${providerName(r.provider)} · ${r.status}`, r.root);
  line(`  Started:  ${r.startedAt}`);
  line(`  Finished: ${r.finishedAt}`);
  rows([
    {label: 'Directory before', value: size(r.beforeBytes)},
    {label: 'Directory after', value: size(r.afterBytes)},
    {label: 'Space saved', value: size(r.savedBytes)},
    {label: 'Records cleaned', value: String(r.cleanedRecords)},
  ]);
  for (const entry of r.cleanupTypes) line(`  ${entry.type}: ${entry.cleanedRecords}`);
  if (r.needsReview) note('Needs review; excluded from totals.');
  note(`${r.source} · ${r.operationId}`);
}
function statsSummary(data: Awaited<ReturnType<typeof readStats>>, width: number): string[] {
  const { claude, codex } = data.providers;
  const metric = (label: string, a: string, b: string) => `  ${label.padEnd(22)}${a.padStart(14)}${b.padStart(14)}`;
  const values = width >= 55 ? [
    metric('', 'Claude Code', 'Codex'),
    metric('Space saved', size(claude.savedBytes), size(codex.savedBytes)),
    metric('Records cleaned', String(claude.cleanedRecords), String(codex.cleanedRecords)),
    metric('Operations / review', `${claude.operations.length} / ${claude.pending}`, `${codex.operations.length} / ${codex.pending}`),
  ] : [claude, codex].flatMap((item, i) => [
    `  ${i ? 'Codex' : 'Claude Code'} · ${item.operations.length} ops · ${item.pending} review`,
    `  Saved ${size(item.savedBytes)} · ${item.cleanedRecords} records cleaned`,
  ]);
  return ['', ...values, '', `  Total space saved  ${size(data.savedBytes)}`];
}
const context = (signal?: AbortSignal) => ({ signal });
export function detailNodes(data: Analysis): TreeNode[] {
  const o = data.opportunities;
  const groups = new Map<string, typeof o.fields>();
  for (const field of o.fields) {
    const name = field.path.split('.')[0];
    const entries = groups.get(name) ?? [];
    entries.push(field); groups.set(name, entries);
  }
  const fieldNode = (field: typeof o.fields[number], name: string): TreeNode => ({
    name, bytes: field.bytes, detail: `${field.path} · ${field.count.toLocaleString('en-US')} occurrences · ${size(field.bytes)}`,
  });
  const fields: TreeNode[] = [...groups].map(([name, entries]) => entries.length === 1 && entries[0].path === name
    ? fieldNode(entries[0], name) : {
      name, bytes: entries.reduce((sum, field) => sum + field.bytes, 0),
      detail: `${name} · ${entries.length} fields`,
      children: entries.map(field => fieldNode(field, field.path === name ? '(other values)' : field.path.slice(name.length + 1)))
        .sort((a, b) => b.bytes! - a.bytes!),
    });
  fields.sort((a, b) => b.bytes! - a.bytes!);
  return [
    { name: 'Images', children: [
      { name: 'Standalone PNGs', bytes: o.pngBytes, detail: `${o.pngCount} files · ${size(o.pngBytes)}` },
      { name: 'Chat images', bytes: o.embeddedImageBytes },
      { name: 'Duplicate image candidates', bytes: o.duplicateImageBytes, detail: 'Included in chat images; potential savings only.' },
    ] },
    { name: 'Field sizes', bytes: fields.reduce((sum, field) => sum + field.bytes!, 0), children: fields,
      detail: `${o.fields.length} fields · Serialized values only; keys and separators excluded.` },
    { name: 'Record types', bytes: o.recordTypes.reduce((sum, item) => sum + item.bytes, 0), children: o.recordTypes.map(item => ({
      name: item.type, bytes: item.bytes, detail: `${item.type} · ${item.count.toLocaleString('en-US')} records · ${size(item.bytes)}`,
    })).sort((a, b) => b.bytes - a.bytes) },
    { name: `Scan notes (${data.warnings.length})`, detail: `${data.scanComplete ? 'Complete' : 'Partial'} scan · Parsed ${data.usage.parsedFiles}/${data.usage.totalFiles} record files · Usage ${data.usage.verified ? 'verified' : 'partial or unknown'}`,
      children: data.warnings.map(warning => ({ name: warning.includes(': ') ? warning.slice(warning.indexOf(': ') + 2) : warning, detail: warning })) },
  ];
}
export async function detailsMenu(data: Analysis, signal?: AbortSignal) {
  await tree({ message: 'Details', subtitle: `${providerName(data.provider)} · ${size(data.totalBytes)}`, nodes: detailNodes(data) }, context(signal));
}
export async function usageMenu(data: Analysis, signal?: AbortSignal) {
  const page = (name: string, label: string, entries: [string, Usage][]) => ({ name, content: (width: number) => entries.length
    ? usageTable(label, entries, width) : [`  No ${name.toLowerCase()} data available.`] });
  await pager({ message: 'Usage breakdown', subtitle: `${providerName(data.provider)} · ${size(data.totalBytes)}`, pages: [
    { name: 'Overview', content: width => [
      ...usageTable('Scope', [['Total', data.usage]], width), '',
      '  — unavailable · Token columns may overlap.',
      ...(!data.scanComplete || !data.usage.verified || data.warnings.length ? ['  Some data is partial. See Details.'] : []),
    ] },
    page('Projects', 'Project', data.projects.map(p => [p.path, p.usage])),
    page('Dates', 'Date', Object.entries(data.usage.byDate).sort()),
    page('Models', 'Model', Object.entries(data.usage.byModel)),
  ] }, context(signal));
}
export async function scanReport(config: Config, provider: Provider, deep: boolean, signal?: AbortSignal) {
  return withProgress({ message: deep ? 'Deep Scan' : 'Analyze Storage', subtitle: `${providerName(provider)} · ${config.roots[provider]}` },
    (localSignal, onProgress) => report(config, provider, deep, localSignal, onProgress), context(signal));
}
export async function scanPlan(config: Config, provider: Provider, options: Parameters<typeof plan>[2] = {}, signal?: AbortSignal) {
  return withProgress({ message: 'Deep Scan Before Cleanup', subtitle: `${providerName(provider)} · ${config.roots[provider]}` },
    (localSignal, onProgress) => plan(config, provider, options, localSignal, onProgress), context(signal));
}
async function insightsMenu(load: () => Promise<Analysis | null>, subtitle: string, signal?: AbortSignal) {
  let data = await load();
  if (!data) return;
  while (!signal?.aborted) {
    const snapshot = data;
    const action = await select({ message: 'Insights', subtitle, summary: width => {
      const value = (n: number | null) => n?.toLocaleString() ?? 'unknown';
      const u = snapshot.usage, o = snapshot.opportunities;
      return [
        '', `  ${size(snapshot.totalBytes)} · ${snapshot.sessions.length} sessions`,
        `  Messages       ${value(u.userMessages)}`,
        `  Tool calls     ${value(u.toolCalls)}`,
        ...(width >= 65 ? [`  Tokens         ${value(u.inputTokens)} input · ${value(u.outputTokens)} output`] : [
          `  Input tokens   ${value(u.inputTokens)}`, `  Output tokens  ${value(u.outputTokens)}`,
        ]),
        `  PNG images     ${size(o.pngBytes)} · ${o.pngCount} files`,
        `  Chat images    ${size(o.embeddedImageBytes)}`,
        ...(!snapshot.scanComplete || !u.verified ? ['  Some data is unavailable. See Details.'] : []),
      ];
    }, choices: [
      { name: 'Usage breakdown', description: 'By project, date and model', value: 'usage' },
      { name: 'Details', description: 'Images, fields and scan notes', value: 'details' },
      { name: 'Refresh', description: 'Check for changes', value: 'refresh' },
    ] }, context(signal));
    if (!action) return;
    if (action === 'refresh') { data = await load() ?? data; continue; }
    if (action === 'details') await detailsMenu(snapshot, signal);
    else await usageMenu(snapshot, signal);
  }
}
async function pause(signal?: AbortSignal) {
  await select({ message: 'Continue', clear: false, choices: [{ name: 'Back', value: 'back' }] }, context(signal));
}
export async function confirmPlans(plans: Plan[], signal?: AbortSignal) {
  plans.forEach(printPlan);
  const actions = plans.flatMap(p => p.actions);
  if (!actions.length) return false;
  rows([{ label: 'Total estimated savings', value: estimatedSavings(actions) }]);
  return await select({
    message: 'Press Enter to clean the items listed above',
    subtitle: 'This tool cannot undo these changes. Q / Esc cancels.', clear: false, requireEnter: true, cancelLabel: 'Cancel',
    choices: [{ name: 'Confirm cleanup', description: 'Apply the full scope listed above', value: true }],
  }, context(signal)) === true;
}
const providers = [{ name: 'All providers', description: 'Claude Code and Codex', value: 'all' }, { name: 'Claude Code', value: 'claude' }, { name: 'Codex', value: 'codex' }] as const;
async function chooseProvider(signal?: AbortSignal): Promise<Provider | 'all' | null> {
  return select({ message: 'Select Provider', choices: [...providers] }, context(signal));
}
function providerList(value: Provider | 'all'): Provider[] { return value === 'all' ? ['claude', 'codex'] : [value]; }
async function searchable<T>(message: string, items: Choice<T>[], signal?: AbortSignal, subtitle?: string, total?: number, clear = true): Promise<T | null> {
  return select({ message, subtitle, choices: items, searchable: true, total, clear }, context(signal));
}
async function runSelection(config: Config, plans: Plan[], signal?: AbortSignal) {
  screen();
  if (!plans.some(p => p.actions.length)) { plans.forEach(printPlan); await pause(signal); return; }
  if (await confirmPlans(plans, signal)) { printReceipts((await execute(config, plans, false, signal, line)).receipts); await pause(signal); }
}
function sessionChoice(s: Session): Choice<Session> {
  return { name: `${s.id} · ${s.project ?? 'Unknown project'}`, bytes: s.bytes, value: s,
    detail: `${s.updatedAt}${s.archived ? ' · archived' : ''}${s.complete ? '' : ' · partial'}` };
}
async function sessionsMenu(config: Config, data: Analysis, sessions: Session[], signal?: AbortSignal) {
  const sorted = [...sessions].sort((a, b) => b.bytes - a.bytes);
  let order = 'size';
  while (!signal?.aborted) {
    const action = await select({ message: `${providerName(data.provider)} / Sessions`, subtitle: `${sorted.length} sessions · sorted by ${order}`, choices: [
      { name: 'Browse', description: 'Explore sessions and their usage', value: 'browse' },
      { name: 'Select to delete', description: 'Choose sessions and review the full scope', value: 'delete' },
      { name: order === 'size' ? 'Sort by activity' : 'Sort by size', value: order === 'size' ? 'date' : 'size' },
    ] }, context(signal));
    if (!action) return;
    if (action === 'size') { sorted.sort((a, b) => b.bytes - a.bytes); order = 'size'; continue; }
    if (action === 'date') { sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); order = 'recent activity'; continue; }
    if (action === 'delete') {
      const ids = await checkbox({ message: 'Select Sessions', subtitle: 'Enter reviews the full deletion scope. Empty selection returns.', choices: sorted.filter(s => /^[0-9a-f-]{36}$/i.test(s.id)).map(s => ({ ...sessionChoice(s), value: s.id })) }, context(signal));
      if (ids.length) {
        const p = await scanPlan(config, data.provider, { sessions: ids, manual: true }, signal);
        if (p) await runSelection(config, [p], signal);
        return;
      }
    } else {
      const s = await searchable('Analyze Sessions', sorted.map(sessionChoice), signal, `${providerName(data.provider)} · sorted by ${order}`);
      if (!s) continue;
      while (!signal?.aborted) {
        const next = await select({ message: `Session ${s.id}`, subtitle: s.project ?? 'Unknown project', summary: () => [
          '', `  ${size(s.bytes)} · ${s.updatedAt}${s.archived ? ' · archived' : ''}`,
          ...(s.complete ? [] : ['  Some data is unavailable. See Details.']),
        ], choices: [
          { name: 'Insights', description: 'Usage and images', value: 'insights' },
          { name: 'Details', description: 'Files and session notes', value: 'details' },
          { name: 'Preview deletion', description: 'Review this session and its children', value: 'delete' },
        ] }, context(signal));
        if (!next) break;
        if (next === 'delete') {
          const p = await scanPlan(config, data.provider, { sessions: [s.id], manual: true }, signal);
          if (p) await runSelection(config, [p], signal);
          return;
        }
        if (next === 'details') {
          screen(); title(`Session ${s.id}`, s.project ?? 'Unknown project');
          if (s.parentId) note(`Parent session: ${s.parentId}`);
          rows(s.files.map(f => ({ label: f.path, value: size(f.size) })));
          for (const w of s.warnings) note(w);
          await pause(signal);
        }
        if (next === 'insights') {
          const { analyze } = await import('./analyze.ts');
          await insightsMenu(() => withProgress({ message: 'Deep Scan', subtitle: `Session ${s.id}` }, async (localSignal, onProgress) => {
            const inv = await scanRoot(data.root, data.provider, localSignal, onProgress), paths = new Set(s.files.map(f => f.path));
            inv.files = inv.files.filter(f => paths.has(f.path)); inv.totalBytes = inv.files.reduce((n, f) => n + f.size, 0);
            return analyze(inv, { deep: true, stateDir: config.stateDir, signal: localSignal, onProgress });
          }, context(signal)), `Session ${s.id}`, signal);
        }
      }
    }
  }
}
async function filesMenu(config: Config, provider: Provider, signal?: AbortSignal) {
  const p = await scanPlan(config, provider, { manual: true }, signal);
  if (!p) return;
  p.actions.sort((a, b) => b.beforeBytes - a.beforeBytes);
  if (!p.actions.length) { screen(); printPlan(p); await pause(signal); return; }
  const selected = await checkbox({ message: 'Select Temporary Files / PNGs', subtitle: 'Select items to review before applying changes.', choices: p.actions.map(a => ({ name: a.targetId, bytes: a.beforeBytes, detail: a.kind, value: a.files[0].path })) }, context(signal));
  if (!selected.length) return;
  const mode = await select({ message: 'Choose Operation', choices: [
    { name: 'Clean / compress', description: 'Delete expired temporary files; compress PNGs losslessly', value: 'compress' },
    { name: 'Delete files', description: 'Permanently delete all selected files, including PNGs', value: 'delete' }, { name: 'Back', value: 'back' },
  ] }, context(signal));
  if (mode && mode !== 'back') {
    const selectedPlan = await scanPlan(config, provider, { manual: true, files: selected, deleteImages: mode === 'delete' }, signal);
    if (selectedPlan) await runSelection(config, [selectedPlan], signal);
  }
}
async function directoriesMenu(config: Config, provider: Provider, signal?: AbortSignal) {
  screen();
  const inventory = await withProgress({ message: 'Analyze Disk', subtitle: config.roots[provider] },
    (localSignal, onProgress) => scanRoot(config.roots[provider], provider, localSignal, onProgress), context(signal));
  if (!inventory) return;
  if (inventory.errors.length) { for (const error of inventory.errors) note(error); await pause(signal); }
  let prefix = '';
  while (!signal?.aborted) {
    const entries = directoryEntries(inventory, prefix), total = entries.reduce((sum, item) => sum + item.bytes, 0);
    const selected = await searchable(`Analyze Disk · ${providerName(provider)} · ${size(total)}${inventory.complete ? '' : ' · partial'}`, entries.map(item => ({
      name: `${item.name}${item.directory ? '/' : ''}`, bytes: item.bytes, value: item,
      detail: `${item.name} · ${item.files} files · ${size(item.bytes)}`,
    })), signal, `${inventory.root}/${prefix}`, total);
    if (!selected) {
      if (!prefix) return;
      prefix = prefix.replace(/[^/]+\/$/, ''); continue;
    }
    if (selected.directory) prefix = selected.path + '/';
    else {
      screen(); title(selected.name, `${inventory.root}/${selected.path}`);
      rows([{ label: 'File size', value: size(selected.bytes) }]);
      note('Use Projects for sessions or Clean for temporary files and PNGs.'); await pause(signal);
    }
  }
}
export async function analysisMenu(config: Config, provider: Provider, signal?: AbortSignal) {
  while (!signal?.aborted) {
    const view = await select({ message: 'Analyze Storage', subtitle: `${providerName(provider)} · ${config.roots[provider]}`, choices: [
      { name: 'Storage', description: 'Explore files and folders', value: 'directories' },
      { name: 'Projects', description: 'Browse projects and sessions', value: 'projects' },
      { name: 'Insights', description: 'Usage and images', value: 'insights' },
    ] }, context(signal));
    if (!view) return;
    if (view === 'directories') { await directoriesMenu(config, provider, signal); continue; }
    if (view === 'insights') { await insightsMenu(() => scanReport(config, provider, true, signal), providerName(provider), signal); continue; }
    screen();
    const data = await scanReport(config, provider, false, signal);
    if (!data) continue;
    const project = await searchable('Projects', [
      { name: 'All sessions', description: `${data.sessions.length} sessions`, value: 'all' },
      ...data.projects.map(p => ({ name: p.path, bytes: p.bytes, detail: `${p.sessions} sessions · ${p.updatedAt}`, value: p.path })),
    ], signal, `${providerName(provider)} · ${size(data.totalBytes)}${data.scanComplete ? '' : ' · partial'}`, data.totalBytes);
    if (project) await sessionsMenu(config, data, project === 'all' ? data.sessions : data.sessions.filter(s => s.project === project), signal);
  }
}
export async function menu(config: Config, signal?: AbortSignal) {
  while (!signal?.aborted) {
    try {
      const action = await select({ message: 'cc-clean', subtitle: 'Keep your Claude Code & Codex storage tidy.', brand: true, cancelLabel: 'Quit', choices: [
        { name: 'Clean', description: 'Free up disk space', value: 'clean' },
        { name: 'Analyze', description: 'Explore storage and usage', value: 'analyze' },
        { name: 'Statistics', description: 'Track savings and operation history', value: 'stats' },
        { name: 'Quit', description: 'Back to your terminal', value: 'exit' },
      ] }, context(signal));
      if (!action || action === 'exit') return;
      if (action === 'stats') {
        const stats = await readStats(config.stateDir);
        const entries: (CleanupLog | Receipt)[] = Object.values(stats.providers).flatMap(p => [
          ...p.operations, ...p.pendingOperations.filter(r => !p.operations.some(log => log.operationId === r.operationId)),
        ]);
        const r = await select({ message: 'Storage Savings', subtitle: 'Recorded cleanup history · before/after logical bytes', summary: width => statsSummary(stats, width), searchable: true, emptyMessage: 'No cleanup history yet.',
          choices: entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(r => ({
          name: `${r.startedAt} · ${providerName(r.provider)} · ${r.status}`,
          detail: `${r.operationId} · ${'savedBytes' in r && !r.needsReview ? `${size(r.savedBytes)} · ${r.cleanedRecords} records` : 'needs review'}`, value: r,
        })) }, context(signal));
        if (r) {
          screen();
          if ('savedBytes' in r) printCleanupLog(r);
          const pending = stats.providers[r.provider].pendingOperations.find(item => item.operationId === r.operationId);
          if (pending) { printReceipts([pending]); printPlan(pending); }
          await pause(signal);
        }
      } else {
        const mode = action === 'clean' ? await select({ message: 'Clean', choices: [
          { name: 'Quick clean', description: 'Deep scan, review savings, then confirm cleanup', value: 'quick' },
          { name: 'Select files', description: 'Choose what to clean', value: 'files' },
          { name: 'Slim history', description: 'Remove inline images or compact shell output (irreversible)', value: 'slim' },
        ] }, context(signal)) : 'analyze';
        if (!mode) continue;
        const selected = await chooseProvider(signal);
        if (!selected) continue;
        if (mode === 'analyze') for (const provider of providerList(selected)) await analysisMenu(config, provider, signal);
        else if (mode === 'files') for (const provider of providerList(selected)) await filesMenu(config, provider, signal);
        else {
          const fields = mode === 'slim' ? await checkbox({ message: 'Slim history (irreversible; no undo)', subtitle: 'Only history files last modified more than 72 hours ago.', choices: [
            { name: 'Remove inline images', description: 'Replace Base64 image blocks with text', value: 'images' },
            { name: 'Compact shell output', description: 'Use RTK filters on recognized successful commands', value: 'tools' },
          ] }, context(signal)) : [];
          if (mode === 'slim' && !fields.length) continue;
          screen(); title(mode === 'slim' ? 'Slim History' : 'Quick Clean');
          let plans: Plan[] | null = [];
          for (const provider of providerList(selected)) {
            const p = await scanPlan(config, provider, { removeImages: fields.includes('images'), compactTools: fields.includes('tools') }, signal);
            if (!p) { plans = null; break; }
            plans.push(p);
          }
          if (plans) await runSelection(config, plans, signal);
        }
      }
    } catch (error) {
      if (signal?.aborted || (error as Error).name.includes('Prompt')) throw error;
      note(`Incomplete: ${(error as Error).message}`); await pause(signal);
    }
  }
}
