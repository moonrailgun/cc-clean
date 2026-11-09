# cc-clean

A Node.js CLI for local Claude Code and Codex storage, with menu navigation inspired by [Mole](https://github.com/tw93/mole).

- **Clean:** scan and deep scan, review targets and estimated savings, then press Enter to clean verified temporary files older than 72 hours and losslessly compress eligible PNGs. Select files yourself or opt into **Slim history** to remove inline images and compact shell output.
- **Analyze:** explore Storage, browse Projects and their sessions, or open Insights for usage and images.
- **Statistics:** read recorded cleanup history, with before/after storage and cleaned record counts, separately for Claude and Codex.

The interface, help and diagnostics are in English. User paths and metadata retain their original text. Every cleanup operation is also accessible through command-line arguments; Agents do not need to navigate a menu.

**Not published yet.** Run the local project or its packed artifact. The intended published entry point is `npx cc-clean`; running that bare name now could download an unrelated package.

## Local development

Requires **Node.js 24+**.

```sh
npm install
npm run dev
```

The terminal interface follows Mole's numbered menus, cyan selection, storage bars and compact keyboard hints. Use **↑/↓** or **j/k** to move, **Enter** to select, and **1–9** for shortcuts in short menus. Cleanup confirmation accepts **Enter only**; number keys only move focus. **Q**, **Esc** or **←** goes back (or quits from the main menu). In lists, press **/** to filter, type your query, then press **Enter** to return to navigation; **Esc** clears the filter while typing. Use **Space** to toggle multiple items and **PgUp/PgDn** to page through long lists.

Storage bars scale against the largest entry; percentages use the current view's total. Narrow terminals show names and sizes without bars. Set `NO_COLOR` to disable colors; piped output has no terminal styling. Ctrl+C stops subsequent work and allows the current operation to finish its recovery bookkeeping. Opening the menu does not start cleanup.

Analyze has three entries: **Storage**, **Projects** and **Insights**. Projects includes **All sessions** as well as individual projects. Insights combines usage and image totals; open **Usage breakdown** for projects, dates and models, or **Details** for field sizes and scan notes. File selection lives under **Clean**. Use Q/Esc to return without a separate Back item.

Usage breakdown stays within one screen, with **Overview**, **Projects**, **Dates** and **Models** tabs. Use **←/→** or **Tab/Shift+Tab** to switch tabs, **↑/↓** or **j/k** to scroll, **PgUp/PgDn** to page, and **Home/End** to jump to the start or end. Each tab remembers its scroll position; **Q/Esc** returns. Tables have one project, date or model per row. Narrow terminals split the metric columns into smaller tables, preserving exact numbers. `—` means unavailable, not zero. This viewer also opens for interactive `analyze --view usage`.

Details is a collapsible tree: use **→** to expand, **←** to collapse or move to the parent, and **Enter** to toggle a group or read an item's full details. **PgUp/PgDn** scrolls long lists and notes. Fields are grouped under their parent, sorted by size; scan notes stay collapsed until opened. This tree also opens for interactive `analyze --view opportunities`; `--no-interactive` and `--json` remain plain reports for both views.

Insights keeps one report while you switch views. **Refresh** checks for changes; reopening Insights also checks the files again. Both provider-wide and individual-session scans share a persistent cache under `~/.config/cc-clean/`: unchanged session files reuse parsed results, while changed or replaced files are parsed again. The cache is bounded, and incomplete reads are not saved. Command-line views and JSON output retain their full detail.

Interactive scans show files discovered while finding the total, then **scanned / total session files**. Deep scans also show processed / total bytes, a percentage bar and the current file. Cached results count toward progress. Index reading and report building are shown as separate phases. Press **Q**, **Esc** or **Ctrl+C** during a scan to stop reading and return to the menu; cancelling a direct `analyze --view …` command exits with code `130`. Partial reads are not cached. JSON and noninteractive modes have no progress prompt; send SIGINT to interrupt them.

Read-only commands:

```sh
npm run dev -- analyze --provider claude --view projects
npm run dev -- analyze --provider codex --view sessions
npm run dev -- analyze --view usage
npm run dev -- analyze --provider claude --view sessions --project /absolute/project
npm run dev -- stats
```

Build and check the local package entry point:

```sh
npm run typecheck
npm run test:read-only
npm run build
node dist/cli.js --help
node dist/cli.js
npm pack
```

`npm pack` builds a local tarball without publishing. The package declares `cc-clean → dist/cli.js`; no global install or `npm link` is needed. To check a packed artifact, use its actual absolute path:

```sh
npm exec --package=/absolute/path/cc-clean-1.0.0.tgz -- cc-clean --help
```

`npm test` includes cleanup and native deletion tests against disposable fixtures. Agents must not run that suite or cleanup commands, including previews, without an explicit user request; see [AGENTS.md](AGENTS.md). `test:read-only` excludes cleanup planning/execution, file compression and native deletion. It includes synthetic in-memory history transforms, inert plan rendering, and temporary layout/receipt fixtures; it does not rewrite user history or invoke native clients.

## Agent and script usage

Invoke the source, built JavaScript or installed executable with argument arrays. Use `--json` for exactly one JSON object on stdout, including argument and operational errors. Progress and diagnostics go to stderr. `--json` disables prompts even in a terminal; `--no-interactive` does the same for human-readable output.

```sh
node src/cli.ts --help --json
node src/cli.ts analyze --provider codex --view sessions --json
node src/cli.ts analyze --provider claude --view usage --json
node src/cli.ts stats --json
```

`--help --json` returns a versioned command description with options, allowed values, mutation flags and exit codes. Bare `--json` also returns that description. `--version --json` returns the package version. For npm scripts use `npm run --silent dev -- ... --json` to keep npm's own banners out of stdout.

For example, from the repository root:

```js
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

execFile(process.execPath, [resolve('dist/cli.js'), 'analyze', '--provider', 'claude', '--json'], {
  timeout: 120_000,
  maxBuffer: 32 * 1024 * 1024,
}, (error, stdout, stderr) => {
  if (!stdout.trim()) throw error ?? new Error(stderr || 'No CLI response');
  const result = JSON.parse(stdout);
  if (error) console.error({ exitCode: error.code, status: result.status, error: result.error });
  // Partial reports are still useful; inspect status and completeness before using totals.
  console.log(result);
});
```

A timeout or killed process may leave no complete JSON response. For mutations, inspect `stats --json` before deciding what to do next; never blindly retry a deletion after an uncertain result.

### Output contract

All JSON responses carry `schemaVersion` and `status`. Successful statistics responses use version `2`; other responses use version `1`:

- Analysis: `reports`, each containing directories, categories, projects, sessions, usage, opportunities, warnings and completeness flags.
- Cleanup: `receipts` with actions, skips, before/after bytes and confirmed reductions. Each action can include `estimatedSavingsBytes` (`null` when unknown); this estimate is separate from measured savings and may be absent in older receipts. `slim-history` actions also include `slimOptions: { removeImages, compactTools }` and `slimCounts: { images, toolOutputs }`, with `slimSavingsBytes` attributing estimated reductions to each operation. Codex rewrites include `codexProjection` for coordinated index updates. Optional `explicitTarget` records the one user-selected file path or session ID for the age exception below; automatic and multiple selections omit it.
- Statistics: `providers`, `savedBytes` and `cleanedRecords`. Each provider includes these totals, JSONL `operations`, a `pending` review count and `pendingOperations` recovery receipts. `--provider` limits both the returned providers and totals.
- Errors: `error: { code, message }`, with `USAGE_ERROR`, `OPERATION_FAILED` or `INTERRUPTED`.

Statuses are `completed`, `dry-run`, `partial`, `needs-review`, `failed` and `interrupted`. `completed` does not mean every candidate was changed: protective skips appear in receipts. A completed statistics request can contain older operations that need review.

| Exit code | Meaning |
| --- | --- |
| `0` | Completed, previewed or protectively skipped; inspect receipts |
| `1` | Failed, partial or needs review |
| `2` | Invalid arguments or missing explicit mutation confirmation |
| `130` | Interrupted or cancelled |

Missing measured values are `null`, not zero. Optional metadata may be absent. Check `scanComplete`, `complete`, `usage.verified` and warnings. JSON analysis always includes the whole report: `--view` selects human formatting and whether usage/field parsing runs deeply. `--project` with `--view sessions` filters the session list only; provider totals retain their full scope. Agents can sort and filter the returned arrays directly. `stats --json` includes full operation details without an interactive picker.

### Explicit cleanup requests

The following are command examples, not actions performed by installation or analysis. Only run them when cleanup is intended. Noninteractive mutations require **`--yes`**; **`--dry-run`** previews without changing source data or crediting savings. Neither flag bypasses protection checks.

```sh
# Preview verified automatic rules.
node src/cli.ts clean --provider codex --dry-run --json

# Explicitly run those rules.
node src/cli.ts clean --provider codex --yes --json

# Compress one eligible PNG, using a canonical absolute path from the report/preview.
node src/cli.ts clean --provider codex --file /absolute/.codex/generated_images/example.png --yes --json

# Delete explicit sessions; replace the sample UUID with one from analysis.
node src/cli.ts analyze delete --provider claude --session 12345678-1234-1234-1234-123456789abc --dry-run --json

# Permanently delete an eligible file, including a PNG.
node src/cli.ts analyze delete --provider codex --file /absolute/.codex/generated_images/example.png --yes --json
```

Repeat `--session` or `--file` to select multiple targets. Explicit selections require one provider; session and file selections cannot be mixed. File selections remain subject to the same eligibility rules as the menu, and an ineligible selection fails before execution. Session deletion previews include verified descendants.

Every cleanup plan starts with a storage scan and deep session analysis. Interactive cleanup, including Quick clean, Slim history, selected files, session deletion and terminal commands with `--yes`, lists the full target paths, operations and estimated savings before asking for confirmation. Press **Enter** to start the listed operations automatically; **Q / Esc** cancels. No source files are changed before confirmation. Cancelling a scan cancels the request. Noninteractive and JSON commands never prompt and still require explicit `--yes` for mutation. Deletion and history slimming are permanent; this tool does not offer undo.

Deletion estimates use the selected files' logical sizes. PNG estimates recompress verified source data in memory without replacing files. Failed estimates remain unknown instead of counting as zero. Estimates may differ from actual directory changes, especially when safety checks skip changed or active files. Actual savings are measured around execution.

### 72-hour protection

Quick clean, automatic selection and bulk operations only delete or irreversibly change files whose **last modification time is more than 72 hours ago**. This includes temporary files, generated-image deletion, session deletion, inline-image removal and shell-output compaction. Session creation time does not determine eligibility. Recent files, files exactly 72 hours old, future timestamps and invalid timestamps are retained, with reasons shown and no estimated savings credited. Execution rechecks age and file identity before mutation.

Only explicitly selecting **one file or one session without descendants** can bypass the age limit. Multiple selections, choosing a provider, `--yes`, or a scan finding only one candidate do not bypass it. A session deletion that includes descendants is protected as a group: any recent file retains the whole action. Other checks and confirmation still apply to a single target.

Lossless PNG recompression that preserves image content and supported metadata is exempt from the age limit.

### Slim history

Open **Clean → Slim history**, choose Claude Code, Codex or both, then enable either or both options. Both start unchecked; Quick clean does not enable them. This bulk flow only changes history files last modified more than 72 hours ago; an explicit single-file CLI operation can use the age exception above.

| Option | Effect |
| --- | --- |
| **Remove inline images** / `--remove-images` | Replace recognized Base64 image content blocks with a text block containing `[image removed]`. Remove recognized duplicate inline images from Codex UI events while keeping image hints and ordering aligned. |
| **Compact shell output** / `--compact-tools` | Apply the ported RTK filters to recognized, completed, successful shell output. Keep tool-call IDs and execution metadata, and mark omitted content as unavailable. |

The preview lists full file paths, enabled operations, stored image copies removed, tool outputs compacted, and exact estimated byte reductions. Image counts include duplicate stored copies, not unique pictures. Estimation transforms data in memory; execution repeats the transform and requires matching source/result hashes before atomic replacement. No-saving files are omitted; unsupported files are retained with warnings.

The following are examples to run **only when explicitly requested**:

```sh
# Preview both operations for both providers; does not modify history.
node src/cli.ts clean --provider all --remove-images --compact-tools --dry-run --json

# Interactively review and press Enter to remove inline images.
node src/cli.ts clean --provider claude --remove-images

# Explicit noninteractive compaction of one selected history file.
node src/cli.ts clean --provider codex --file /absolute/.codex/sessions/example.jsonl --compact-tools --yes --json
```

Supported inputs are Claude Code **2.1.319** transcripts and independent plain legacy or paginated Codex rollouts, up to **64 MiB per file**. Claude version fields must all match. Codex compatibility follows record structure and identity, with version fields preserved. Every current and archived header, including compressed files, is checked for inbound references. Shared, forked, imported, attached, compressed or hardlinked targets are retained; unrelated compressed or hardlinked files do not block independent targets.

Codex rewrites remap recognized SQLite byte offsets and cached items within the coordinated replacement and recovery flow. Pending rewrites require `codexProjection` receipts, including an explicit empty array when no databases exist. Unknown offset schemas, unsupported dependencies, external SQLite locations and uncertain configuration prevent rewriting. Generic file deletion/compression cannot bypass history coordination.

Image removal handles Claude message and nested tool-result image blocks, Codex top-level response-message `input_image` data URLs, and known Codex user-message UI image arrays. Remote URLs, local image paths, standalone generated image files, arbitrary Base64 text, reasoning/signatures and unknown image shapes stay intact. Codex compacted replacement histories are not rewritten.

The RTK subset covers numbered `rg`/`grep` matches, `rg --files`/`find`/`fd` listings, recognized successful `cargo test` output and all-passed `pytest` output. Search output keeps up to 10 matches per file; listings keep up to 20 directories and 10 files per directory. Test output retains summaries. Claude requires a paired `Bash` result explicitly marked successful; Codex requires a paired `exec_command` or `shell_command` result with a recognized successful completion envelope. Shell pipelines, compound commands, JavaScript `functions.exec` wrappers, failures, warnings, terminal controls and unrecognized output stay intact. Historical commands are never executed.

**Loss is permanent:** removed image content and omitted command output cannot be recovered from cc-clean. Temporary recovery originals are removed after successful finalization. Synthetic checks cover the transformations and guards; native resume/continuation after a rewrite has **not** been verified. See [compatibility limits](docs/native-compatibility.md#history-slimming-synthetic-checks-only).

## Configuration and application data

All application configuration, cleanup history, analysis caches, operation receipts and transaction files live in:

```text
~/.config/cc-clean/
  config.json
  cleanup.jsonl
  providers/
    claude/
    codex/
```

Source roots default to `~/.claude` and `~/.codex`. Override them with absolute paths in `config.json`:

```json
{
  "roots": {
    "claude": "/absolute/path/.claude",
    "codex": "/absolute/path/.codex"
  }
}
```

Precedence: configuration file → `CLAUDE_CONFIG_DIR` / `CODEX_HOME` → defaults. Root symlinks resolve to their canonical locations; links inside a source root are not followed. Caches store analysis summaries, paths and necessary identifiers, not conversation text. Analysis may write these bounded caches but does not change source data. npm's package cache is separate from application state.

## Supported scope

| Feature | First-version support |
| --- | --- |
| Temporary files | Codex **0.167.0** root files named `..codex-global-state.json.tmp-*`, with a valid final state file; subject to 72-hour protection and its explicit single-target exception |
| PNG compression | Eligible static PNGs in Codex `generated_images/`; recompress IDAT losslessly, preserving inflated scanlines and supported metadata; replace only when smaller |
| Claude session deletion | Complete **2.1.319** transcripts and verifiably owned subagent/tool-result files; retain memory, configuration, file-history and history.jsonl |
| Codex session deletion | Installed **0.167.0**, through official `codex delete`; verify full spawn descendant scope; reject incomplete indexes, attached relationships and compressed rollouts |
| History slimming | Opt-in removal of recognized inline images and RTK shell-output compaction for Claude **2.1.319** and independent plain legacy/paginated Codex history with coordinated SQLite updates; irreversible, with native resume unverified |
| Platforms | Mutations on macOS after checks; analysis, previews and statistics on other platforms |

Claude has no verified automatic temporary-file or standalone-image rule yet, so its quick clean may report zero candidates. A directory called `.tmp` or `cache` is not automatically disposable: installed plugins may still reference its resources through links.

Close the relevant Claude/Codex clients and services before mutation. Active processes, open files, incomplete scans, uncertain references and changed files block affected operations. Live analysis is a snapshot that may change. Session deletion currently requires complete deep analysis of the provider; an unrelated malformed or oversized transcript can also block deletion.

PNG compression excludes APNG, unknown/unsupported chunks, damaged images, extended attributes, JPEG/WebP and Base64 images. History slimming handles supported Base64 images separately. Direct file transactions require the source and application work directory on the same filesystem. See [native compatibility evidence](docs/native-compatibility.md) for native version checks and limits.

## Accounting and recovery

Statistics come only from `~/.config/cc-clean/cleanup.jsonl`. An actual cleanup execution records one line per provider, using the source directory's logical size immediately before and after execution. Opening the app, analysis, previews and cancelled confirmations do not create cleanup history. An executed cleanup with no eligible items records zero changes. Without history, savings and cleaned records are both zero. Application caches, receipts and work files are not subtracted from savings.

Each line is a JSON object, for example:

```json
{"schemaVersion":1,"operationId":"12345678-1234-1234-1234-123456789abc","provider":"claude","root":"/Users/example/.claude","source":"analyze","startedAt":"2026-11-08T10:00:00.000Z","finishedAt":"2026-11-08T10:00:02.000Z","status":"completed","beforeBytes":10485760,"afterBytes":8388608,"savedBytes":2097152,"cleanedRecords":2,"cleanupTypes":[{"type":"delete-sessions","cleanedRecords":2}],"needsReview":false}
```

- **Times and sizes:** `startedAt` is the execution start, after confirmation; `finishedAt` is its end. `savedBytes` equals `beforeBytes - afterBytes`.
- **Records and types:** count only completed, finalized actions. `delete-sessions` counts sessions including deleted descendants; `delete-files`, `compress-png` and `slim-history` count files. Slimming does not count as deleting a session. `cleanupTypes` groups the counts, whose sum is `cleanedRecords`. Skipped and failed items do not count.
- **Totals:** sum verified history entries, separately for Claude and Codex. Incomplete measurements use `null` and set `needsReview`; those operations are excluded from totals. Recovery updates the same operation ID without double counting.

Hard links count once. These are logical bytes, not physical free space on APFS or another filesystem. Native startup files or concurrent writes inside the source directory can affect the measured difference, including making it negative. The receipt's `confirmedReductionBytes` remains a separate action-level diagnostic; it is not the statistics total.

Quick clean and analysis-driven cleanup share one executor. Detailed receipts remain alongside the JSONL history for safe recovery. Before the next mutation, unfinished direct-file transactions are reconciled. A delayed recovery cannot reconstruct the original after-size, so it records an unknown measurement rather than crediting a later scan. Uncertain native deletions remain `needs-review`, receive no savings credit, are not automatically retried, and block new mutations for that provider. Inspect `stats --json`; removing receipts is not a recovery procedure. Whole-machine power-loss recovery is unverified.

Metadata analysis reads bounded record prefixes; usage and field analysis parse deeply on request. Missing, oversized, damaged, forked or imported data can produce partial or unknown usage, which is not a complete bill. Deleting sessions changes current usage reports while preserving historical cleanup savings.

## Third-party attribution

Shell-output compaction contains modified TypeScript ports of selected [RTK CLI](https://github.com/rtk-ai/rtk) filters, copyright **2026 RTK AI Labs**, licensed under **Apache License 2.0**. The pinned upstream revision is [`653efb6ed02bd287d686c50e830dd1009356904f`](https://github.com/rtk-ai/rtk/tree/653efb6ed02bd287d686c50e830dd1009356904f). Only the Apache-2.0 CLI `src/` code is used; RTK's BUSL-1.1 engine/proxy code is not included.

See the distributed [Apache-2.0 license](third_party/rtk/LICENSE) and [source/function mapping and modifications](third_party/rtk/UPSTREAM.md). This port implements the subset described above, not all RTK filters or its runtime.
