# cc-clean initial release design

Date: 2026-11-08. Status: the initial release has been implemented according to the approved design but has not been published.

This document preserves the research snapshot and proposals from the design phase. Refer to the [README](../../../README.md) for current support, local usage, and limitations. The implementation is directly on `main`, with no commits created at the time of this snapshot.

Subsequent explicit requirements: the application must use English throughout; provide non-interactive commands directly callable by agents, JSON command discovery, structured errors, and exit codes; never automatically run cleanup commands (including previews and cleanup tests). See the root `AGENTS.md`.

## 1. Product scope and boundaries

`cc-clean` is a local Node.js command-line tool intended to launch through `npx cc-clean` after publication. The initial release supports Claude Code and Codex, with three main menu entries: **Quick clean, Analyze, Statistics**.

The user has confirmed: clean temporary files older than 3 days, compress images, analyze directories/projects/sessions/usage, and accumulate storage changes from each cleanup separately for Claude and Codex. Specific field-compaction rules will be decided later.

Selected implementation choices: Node.js 24+, TypeScript, an English-only application, initial validation on macOS, lightweight list interactions, and lossless image compression by default. The initial release excludes background services, scheduled jobs, cloud sync, cost estimates, and support for other AI tools.

Store configuration, caches, operation records, and working files under `~/.config/cc-clean/`. Keep original Claude / Codex data in place without migration. Standard `npx` uses npm's own package cache; this is not application state and does not count toward cleanup savings.

### Approach selection

| Approach | Benefits | Tradeoffs | Decision |
| --- | --- | --- | --- |
| Menus + filterable hierarchical lists + subcommands | Similar to Mole; no mouse required; suitable for drilling into analysis and selecting cleanup targets | Does not keep multiple dashboard panels visible | **Selected for the initial release** |
| Full-screen dashboard | Shows directory trees, charts, and session details together | More complex layout, focus, terminal compatibility, and refresh state | Deferred |
| Commands and arguments only | Minimal implementation, easy to script | Less helpful for discovering storage usage and drilling into selections | Retained as direct entry points to the same system |

Take inspiration from [Mole](https://github.com/tw93/mole) for menus, size sorting, hierarchical browsing, execution progress, and completion reports. Implement independently without copying its GPL source code.

## 2. How local research informed the design

The following is a read-only scan snapshot from 2026-11-08. Sizes are logical bytes of regular files; directory symlinks are not followed, and hard links are deduplicated by device and inode. The applications are in use, so the snapshot will change. These GiB figures are not promises of recoverable physical disk space.

| Source | Total storage | Main components |
| --- | ---: | --- |
| Claude Code | About 2.95 GiB across 5,673 files | `projects`: about 2.87 GiB, including 514 JSONL files and 44 project directories |
| Codex | About 39.87 GiB across 33,891 files | `sessions`: about 29.28 GiB; `thread_history_1.sqlite`: about 6.06 GiB; `generated_images`: about 1.93 GiB |

Key findings:

- Sampled Claude sessions contain many Base64 images and duplicate images, along with `api-request-blob`, hashes, and request references. Duplication alone does not make content safe to delete.
- Codex uses more than JSONL. Its history database stores offsets such as `rollout_byte_offset` and `rollout_end_byte_offset`; changing JSONL lengths can invalidate history locations in the database.
- The Codex state database has 5,521 thread records, but they do not correspond one-to-one with session files on disk. Querying the database alone cannot establish complete analysis.
- Codex `generated_images` contains 1,071 PNGs totaling about 1.93 GiB, making them an initial candidate for standalone image compression. Compression ratios have not been measured.
- `~/.codex/plugins/cache/openai-bundled/chrome/latest` currently points to plugin resources under `~/.codex/.tmp/`. **Never delete `.tmp` as a whole directory.**
- Claude's `stats-cache.json` was last computed on 2026-09-28, before this scan. Label usage data with its timestamp instead of treating an old cache as live results.
- Local Codex 0.167.0 provides `codex delete <SESSION> --force`, which requires a UUID. Prefer the official command for session deletion so it maintains internal state.
- Local Claude Code 2.1.319 provides `claude purge`, but its scope includes project data and project entries in `~/.claude.json`. Do not silently treat it as deleting only selected sessions.

Session-format research sampled only 3 files per provider, parsing approximately the first 32 MiB of each and reading the final line in full. This was not exhaustive format-compatibility validation. Authentication configuration contents were not read, and no actual deletion, image rewriting, or session-resume tests were performed.

## 3. User interaction

### Main menu

```text
cc-clean
Claude Code  Detected       Codex  Detected

❯ Quick clean    Clean expired temporary files and try lossless image compression
  Analyze        Inspect directories, projects, sessions, and usage
  Statistics     View current and cumulative savings
  Exit

↑↓ Select · Enter Open · Ctrl+C Exit
```

The main menu must not wait for tens of GB of session parsing. Check only whether roots exist and show timestamps for any existing statistics. Scan after the user enters the relevant feature.

Use the same list style throughout. Hierarchical pages have breadcrumbs and a Back entry; allow switching sources, sorting, and filtering, with Space to select in multi-select lists. Use the library's native key bindings instead of writing a complete terminal framework to replicate Mole.

Paginate long lists and sort by storage usage descending by default. When a list truncates paths, show full paths and stable IDs in details. Never delete based only on a project name or session title that may be duplicated. Fall back to item-by-item text in narrow terminals. Respect `NO_COLOR`, and never convey information through color alone.

### Quick clean

After selection, directly execute rules already defined as safe defaults without requiring per-file decisions. Distinguish candidate discovery, validation, processing, skips, and failures during execution. Show 0 when there are no candidates.

```text
Quick clean

✓ Claude Code      Scan complete
✓ Codex            Scan complete
  Expired files    Processed 8 / 8
  Lossless PNG     Processed 42 / 120
  Field compaction No rules enabled yet

Ctrl+C stops subsequent tasks and saves completed results
```

The figures in this completion report are interaction examples, not measured local savings:

```text
Cleanup complete

                         Claude Code     Codex
Verified action savings  24 MiB          186 MiB
Directory size change    24 MiB          174 MiB
Skipped                  2 items        6 items

Codex directory change is smaller than action savings: other writes were detected.
View details / View cumulative statistics / Back
```

### Analyze

```text
Analyze / Codex                        Scan completed at 14:32

❯ Directories    Sessions, databases, images, caches, plugins...
  Projects       Project storage, session counts, recent activity
  Sessions       Large sessions, old sessions, archives, child sessions
  Usage          Active dates, models, messages, tool calls, tokens
  Opportunities  Image and field sizes, potential duplicates
  Back
```

Project lists show project, session-file storage, attributable attachment storage, session count, recent activity, and scan completeness. Enter a project to list its sessions. Enter a session to list its main record, child sessions, attachments, and composition by record type and field.

All storage pages offer Filter / Sort / Select cleanup targets. Available actions depend on the object's capabilities:

- Temporary files: delete selected items that satisfy the rules.
- Standalone PNGs: losslessly compress selected items; users may also explicitly choose permanent image deletion.
- Sessions: delete selected sessions and the associated records shown in the preview.
- Projects: expand into session selection for that project, without directly deleting the project directory.
- Databases, plugins, configuration, memory files, and unknown files: show storage usage and the reason for retention, without a generic `rm` button.

Before any manual deletion, show the source, full path or UUID, scope of child sessions and associated files, estimated bytes, and "Permanent deletion; this tool cannot undo it." Then require one confirmation that defaults to Cancel. Session and image deletion are never part of Quick clean.

## 4. Command contract

These command examples are intended for use after publication. Do not run bare `npx cc-clean` yet, to avoid downloading an unrelated package with the same name.

```bash
npx cc-clean
npx cc-clean clean
npx cc-clean clean --provider codex --dry-run
npx cc-clean analyze
npx cc-clean analyze --provider claude --view projects
npx cc-clean analyze --provider codex --view sessions --project /absolute/project
npx cc-clean analyze --view usage --json
npx cc-clean analyze delete --provider codex --session <uuid> --dry-run
npx cc-clean analyze delete --provider codex --session <uuid>
npx cc-clean stats
npx cc-clean stats --provider claude --json
npx cc-clean --help --json
```

| Argument/behavior | Contract |
| --- | --- |
| `--provider claude\|codex\|all` | Defaults to `all`; selecting sessions or files requires a single source |
| `--view directories\|projects\|sessions\|usage\|opportunities` | Defaults to directories; can be switched in a TTY |
| `--project <absolute-path>` | Only for `analyze --view sessions`; matches a normalized project path and filters the session list without changing source totals |
| `--session <id>` | Repeatable; selects exact sessions without guessing or expanding unknown IDs |
| `--file <absolute-path>` | Repeatable; selects files satisfying existing rules; cannot be combined with `--session`, and any ineligible file is rejected before execution |
| `--dry-run` | Generates and displays a plan without modifying source data, calling deletion commands, or recording savings; may update this tool's scan cache |
| `--json` | stdout contains a single JSON object with `schemaVersion` and `status`, including for errors; diagnostics go to stderr; no ANSI or interactive prompts |
| `--no-interactive` | Always disables prompts while retaining human-readable output |
| `--yes` | Explicitly confirms mutations for Quick clean and manual deletion; does not bypass protection, activity detection, or version-compatibility checks |
| `--help --json` / bare `--json` | Outputs versioned command descriptions, arguments, values, mutation markers, and exit codes for agent capability discovery |
| Non-interactive environment | A bare command prints usage; analysis prints a report; all mutation commands require `--yes`, or `--dry-run` for preview only |
| Exit codes | `0`: completed or no candidates; `1`: execution/scan failed or incomplete; `2`: argument error or missing non-interactive confirmation; `130`: user interruption |

Expected protective skips are not errors, but record the reason for each. If every explicitly requested deletion target is blocked, return incomplete rather than success. JSON reports include `status`, `scanComplete`, and category counts; exit codes alone do not express every detail.

JSON errors use `error: { code, message }`, with codes `USAGE_ERROR`, `OPERATION_FAILED`, or `INTERRUPTED`. Agents can invoke source, build output, or installed commands through process argument arrays without menu interaction.

In the initial release, `--file` accepts only eligible files validated by scanning and rules. Do not allow arbitrary-path deletion, a `--force` protection bypass, or project-wildcard deletion. Interactive file selections must also use object IDs produced by scanning.

## 5. Cleanup rules

### Temporary files older than 3 days

Define "3 days" as the fixed operation start time minus file `mtime` being **strictly greater than 72 hours**. Skip files exactly 72 hours old, files with future timestamps, changing files, and files whose purpose cannot be confirmed. Do not use directory timestamps or access times, and do not treat old sessions as temporary files.

| Object | Default policy |
| --- | --- |
| Leftover atomic-write temporary files from verified versions, such as `..codex-global-state.json.tmp-*` in the Codex root | Eligible when older than 72 hours, the final file is valid, and no writer is active; do not output the final file's contents |
| Tool temporary artifacts with explicit lifecycle rules | Eligible when the rules are satisfied and there are no references, open handles, or active writers |
| Entire `.tmp`, `cache`, or `paste-cache` directories | Classify and analyze only; a directory name alone does not justify deletion |
| `.tmp` subtrees targeted by plugin symlinks | Protect them and their ancestor directories |
| `shell_snapshots`, `file-history`, session attachments, and tool results | Long-term records; never automatically delete solely because they are older than 3 days |
| Skills, plugins, packages, memories, worktrees, authentication, and configuration | Excluded from default cleanup |

Initial temporary-file rules use explicit path patterns and version tests. If Claude has no verified temporary-file rule, report "No automatic cleanup items available" instead of expanding scope to produce candidates.

Neither scanning nor execution follows symlinks within source roots. An explicitly configured root may resolve to a real path, but display its actual location. Do not rewrite or automatically delete hard-linked files; show shared storage separately in analysis. Disable mutations when source roots overlap or resolve to the same location, preventing duplicate operations and accounting across sources.

### Image compression

The initial release compresses **standalone static PNGs that have finished writing** by default. Preserve paths, format, dimensions, pixels, transparency, color information, and existing metadata. Do not reduce resolution, quantize palettes, or convert PNG to JPEG.

Start by recompressing PNG IDAT streams with `node:zlib`: retain original scanline data and all allowed non-IDAT chunks, changing only Deflate compression. This avoids native image dependencies and the bit-depth conversions or metadata loss of ordinary decode/encode workflows. Validate signatures, chunk lengths, CRCs, IDAT ordering, and complete decompression. The decompressed data hashes before and after must match. Skip unknown chunks, signature chunks, APNGs, corrupt images, and images exceeding resource limits. The implementer determines the allowed chunk set from the PNG specification and test samples.

Replace only when the new file is smaller, preserving original permissions and `mtime`. Keep the original if compression fails or does not reduce size; also skip when file attributes cannot be preserved. PNG compression is exempt from the older-than-72-hours rule but remains subject to writer and stability checks.

Compression gains may be limited, especially for already well-compressed images. Verify actual savings before considering a heavier lossless optimizer. Initially report storage for JPEG, WebP, GIF, and inline Base64 images without re-encoding them under an unverified losslessness assumption.

Standalone-image rules do not apply to Claude inline images or indexed Codex sessions. Prove compatibility of associated hashes, references, history indexes, and resume behavior before adding corresponding adapter capabilities.

### Field compaction

The initial release provides a field-size report and **does not arbitrarily decide which fields are useless**. Report field paths, record types, occurrence counts, estimated bytes, duplication, and sample coverage.

Research candidates include duplicate Claude image storage and request debug records, plus duplicate Codex tool output, `replacement_history`, and skill snapshots. Being a candidate does not imply deletability. Do not process signatures, encrypted content, related IDs, usage, message ordering, or unknown fields based on their names alone.

Each future compaction rule must specify applicable versions, preserved semantics, and index/hash handling, and verify history display, session continuation, and associated tool results. Successful JSON parsing is not sufficient validation. Do not add an ineffective "aggressive mode" to the initial release.

### Session deletion from analysis

**Codex:** After selecting a UUID, expand verifiable child-session relationships and preview the complete deletion set. During implementation, use isolated data to verify the actual cascade scope of the current official deletion command. Reject parent-session deletion when the full scope cannot be enumerated. After confirmation, invoke `codex delete <uuid> --force` through an argument array, binding the resolved `CODEX_HOME` for this operation. Do not use shell concatenation, remote services, or name matching. The native client maintains internal state; cc-clean does not write SQLite directly or run `VACUUM` itself. Do not present archiving as savings.

After deletion, verify that planned files and session records are gone. Database files may not shrink after row deletion; measure actual savings. Continue showing remaining images or shared attachments as separate storage without automatically cascading deletion to them. If the official command is missing, the version is unverified, or the command fails or times out, do not fall back to deleting JSONL directly. Native commands may trigger their configured lifecycle behavior, so enable deletion only for local versions that pass isolated validation. Do not promise that the subprocess never uses the network.

**Claude:** In the initial release, session deletion is limited to structurally validated local session groups: the main JSONL, child sessions, and tool-result files confirmed to belong exclusively to that session. Verify the current client's list refresh and continued reading of other sessions using test data. Do not enable deletion when the version or references cannot be confirmed. Preserve project `memory`, configuration, file history, and resources without proven exclusive ownership, and show retained storage on the confirmation page. Historical prompt inputs in `history.jsonl` are outside this deletion scope; do not promise to erase all historical traces.

Project-wide cleanup is a batch of these session deletions. Claude `purge` has broader scope and is not wrapped in the initial release. Merge the deletion sets when both Codex parent and child sessions are selected to avoid repeated execution and duplicate savings accounting.

Session deletion for both providers is part of the initial release, bounded by verified versions and structures. An always-disabled button does not count as delivery.

## 6. Analysis data model and completeness

### Four reconcilable levels

1. **Source totals:** logical bytes under the root, file count, allocated-byte reference values, and scan errors.
2. **Directories/categories:** sessions, history databases, image attachments, temporary files, caches, plugin runtimes, configuration/memory, and other files.
3. **Projects:** clearly attributable sessions and attachments, with shared and unattributed data listed separately.
4. **Sessions:** main sessions, child sessions, constituent files, recent activity, and usage such as records/tokens.

Each file belongs to exactly one storage category, and each physical file is counted once. Project subtotals + shared + unattributed data must reconcile with source totals, allowing explicitly listed scan discrepancies. Put actual database file sizes under shared storage instead of dividing them across projects by row count. An optional estimate of database payload attributable to a project must say "Included in the shared database; excluded from subtotal sums."

Prefer explicit project metadata and session `cwd` for project identity. Normalize paths that exist; retain original identity for paths that no longer exist. Do not reverse Claude's hyphen-encoded directory names into presumed real paths. List worktrees separately by default without recursively scanning all Git repositories. For sessions spanning multiple cwd values, retain all observed paths; use explicit project metadata or the first valid cwd for primary attribution, otherwise classify the session as unattributed.

Codex combines disk scans with read-only SQLite indexes. Fall back to files when databases are missing, locked, or have unknown schemas, and label the missing information. Read-only connections must not create or migrate databases. For WAL, use SQLite's own consistent reads instead of fabricating a static snapshot by ignoring WAL.

### Usage

Provide session counts, main/child-session counts, user-message counts, tool-call counts, last activity, and available token usage by source, project, session, date, and model. Call the difference between the first and last session timestamps a "time span," not actual working time.

Token adapters distinguish per-request increments from cumulative snapshots, preferring authoritative usage records for the same version. Deduplicate by request/message IDs. For cumulative snapshots, use only the final value or reliable increments within the same counting interval. Do not add cached or reasoning tokens again when they are already included in totals. Split intervals when models change or counters reset.

Show missing data as unknown, never zero. Mark inherited usage from forks, imports, or child sessions as uncertain when it cannot be reliably deduplicated, and exclude it from verified totals. Show parsed-file counts and usage coverage. Deduplicate tool calls and messages by event identity as well; JSONL line counts are not message counts.

Keep the two time scopes explicit: **Analyze** shows currently retained data; **Statistics** shows savings from cc-clean's past cleanup operations. Deleting sessions reduces current usage analysis. The initial release does not add a complete permanent usage archive.

### Fields and duplicates

Measure record types by actual bytes of complete lines. Estimate field contributions as serialized bytes at the selected level without adding parent and child fields twice. Label sample-based estimates with sample sizes instead of presenting them as full scans. Identify duplicate images by content hashes and report potential opportunities without counting duplicate bytes directly as recoverable savings.

### Scan performance

Use `stat` first to measure directory storage, then read project/session metadata as needed. Only usage and field analysis require deep streaming parsing. Support cancellation, incremental result batches, and progress. Invalidate caches by canonical path, device/inode, size, mtime/ctime, and parser version. Cache only summaries, necessary IDs, and paths, without copying conversation bodies or Base64 content.

Suggested initial concurrency: 8 for file scanning, 2 for session parsing, and 1 for image compression. Cap large lines and decompressed image sizes, reporting skips. Never use unbounded `readFile` calls over entire batches of sessions. Interruptions, permission errors, and malformed lines produce partial reports; do not count unscanned files as zero. Limit cache capacity and evict the oldest entries when exceeded. Do not evict the history ledger with the cache.

## 7. Cleanup execution and data protection

Both entry points use the same flow:

```text
Quick clean     ─┐
                 ├─ Plan → Check scope → Record intent → Execute → Remeasure → Save receipt
Analyze cleanup ─┘
```

Plans bind source roots, rule/client versions, exact targets, expanded dependencies, and fingerprints such as device/inode, size, and mtime/ctime. Recheck before execution; skip or regenerate the preview when anything changes instead of reusing a stale plan.

Use conservative activity detection for in-place mutations. If the source's client or writer service is still running, or its state cannot be reliably determined, skip direct deletion, PNG rewriting, and session deletion for that source, asking the user to close the relevant program and retry. Analysis remains available. The initial macOS process and open-file checks require actual validation. cc-clean's own lock cannot replace client checks, and the tool must not terminate user processes. Stop subsequent mutations if external writes are detected again during execution.

Allow only one cc-clean mutation task at a time, using a lock file in the tool directory. Read-only analysis may run concurrently, but label its snapshot as potentially affected by cleanup. Execution path checks must resist symlink replacement and path traversal; string-prefix matching alone is insufficient.

Keep all staging files under `~/.config/cc-clean/providers/<provider>/work/<operation-id>/`. Atomic replacement requires the source and staging files to share a filesystem. Otherwise skip the file mutation with an explanation instead of performing a non-atomic cross-filesystem overwrite. Check available workspace before large-file operations.

For direct deletion, first move the target into the working directory, record its state, then permanently remove it. Moving alone does not count as freeing space. For PNGs, complete compression and equivalence validation first, retain an original copy during the transaction, then replace atomically. Delete transaction copies after persisting the success receipt. The initial release keeps no long-term backups and offers no undo. Pending transaction copies prevent the operation from contributing to verified savings.

Official Codex deletion uses a separate subprocess path. Do not pretend that moving a few files can roll back the entire database operation. Record complete intent and a before snapshot before execution, then record the result afterward. If the subprocess times out, terminate the process launched by this tool, retain a needs-review state, and inspect the outcome before deciding the result. Never blindly repeat deletion.

Records use `prepared → applied → finalized` states. Write intent and flush it to disk before mutation; save completion records through temporary files and atomic rename. At startup, reconcile unfinished tasks: staged deletion targets can be restored to their original paths; replaced PNGs are identified by before/after hashes; native deletion is checked against targets and indexes. Mark operations with insufficient evidence as needs-review, without inventing success or counting savings twice.

Ctrl+C stops taking new tasks, attempts to finish the current file safely, and saves partial results. Unexpected termination uses the same recovery mechanism. Default tool-directory permissions are `0700`, with `0600` for sensitive state files. Logs must not contain conversations, credentials, or complete native-command output.

## 8. Cleanup history and storage savings

Statistics are based only on actual cleanup executions recorded in `~/.config/cc-clean/cleanup.jsonl`. Opening the app, analysis, previews and cancelled confirmations do not create history. Without cleanup history, totals are zero. Application caches, receipts and transaction files are not subtracted from savings.

Each provider execution records one JSONL entry:

```text
schemaVersion: 1
operationId / provider / root / source: clean | analyze
startedAt / finishedAt
status: completed | partial | failed | interrupted | needs-review
beforeBytes / afterBytes / savedBytes
cleanedRecords
cleanupTypes[]: type, cleanedRecords
needsReview
```

`startedAt` is the execution start time after confirmation, not the preview time. `beforeBytes` and `afterBytes` measure the source directory's logical bytes; `savedBytes` is their difference. Completed session deletions count sessions, including descendants; file deletion and PNG compression count files. Skipped and failed actions do not count. Cleanup types are `delete-sessions`, `delete-files` and `compress-png`. An execution with no eligible actions records zero changes.

Statistics sum verified history entries and display cleaned record counts, operation counts and operations needing review. They do not infer savings from unrelated changes between app launches. Concurrent source-directory writes can affect an execution's measured difference, including making it negative. Logical bytes do not represent physical free space on APFS or other filesystems.

Safety receipts remain separate in `providers/<provider>/operations/<id>.json`, retaining action paths, fingerprints and `prepared → applied → finalized` recovery state. Their `confirmedReductionBytes` sums verified per-action reductions. A normally finished operation records its measured end snapshot. An interrupted operation never reaches that scan and a later scan would count unrelated writes, so its receipt keeps `rootAfterBytes` null and the history entry derives `afterBytes` as `beforeBytes − confirmedReductionBytes` once attribution is complete. Unfinished actions, incomplete attribution or a missing before snapshot mark the history entry for review and exclude it from totals.

JSONL writes use the mutation lock and atomic replacement. Recovery updates the same operation ID without adding duplicate credit. Existing receipts without an execution timestamp do not generate retrospective history. Logs contain no message bodies or credentials.

## 9. File layout and technology choices

```text
~/.config/cc-clean/
  config.json
  cleanup.jsonl              Measured cleanup history
  mutation.lock
  providers/
    claude/
      cache/                  Evictable analysis summaries
      operations/<id>.json     Execution intent and final receipts
      work/<id>/              Staging and original copies during transactions only
    codex/
      cache/
      operations/<id>.json
      work/<id>/
```

Create directories only when first needed. Source discovery precedence: explicit tool configuration → `CLAUDE_CONFIG_DIR` / `CODEX_HOME` → `~/.claude` / `~/.codex`. In the initial release, `config.json` needs only source-directory overrides. Do not add a plugin system, dynamic script rules, or a complex settings page. Keep tool state at the user-specified `~/.config/cc-clean`; do not relocate it based on XDG environment variables.

Suggested minimal code structure:

```text
src/
  cli.ts                     Arguments and command routing
  ui.ts                      Menus, lists, and reports
  scan.ts                    File inventory and summary cache
  providers/claude.ts         Claude classification, parsing, and session-deletion rules
  providers/codex.ts          Codex classification, indexes, and official deletion calls
  clean.ts                   Planning, execution, protection, and recovery
  png.ts                     PNG lossless recompression within a limited scope
  stats.ts                   Ledger and statistics definitions
test/fixtures/               Synthetic and sanitized format samples
```

Use a small provider contract: discover roots, classify files, parse sessions, list supported actions, and generate mutation plans. A shared executor handles safety checks and accounting, while adapters handle format differences. Do not design a framework for installable third-party plugins.

Suggested dependencies: [`@inquirer/prompts`](https://github.com/SBoudrias/Inquirer.js) for selection, multi-selection, search, and confirmation; Node's built-in `parseArgs` for arguments; Node built-ins for files, streams, compression, hashing, and tests. First evaluate Node 24's built-in read-only SQLite support instead of requiring users to install the sqlite3 command. Do not use sharp for PNGs in the initial release: its normal encoding path involves bit-depth/color handling, and the scope of `keepMetadata()` does not guarantee byte-for-byte preservation of arbitrary PNG chunks. See the [Sharp output documentation](https://sharp.pixelplumbing.com/api-output/).

Compile TypeScript to JavaScript for distribution, with a Node shebang on the entry point. Declare `bin: { "cc-clean": "dist/cli.js" }`, the required Node version, and a published-file allowlist in `package.json`. Users must not need a local build after installation. Do not run post-install scanning or cleanup scripts. See the [npm exec documentation](https://docs.npmjs.com/cli/v11/commands/npm-exec/) for `npx` cache behavior.

Use macOS as the initial local acceptance platform. On other systems without verified activity detection and file-replacement guarantees, allow only analysis or explicitly reject mutations. Node's ability to run on a system does not establish cleanup compatibility.

## 10. Implementation order and acceptance

Implement in independently verifiable steps, preserving consistent data definitions throughout:

1. **Read-only analysis:** directory classification, total reconciliation, project/session identification, usage and field reports, hierarchical menus, and direct commands.
2. **Mutation and statistics foundation:** plans, protection checks, receipts, recovery, and dry-run. Exercise simulated accounting through both entry points at this stage instead of adding statistics to a button at the end.
3. **Default cleanup:** verified 72-hour temporary-file rules, standalone lossless PNG recompression, and result reports.
4. **Deletion from analysis:** Claude session groups and an adapter for official Codex commands. Verify actual cascade scope in isolation before enabling real operations.
5. **Package verification:** install a packed tarball from a temporary directory and test the same command entry point users will receive after publication, without publishing to npm.

Required acceptance cases:

- Handle the temporary-file 72-hour boundary, invalid final files, active writes, symlink targets, hard links, and overlapping directories according to the rules.
- Degrade gracefully and report coverage for large sessions, unknown record types, oversized lines, incomplete final lines, missing cwd, missing/stale indexes, read-only WAL, and permission errors.
- Reconcile project, category, and source totals. Do not allocate shared databases twice or double-count cumulative/duplicate usage.
- PNG tests cover transparency, metadata, bit depth, corrupt CRCs, APNG, already well-compressed files, and resource limits. Replace only when decompressed scanline hashes are unchanged and output is actually smaller.
- The same target must produce consistent execution and accounting through `clean` and analysis cleanup. Do not count concurrent external writes as this tool's savings.
- Simulate interruptions during staging, replacement, native-command return, receipt writes, and copy removal. After restart, preserve originals and prevent duplicate counting; leave uncertain outcomes marked for review.
- Use synthetic/sanitized copies for all tests that alter formats. Claude / Codex session-deletion compatibility tests use isolated data roots and disposable sessions, never probes against the user's existing history.
- For the current local versions, verify post-deletion lists, continued reading of remaining sessions, and associated-resource boundaries. Successful `--help` output alone does not prove deletion compatibility.
- Package verification uses the local tarball produced by `npm pack`, for example `npm exec --package=/absolute/path/cc-clean-<version>.tgz -- cc-clean --help`. Do not invoke the unpublished public package name prematurely.

The only content-compaction rules still awaiting product decisions are **which session fields may be discarded and whether lossy image compression is acceptable**. The initial release preserves all fields without explicit removal rules and performs no lossy compression. These decisions do not block the features already defined above.
