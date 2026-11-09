import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';

export const version = '1.0.0';
const providers = ['all', 'claude', 'codex'];
const views = ['directories', 'projects', 'sessions', 'usage', 'opportunities'];
const common = ['provider', 'json', 'no-interactive', 'help', 'version'];
export const commandSchema = {
  schemaVersion: 1, status: 'completed', name: 'cc-clean', version,
  stateDirectory: '~/.config/cc-clean/',
  ageProtection: { hours: 72, basis: 'File modification time; strictly older than 72 hours', scope: 'Bulk deletion and history slimming', exception: 'One explicitly selected file or one session without descendants; --yes and multi-selection do not bypass protection', losslessPng: 'Exempt' },
  commands: [
    { command: 'clean', description: 'Clean known temporary outputs, PNGs and identical Codex history copies (keep zstd), or explicitly slim history', mutates: true, options: [...common, 'file', 'temp-only', 'remove-images', 'compact-tools', 'remove-reasoning', 'remove-request-archives', 'compact-hooks', 'compact-tool-definitions', 'compact-skill-listings', 'remove-old-snapshots', 'dry-run', 'yes'] },
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
    'temp-only': { type: 'boolean', description: 'Clean only verified temporary files, always strictly older than 72 hours; excludes PNG compression, history slimming and duplicate removal' },
    'remove-images': { type: 'boolean', description: 'Permanently replace inline history images with text (clean only)' },
    'compact-tools': { type: 'boolean', description: 'Permanently shorten recognized successful shell output using RTK filters (clean only)' },
    'remove-reasoning': { type: 'boolean', description: 'Permanently remove Codex encrypted reasoning state; summaries remain (clean only)' },
    'remove-old-snapshots': { type: 'boolean', description: 'Remove superseded Codex compaction history and metadata; keep the latest complete snapshot (clean only)' },
    'remove-request-archives': { type: 'boolean', description: 'Permanently remove Claude API request archives; retain conversation and usage records (clean only)' },
    'compact-hooks': { type: 'boolean', description: 'Permanently clear successful Claude hook commands, output and injected context; retain identities (clean only)' },
    'compact-tool-definitions': { type: 'boolean', description: 'Clear recorded Claude tool definitions; preserve system prompts and tool calls (clean only)' },
    'compact-skill-listings': { type: 'boolean', description: 'Clear recorded Claude skill descriptions and reset discovery state (clean only)' },
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
  cc-clean clean --temp-only [--provider claude|codex|all] [--dry-run|--yes]
  cc-clean clean --provider claude|codex --file <absolute-path> [--file <path>] [--dry-run|--yes]
  cc-clean clean [--provider claude|codex|all] [--remove-images] [--compact-tools] [--remove-reasoning] [--remove-request-archives] [--compact-hooks] [--compact-tool-definitions] [--compact-skill-listings] [--remove-old-snapshots] [--dry-run|--yes]
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
  --temp-only                   Clean only verified temporary files (strictly older than 72 hours)
  --remove-images               Slim history: irreversibly replace inline images with text
  --compact-tools               Slim history: irreversibly filter recognized shell output with RTK
  --remove-reasoning             Slim Codex history: irreversibly remove encrypted reasoning state
  --remove-old-snapshots         Slim Codex history: remove old snapshots; preserve the latest checkpoint
  --remove-request-archives     Slim Claude history: irreversibly remove API request archives
  --compact-hooks               Slim Claude history: clear successful hook commands, output and context
  --compact-tool-definitions    Slim Claude history: clear recorded tool definitions; keep system prompts
  --compact-skill-listings       Slim Claude history: clear skill descriptions and reset discovery state
  --help, -h                    Help; add --json for machine-readable command discovery
  --version                     Version; supports --json

Interactive cleanup:
  Scan and deep scan, then summarize category counts and estimated savings; View files for details.
  Press Enter to confirm cleanup; Q / Esc cancels. --yes does not skip this step.

Duplicate Codex histories:
  Ordinary clean and Quick clean remove a same-basename .jsonl only when its .jsonl.zst
  sibling decodes to exactly the same bytes. The compressed copy is kept unchanged.
  Both files must be more than 72 hours old and inactive, including explicit file selections.
  Unknown dependencies, links or damaged streams are retained. Each file is limited to 64 MiB.
  Temporary-only and standalone history-slimming modes exclude duplicate removal.

System temporary files:
  Quick clean and ordinary clean include known Claude/Codex files in /tmp, /var/tmp,
  the OS user temp directory, TMPDIR, TMP, TEMP, and Claude's CLAUDE_CODE_TMPDIR.
  Session creation records also locate temporary text outputs, including custom temp paths.
  Only verified outputs, cwd records and leftover installers; never whole directories.
  Use --temp-only or Clean temporary files for this scope without history or PNG changes.
  Always more than 72 hours old. Explicit targets and history-only flags exclude this scope.
  Close clients before cleanup; no computer restart is required.

72-hour protection:
  Bulk deletion and history slimming only affect files last modified more than 72 hours ago.
  One explicitly selected file or session without descendants may bypass this age limit.
  Multiple selections and --yes do not bypass it. Lossless PNG compression is exempt.

Agent usage:
  cc-clean --help --json
  cc-clean analyze --provider codex --view usage --json
  cc-clean stats --json
  Mutation commands require --yes without a terminal, or --dry-run to preview.
  Use process argument arrays (execFile/spawn), not interpolated shell strings.

Exit codes: 0 completed/preview/skipped, 1 failed/partial, 2 usage error, 130 interrupted.
State: ~/.config/cc-clean/. Sizes are logical bytes. CLI history slimming requires explicit flags; no undo.
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
      'remove-images': { type: 'boolean' }, 'compact-tools': { type: 'boolean' }, 'remove-reasoning': { type: 'boolean' }, 'remove-old-snapshots': { type: 'boolean' },
      'remove-request-archives': { type: 'boolean' }, 'compact-hooks': { type: 'boolean' },
      'compact-tool-definitions': { type: 'boolean' }, 'compact-skill-listings': { type: 'boolean' },
      'temp-only': { type: 'boolean' },
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
    if (values['temp-only'] && (command !== 'clean' || values.file || values.session || values['remove-images'] || values['compact-tools'] || values['remove-reasoning'] || values['remove-request-archives'] || values['compact-hooks'] || values['compact-tool-definitions'] || values['compact-skill-listings'] || values['remove-old-snapshots'])) throw new UsageError('--temp-only requires clean without explicit targets or history slimming flags');
    if ((values['remove-images'] !== undefined || values['compact-tools'] !== undefined || values['remove-reasoning'] !== undefined || values['remove-request-archives'] !== undefined || values['compact-hooks'] !== undefined || values['compact-tool-definitions'] !== undefined || values['compact-skill-listings'] !== undefined || values['remove-old-snapshots'] !== undefined) && command !== 'clean') throw new UsageError('History slimming flags require clean');
    if (values['remove-old-snapshots'] && provider === 'claude') throw new UsageError('--remove-old-snapshots applies only to Codex; use --provider codex or all');
    if (values['remove-reasoning'] && provider === 'claude') throw new UsageError('--remove-reasoning applies only to Codex; use --provider codex or all');
    if ((values['remove-request-archives'] || values['compact-hooks'] || values['compact-tool-definitions'] || values['compact-skill-listings']) && provider === 'codex') throw new UsageError('--remove-request-archives, --compact-hooks, --compact-tool-definitions and --compact-skill-listings apply only to Claude; use --provider claude or all');
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
