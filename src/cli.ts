#!/usr/bin/env node
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { loadConfig } from './config.ts';
import { commandSchema, help, parseCommand, UsageError, version } from './commands.ts';
import type { Provider } from './types.ts';

const args = process.argv.slice(2);
const optionArgs = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
const json = optionArgs.includes('--json');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

async function main() {
  const { values: v, command, deleting, provider, view, interactive } = parseCommand(args, !!process.stdin.isTTY && !!process.stdout.isTTY);
  if (v.help) { console.log(v.json ? JSON.stringify(commandSchema) : help); return; }
  if (v.version) { console.log(v.json ? JSON.stringify({ schemaVersion: 1, status: 'completed', version }) : version); return; }
  if (!command && !interactive) { console.log(v.json ? JSON.stringify(commandSchema) : help); return; }
  const config = await loadConfig(), signal = controller.signal;
  signal.throwIfAborted();
  const ui = await import('./ui.ts');
  const { report, cleanupPlans, execute } = await import('./app.ts');
  const selected: Provider[] = provider === 'all' ? ['claude', 'codex'] : [provider as Provider];
  if (!command) { await ui.menu(config, signal); return; }
  if (command === 'stats') {
    const { readStats } = await import('./stats.ts');
    const data = await readStats(config.stateDir);
    signal.throwIfAborted();
    if (v.json) {
      const item = provider === 'all' ? null : data.providers[provider as Provider];
      const filtered = item ? { schemaVersion: data.schemaVersion, providers: { [provider]: item }, savedBytes: item.savedBytes, cleanedRecords: item.cleanedRecords } : data;
      console.log(JSON.stringify({ ...filtered, status: 'completed' }));
    } else ui.printStats(data, provider as Provider | 'all');
    return;
  }
  if (command === 'analyze' && !deleting) {
    if (interactive && !v.view && !v.project) { for (const p of selected) await ui.analysisMenu(config, p, signal); return; }
    const reports = [];
    for (const p of selected) {
      if (signal.aborted) break;
      const deep = view === 'usage' || view === 'opportunities';
      const data = interactive ? await ui.scanReport(config, p, deep, signal) : await report(config, p, deep, signal);
      if (!data) { process.exitCode = 130; return; }
      if (v.project) {
        const project = await realpath(v.project).catch(() => resolve(v.project!));
        data.sessions = data.sessions.filter(s => s.project === project);
      }
      reports.push(data);
    }
    const status = signal.aborted ? 'interrupted' : reports.every(r => r.scanComplete) ? 'completed' : 'partial';
    if (v.json) console.log(JSON.stringify({ schemaVersion: 1, status, reports }));
    else for (const data of reports) {
      if (interactive && view === 'opportunities') await ui.detailsMenu(data, signal);
      else if (interactive && view === 'usage') await ui.usageMenu(data, signal);
      else ui.printReport(data, view);
    }
    process.exitCode = status === 'interrupted' ? 130 : status === 'partial' ? 1 : 0;
    return;
  }
  const files = v.file?.map(path => resolve(path));
  const plans = [];
  for (const p of selected) {
    signal.throwIfAborted();
    const options = { sessions: v.session, files, deleteImages: deleting && !!files, manual: deleting, tempOnly: v['temp-only'], removeImages: v['remove-images'], compactTools: v['compact-tools'], removeReasoning: v['remove-reasoning'], removeRequestArchives: v['remove-request-archives'], compactHooks: v['compact-hooks'], compactToolDefinitions: v['compact-tool-definitions'], compactSkillListings: v['compact-skill-listings'], removeOldSnapshots: v['remove-old-snapshots'] };
    const item = interactive ? await ui.scanCleanupPlans(config, p, options, signal) : await cleanupPlans(config, p, options, signal);
    if (!item) { process.exitCode = 130; return; }
    plans.push(...item);
  }
  if (files) {
    const eligible = new Set(plans.flatMap(p => p.actions.flatMap(a => a.files.map(f => f.path))));
    if (files.some(path => !eligible.has(path))) throw new UsageError('Some selected files are not eligible. Bulk destructive changes require files last modified more than 72 hours ago; inspect clean --dry-run to discover supported targets');
  }
  if (interactive && !v['dry-run']) {
    if (!plans.some(p => p.actions.length)) {
      ui.printPlans(plans);
      process.exitCode = plans.every(p => p.scanComplete) ? 0 : 1;
      return;
    }
    if (!await ui.confirmPlans(plans, signal)) { process.exitCode = 130; return; }
  }
  const result = interactive && !v['dry-run'] ? await ui.executeCleanup(config, plans, signal)
    : await execute(config, plans, !!v['dry-run'], signal);
  const status = signal.aborted || ('cancelled' in result && result.cancelled) ? 'interrupted'
    : result.receipts.some(r => r.status === 'needs-review') ? 'needs-review'
    : result.receipts.some(r => !r.scanComplete || !['completed', 'dry-run'].includes(r.status)) ? 'partial'
    : v['dry-run'] ? 'dry-run' : 'completed';
  if (v.json) console.log(JSON.stringify({ ...result, status })); else ui.printReceipts(result.receipts);
  process.exitCode = status === 'interrupted' ? 130 : ['partial', 'needs-review'].includes(status) ? 1 : 0;
}
main().catch(error => {
  const cancelled = controller.signal.aborted || ['ExitPromptError', 'AbortPromptError'].includes(error.name);
  process.exitCode = cancelled ? 130 : error instanceof UsageError ? 2 : 1;
  const code = cancelled ? 'INTERRUPTED' : error instanceof UsageError ? 'USAGE_ERROR' : 'OPERATION_FAILED';
  const message = stripVTControlCharacters(String(cancelled ? 'Interrupted; completed operations remain in statistics' : error.message)).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
  if (json) console.log(JSON.stringify({ schemaVersion: 1, status: cancelled ? 'interrupted' : 'failed', error: { code, message } }));
  process.stderr.write(message + '\n');
}).finally(() => { if (controller.signal.aborted) process.exitCode = 130; });
