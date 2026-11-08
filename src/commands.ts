import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';

export const version = '1.0.0';
const providers = ['all', 'claude', 'codex'];
const views = ['directories', 'projects', 'sessions', 'usage', 'opportunities'];
const common = ['provider', 'json', 'no-interactive', 'help', 'version'];
export const commandSchema = {
  schemaVersion: 1, status: 'completed', name: 'cc-clean', version,
  stateDirectory: '~/.config/cc-clean/',
  commands: [
    { command: 'clean', description: 'Remove verified expired temporary files and losslessly compress eligible PNGs', mutates: true, options: [...common, 'file', 'dry-run', 'yes'] },
    { command: 'analyze', description: 'Report directory, project, session, usage and compression data', mutates: false, options: [...common, 'view', 'project'] },
    { command: 'analyze delete', description: 'Delete explicit sessions or eligible files', mutates: true, options: [...common, 'session', 'file', 'dry-run', 'yes'], requires: 'One provider and either session UUIDs or absolute file paths' },
    { command: 'stats', description: 'Report savings and operation history separately by provider', mutates: false, options: common },
  ],
  options: {
    provider: { type: 'string', choices: providers, default: 'all' },
    view: { type: 'string', choices: views, default: 'directories' },
    project: { type: 'string', description: 'Absolute project path; filters sessions with --view sessions' },
    session: { type: 'string', repeatable: true, description: 'Full session UUID to delete' },
    file: { type: 'string', repeatable: true, description: 'Absolute eligible file path; requires one provider' },
    'dry-run': { type: 'boolean', description: 'Preview only; do not modify source data or credit savings' },
    yes: { type: 'boolean', description: 'Explicit confirmation for noninteractive mutations; interactive cleanup still requires Enter' },
    json: { type: 'boolean', description: 'Emit exactly one JSON object on stdout and never prompt, including on errors' },
    'no-interactive': { type: 'boolean', description: 'Never prompt, even in a terminal' },
    help: { type: 'boolean', short: 'h', description: 'Show help; combine with --json for this command schema' },
    version: { type: 'boolean', description: 'Show version; supports --json' },
  },
  output: { schemaVersion: 1, stdout: 'One JSON object with --json; human-readable text otherwise', stderr: 'Diagnostics only', bytes: 'Logical bytes, not physical disk reclamation', unknown: 'Unavailable values are null; inspect completeness flags and warnings', errors: ['USAGE_ERROR', 'OPERATION_FAILED', 'INTERRUPTED'] },
  exitCodes: { '0': 'Completed, previewed or protectively skipped; inspect receipts for skips', '1': 'Failed, partial or needs review', '2': 'Invalid arguments or missing explicit confirmation', '130': 'Interrupted' },
};

export const help = `cc-clean · Claude Code / Codex storage manager

Usage:
  cc-clean                       Interactive menu in a terminal; help otherwise
  cc-clean clean [--provider claude|codex|all] [--dry-run|--yes]
  cc-clean clean --provider claude|codex --file <absolute-path> [--file <path>] [--dry-run|--yes]
  cc-clean analyze [--provider claude|codex|all] [--view directories|projects|sessions|usage|opportunities]
  cc-clean analyze delete --provider claude|codex --session <uuid> [--session <uuid>] [--dry-run|--yes]
  cc-clean analyze delete --provider claude|codex --file <absolute-path> [--file <path>] [--dry-run|--yes]
  cc-clean stats [--provider claude|codex|all]

Options:
  --project <absolute-path>      Filter project sessions (--view sessions)
  --json                        One JSON object, including errors; never prompt
  --no-interactive              Never prompt, even in a terminal
  --yes                         Confirm noninteractive mutations; interactive cleanup still requires Enter
  --dry-run                     Preview cleanup without modifying source data
  --help, -h                    Help; add --json for machine-readable command discovery
  --version                     Version; supports --json

Interactive cleanup:
  Scan and deep scan, then list all targets and estimated savings.
  Press Enter to confirm cleanup; Q / Esc cancels. --yes does not skip this step.

Agent usage:
  cc-clean --help --json
  cc-clean analyze --provider codex --view usage --json
  cc-clean stats --json
  Mutation commands require --yes without a terminal, or --dry-run to preview.
  Use process argument arrays (execFile/spawn), not interpolated shell strings.

Exit codes: 0 completed/preview/skipped, 1 failed/partial, 2 usage error, 130 interrupted.
State: ~/.config/cc-clean/. Sizes are logical bytes. Field mutation is not enabled.
`;

export class UsageError extends Error {}
export function parseCommand(args: string[], tty: boolean) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      provider: { type: 'string' }, view: { type: 'string' }, project: { type: 'string' },
      session: { type: 'string', multiple: true }, file: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' }, json: { type: 'boolean' }, 'no-interactive': { type: 'boolean' },
      yes: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    } });
  } catch (error) { throw new UsageError((error as Error).message); }
  const { values, positionals } = parsed;
  const command = positionals[0], deleting = command === 'analyze' && positionals[1] === 'delete';
  const mutating = command === 'clean' || deleting;
  const provider = values.provider ?? 'all', view = values.view ?? 'directories';
  const interactive = tty && !values.json && !values['no-interactive'];
  if (!values.help && !values.version) {
    if (positionals.length > (deleting ? 2 : 1) || command && !['clean', 'analyze', 'stats'].includes(command)) throw new UsageError('Unknown command; run --help for usage');
    if (!providers.includes(provider)) throw new UsageError('--provider must be all, claude or codex');
    if (!views.includes(view)) throw new UsageError('Unknown --view; run --help for supported views');
    if (values.view && (command !== 'analyze' || deleting)) throw new UsageError('--view is only valid for analyze');
    if (values.project !== undefined && (command !== 'analyze' || deleting || view !== 'sessions' || !isAbsolute(values.project))) throw new UsageError('--project requires analyze --view sessions and an absolute project path');
    if (values.session && !deleting) throw new UsageError('--session is only valid for analyze delete');
    if ((values.yes || values['dry-run'] || values.file) && !mutating) throw new UsageError('--yes, --dry-run and --file require a cleanup or deletion command');
    if (!command && Object.keys(values).some(key => !['json', 'no-interactive'].includes(key))) throw new UsageError('Specify a command');
    if (deleting && (provider === 'all' || !values.session?.length && !values.file?.length)) throw new UsageError('Deletion requires one --provider and at least one --session or --file');
    if (values.session && values.file) throw new UsageError('Select sessions or files in one invocation, not both');
    if (values.session?.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new UsageError('--session requires a full UUID');
    if (values.file && (provider === 'all' || values.file.some(path => !isAbsolute(path)))) throw new UsageError('--file requires one --provider and absolute file paths');
    if (mutating && !interactive && !values.yes && !values['dry-run']) throw new UsageError('Noninteractive mutations require --yes; use --dry-run to preview');
  }
  return { values, command, deleting, provider, view, interactive };
}
