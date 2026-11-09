# Usage and reference

See the [README](../README.md) for a quick start. Run the local commands below from the repository root.

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

See [Publishing to npm](publishing.md) for release checks, authentication and publishing.

`npm test` includes cleanup and native deletion tests against disposable fixtures. Agents must not run that suite or cleanup commands, including previews, without an explicit user request; see [AGENTS.md](../AGENTS.md). `test:read-only` excludes cleanup planning/execution, file compression and native deletion. It includes synthetic in-memory history and SQLite transforms, inert plan rendering, and temporary layout/receipt fixtures; it does not rewrite user history or invoke native clients.

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
- Cleanup: `receipts` with actions, skips, before/after bytes and confirmed reductions. Each action can include `estimatedSavingsBytes` (`null` when unknown); this estimate is separate from measured savings and may be absent in older receipts. `slim-history` actions also include `slimOptions: { removeImages, compactTools, removeReasoning?, removeRequestArchives?, compactHooks?, compactToolDefinitions?, compactSkillListings?, removeOldSnapshots? }`, `slimCounts: { images, toolOutputs, reasoning?, requestRecords?, hooks?, toolDefinitions?, skillListings?, oldSnapshots? }` and optional `slimSavingsBytes` with the same category keys as `slimCounts`. The category byte estimates add up to `estimatedSavingsBytes`; older receipts may lack this breakdown or optional category fields. Pending Codex rewrites require `codexProjection` receipts for every known history database; an empty array records that no such databases were found. Optional `explicitTarget` records the one user-selected file path or session ID for the age exception below; automatic and multiple selections omit it.
- Duplicate history cleanup: `kind: "deduplicate-history"` actions contain exactly two ordered `files`: the plaintext to remove, then the compressed copy to keep. `beforeHash` binds plaintext/decoded bytes; `afterHash` binds stored compressed bytes. `codexProjection` is mandatory, with unchanged before/after index hashes. `estimatedSavingsBytes` is the plaintext size; the retained compressed file is not counted as removed.
- Coordinated Codex hardlinks: slimming and duplicate actions can include `codexShared`. Its `homes` records every discovered supported home with root identity and its own mandatory `codexProjection` array; `groups` lists all aliases for each canonical entry in `files`; `compressedLinks` lists missing compressed siblings to create before removing plaintext aliases. The primary home's projection matches the action's `codexProjection`. Recovery journals `started` and, for slimming, `outputIdentity`. Savings count each physical original once, regardless of its number of paths.
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

# Clean verified temporary outputs only, excluding history changes and PNG compression.
node src/cli.ts clean --temp-only --provider all --yes --json

# Compress one eligible PNG, using a canonical absolute path from the report/preview.
node src/cli.ts clean --provider codex --file /absolute/.codex/generated_images/example.png --yes --json

# Delete explicit sessions; replace the sample UUID with one from analysis.
node src/cli.ts analyze delete --provider claude --session 12345678-1234-1234-1234-123456789abc --dry-run --json

# Permanently delete an eligible file, including a PNG.
node src/cli.ts analyze delete --provider codex --file /absolute/.codex/generated_images/example.png --yes --json
```

Repeat `--session` or `--file` to select multiple targets. Explicit selections require one provider; session and file selections cannot be mixed. File selections remain subject to the same eligibility rules as the menu, and an ineligible selection fails before execution. Session deletion previews include verified descendants.

Cleanup starts with a storage scan and session inspection; temporary-only mode reads creation evidence without computing deep usage analysis. Interactive cleanup, including Quick clean, Clean temporary files, Slim history, selected files, session deletion and terminal commands with `--yes`, summarizes operations, counts and estimated savings by category before asking for confirmation. The review focuses on estimated savings and a brief irreversible-change notice. **More** expands protection rules, detailed effects and scan notes, with **View files** for full target paths and per-file estimates; **Less** collapses them again. JSON output also retains these details. Press **Enter** on **Confirm cleanup** to start the summarized operations automatically; **Q / Esc** cancels. No source files are changed before confirmation. Cancelling a scan cancels the request. Noninteractive and JSON commands never prompt and still require explicit `--yes` for mutation. Deletion and history slimming are permanent; this tool does not offer undo.

Under **More**, repeated scan notes are grouped into up to five types. **View scan notes** opens all original paths and reasons; returning to review still requires Enter to confirm cleanup. JSON output retains every note. Noninteractive text reports include these explanations without folding.

Deletion estimates use the selected files' logical sizes. PNG estimates recompress verified source data in memory without replacing files. Failed estimates remain unknown instead of counting as zero. Estimates may differ from actual directory changes, especially when safety checks skip changed or active files. Actual savings are measured around execution.

### 72-hour protection

Quick clean, automatic selection and bulk operations only delete or irreversibly change files whose **last modification time is more than 72 hours ago**. This includes temporary files, duplicate history-copy removal, generated-image deletion, session deletion, inline-image removal, shell-output compaction, Codex encrypted-reasoning and old-compaction-snapshot removal, and Claude request-archive removal, successful-hook compaction, tool-definition compaction and skill-listing compaction. Session creation time does not determine eligibility. Recent files, files exactly 72 hours old, future timestamps and invalid timestamps are retained, with reasons shown and no estimated savings credited. Execution rechecks age and file identity before mutation.

Only explicitly selecting **one file or one session without descendants** can bypass the age limit. Multiple selections, choosing a provider, `--yes`, or a scan finding only one candidate do not bypass it. A session deletion that includes descendants is protected as a group: any recent file retains the whole action. Other checks and confirmation still apply to a single target.

Lossless PNG recompression that preserves image content and supported metadata is exempt from the age limit.

### Slim history

**Clean → Quick clean** includes image removal and shell-output compaction for Claude Code and Codex, plus encrypted-reasoning and old-compaction-snapshot removal for Codex and request-archive removal, successful-hook compaction, tool-definition compaction and skill-listing compaction for Claude, alongside temporary-file cleanup, identical Codex history-copy removal (keep zstd) and lossless PNG compression. Its preview combines all selected providers and temporary directories into one summary: inline-image removal, shell-output compaction, Codex encrypted-reasoning removal, Codex old-compaction-snapshot removal, Claude request-archive removal, Claude successful-hook compaction, Claude tool-definition compaction, Claude skill-listing compaction, duplicate-original removal, lossless PNG compression and each temporary-file operation show their own counts and estimated savings, followed by one total. Each byte is counted once; unknown estimates remain marked as unknown. The preview explains irreversible effects, then waits for Enter. **View files** opens a compact directory tree with estimated savings aligned on the right. Folders and files are ordered by known savings, largest first; unknown estimates stay explicit. Expand a folder with **→ / Enter**, then press **Enter** on a file to see full paths, source size and the operation breakdown. The list shows short session IDs and only applicable, nonzero cleanup counts; **Q / Esc** returns to the list or review. Unsupported histories are retained with an explanation; independently eligible histories, temporary files and PNGs can still be listed.

To choose history operations individually, open **Clean → Slim history**, choose Claude Code, Codex or both, then enable the desired operations. All options start unchecked in this standalone flow, which only slims history; encrypted-reasoning and old-compaction-snapshot removal appear when Codex is selected, and request-archive removal, successful-hook compaction, tool-definition compaction and skill-listing compaction appear when Claude is selected. Both bulk flows only change history files last modified more than 72 hours ago; an explicit single-file CLI operation can use the age exception above. CLI `clean` continues to require explicit `--remove-images` / `--compact-tools` / `--remove-reasoning` / `--remove-request-archives` / `--compact-hooks` / `--compact-tool-definitions` / `--compact-skill-listings` / `--remove-old-snapshots` flags for history slimming; these flags select history operations only.

| Option | Effect |
| --- | --- |
| **Remove inline images** / `--remove-images` | Replace recognized Base64 image content blocks with a text block containing `[image removed]`. Remove recognized duplicate inline images from Codex UI events while keeping image hints and ordering aligned. |
| **Compact shell output** / `--compact-tools` | Apply the ported RTK filters to recognized, completed, successful shell output. Keep tool-call IDs and execution metadata, and mark omitted content as unavailable. |
| **Remove encrypted reasoning (Codex)** / `--remove-reasoning` | Remove nonempty string `encrypted_content` fields only from direct `response_item` reasoning records. Preserve visible summaries, content, IDs, signatures and all other bytes. Compaction ciphertext and nested replacement history remain intact. |
| **Remove old compaction snapshots (Codex)** / `--remove-old-snapshots` | Remove `replacement_history` and paired `replacement_history_metadata` only from snapshots preceding the latest complete checkpoint. Preserve that latest row verbatim, all summaries, ordinary messages and usage. Unknown compactions, an incomplete latest checkpoint or rollback records retain the file. |
| **Remove API request archives (Claude)** / `--remove-request-archives` | Remove recognized `api-request`, `api-request-shape` and `api-request-blob` records together, when independent conversation records exist. Unknown archive types or fields retain the entire archive family. Visible conversation and cost records remain unchanged. |
| **Compact successful hooks (Claude)** / `--compact-hooks` | Clear `command`, `content`, `stdout`, `stderr` and recorded `rendered` content on recognized `hook_success` attachments with exit code zero. Preserve the row, UUID/parent links, timestamps, hook identity and status. This operation leaves failed or unknown hooks, prompt snapshots, instructions and skill listings intact. |
| **Compact tool definitions (Claude)** / `--compact-tool-definitions` | Clear `tools` on recognized `prompt_snapshot` attachments. Preserve system prompts, the snapshot record and all actual tool calls/results. Unknown snapshot or tool-definition shapes remain intact. |
| **Compact skill listings (Claude)** / `--compact-skill-listings` | Clear `content` and recorded `rendered` listings on recognized `skill_listing` attachments. Reset `names` to `[]` and `skillCount` to `0` so historical discovery state does not suppress current skills. Preserve row identities, links and `isInitial`; unknown shapes remain intact. |

The preview summarizes enabled operations, stored image copies removed, tool outputs compacted, reasoning blocks removed, request records removed, successful hooks compacted, tool definitions removed, skill listing records compacted, old snapshots removed and exact estimated byte reductions. Full file paths are available in **View files** and JSON. Image and tool-definition counts include stored copies, not unique images or tools; skill counts refer to listing records. Estimation transforms data in memory; execution repeats the transform and requires matching source/result hashes before atomic replacement. No-saving files are omitted; unsupported files are retained with warnings.

The following are examples to run **only when explicitly requested**:

```sh
# Preview all history operations for both providers; does not modify history.
node src/cli.ts clean --provider all --remove-images --compact-tools --remove-reasoning --remove-request-archives --compact-hooks --compact-tool-definitions --compact-skill-listings --remove-old-snapshots --dry-run --json

# Interactively review and press Enter to remove inline images.
node src/cli.ts clean --provider claude --remove-images

# Explicit noninteractive compaction of one selected history file.
node src/cli.ts clean --provider codex --file /absolute/.codex/sessions/example.jsonl --compact-tools --yes --json
```

History slimming recognizes **Claude Code transcripts and independent Codex plain legacy and paginated rollouts**, independently of client version numbers. Old, new, custom, missing or mixed version fields do not by themselves block an operation; existing version fields are preserved. Only the recognized records and fields described above are changed; human/assistant text, usage/cost records, message identities and unrelated prompt attachments remain intact. The current in-memory transformer is limited to **64 MiB per file**; larger files need a streaming implementation.

Codex checks **every current and archived session header**, including compressed `.jsonl.zst` files, for ownership and inbound references. For the current user's `~/.codex`, Orca runtime home and UUID account homes, this check covers all discovered homes. Fully accounted hardlinks at the same relative path can be slimmed together: every alias receives the same replacement inode, and every home's known SQLite offsets and caches are synchronized. All aliases must be older than 72 hours, even with an explicit file selection, and activity checks cover every home. Independent plain histories can also be rewritten alongside unrelated compressed or hardlinked histories. Compressed targets, actual cross-rollout references, forked/imported/attached histories, independent identity copies, symbolic links and unaccounted hardlinks remain protected. An incomplete scan or unreadable reference header still prevents history rewriting because dependencies cannot be established.

For paginated and materialized history, cc-clean updates known SQLite byte offsets and cached items with the JSONL rewrite, preserving record order, ordinals and identities. It checks database identities, schemas and target rows against the preview, and retains the temporary original until index updates are verified. Interrupted operations can finish pending index updates from that original; conflicting changes remain pending for review. Every Codex history rewrite must carry an index synchronization receipt, including an explicit empty list when no history databases exist. Execution and recovery reject missing receipts; generic delete/compress actions cannot modify Codex session files. Unknown offset schemas are retained rather than rewritten without index support. Content-only rewrites preserve identity, path and timestamp metadata in the state database; whole-session deletion uses the native adapter to coordinate its other indexes and auxiliary records.

Codex configuration is parsed as TOML. Quoted or escaped keys, ordinary strings and comments are accepted. A `sqlite_home` or `CODEX_SQLITE_HOME` pointing to the scanned root is accepted; a database outside that root cannot be verified. Configuration takes precedence over the environment. Invalid, changed or linked configuration, a relative environment path with unknown native working directory, and files exceeding the **64 KiB configuration inspection bound** are retained with an explanation.

Image removal handles Claude message and nested tool-result image blocks, Codex top-level response-message `input_image` data URLs, known Codex user-message UI image arrays, and paginated canonical/cache user-message items. Remote URLs, local image paths, standalone generated image files, arbitrary Base64 text, visible reasoning summaries/content, signatures and unknown image shapes stay intact. Image, shell-output and reasoning operations do not rewrite nested Codex replacement histories. The separate old-snapshot operation removes only superseded history/metadata pairs and leaves the latest complete checkpoint unchanged.

The RTK subset covers numbered `rg`/`grep` matches, `rg --files`/`find`/`fd` listings, recognized successful `cargo test` output and all-passed `pytest` output. Search output keeps up to 10 matches per file; listings keep up to 20 directories and 10 files per directory. Test output retains summaries. Claude requires a paired `Bash` result explicitly marked successful; Codex requires a paired `exec_command` or `shell_command` result with a recognized successful completion envelope, or a completed canonical/cache command-execution item with exit code zero. Shell pipelines, compound commands, JavaScript `functions.exec` wrappers, failures, warnings, terminal controls and unrecognized output stay intact. Historical commands are never executed.

**Loss is permanent:** removed images, command output, encrypted reasoning, API request archives, successful-hook commands/output/context, historical tool definitions, skill listings and old compaction snapshots cannot be recovered from cc-clean. Hook, tool-definition and skill-listing compaction can change resumed context and increase continuation cost; exact historical request reconstruction is lost. This policy prioritizes continuing a conversation and retaining its visible text and usage over reproducing the original environment. Old-snapshot removal preserves continuation from the latest checkpoint in the documented Codex 0.167.0 synthetic native experiment; forks or rollbacks to earlier positions can lose their original context. The endpoint was mocked, so real-model quality and provider acceptance were not tested. Temporary recovery originals are removed after successful finalization. A prior Codex 0.167.0 experiment successfully resumed and continued one copied real session after removing its reasoning ciphertext, using freshly rebuilt indexes. Existing-index rewrites have synthetic SQLite coverage only; this does not establish compatibility for complex sessions or all models. One copied Claude transcript also continued after request-archive removal, and after separately clearing hook commands or hook output/context. A second copied transcript continued and called Read after clearing hook commands and output together with recorded tool definitions and skill descriptions. Tool/skill slimming is now enabled by default in Quick clean. Skill-listing compaction also resets historical advertised names/count, which restored automatic discovery and invocation of a synthetic skill in an additional native experiment. Evidence is limited to the documented transcripts and client setup; all tools, MCP/plugin skills and versions have not been verified. See [compatibility limits](native-compatibility.md#history-slimming-synthetic-checks-and-limited-native-resume), [Claude archive/hook evidence](native-compatibility.md#claude-request-archives-and-hooks-limited-native-continuation-evidence) [old-snapshot evidence](native-compatibility.md#older-compaction-snapshots-limited-native-continuation-evidence) and [tool/skill evidence](native-compatibility.md#claude-tool-and-skill-snapshots-limited-native-continuation-evidence).

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

| Feature | Supported scope |
| --- | --- |
| Temporary files | Codex root files named `..codex-global-state.json.tmp-*`, with a valid final state file; known Claude/Codex system layouts; and text outputs with verified session creation evidence, as described below. Independent of CLI version; system temporary files always require more than 72 hours |
| PNG compression | Eligible static PNGs in Codex `generated_images/`; recompress IDAT losslessly, preserving inflated scanlines and supported metadata; replace only when smaller |
| Claude session deletion | Structurally complete transcripts and verifiably owned subagent/tool-result files, independent of version; retain memory, configuration, file-history and history.jsonl |
| Codex session deletion | Official `codex delete` with capability checks instead of a version whitelist; verify full spawn descendant scope, ownership and references. Reject incomplete indexes, attached relationships and unpreviewed target copies; unrelated compressed/hardlinked histories are allowed. Native evidence remains limited to **0.167.0** |
| History slimming | Included in Quick clean, individually selectable in Slim history or via CLI flags; recognized inline images and RTK shell-output compaction for Claude transcripts and independent Codex plain legacy/paginated history, plus Claude request-archive removal and successful-hook compaction, and Codex encrypted-reasoning removal with mandatory SQLite index/cache coordination; irreversible, with limited native reasoning-resume evidence ([evidence](native-compatibility.md#history-slimming-synthetic-checks-and-limited-native-resume)) |
| Platforms | Mutations on macOS after checks; analysis, previews and statistics on other platforms |

Claude Quick clean includes history slimming and known system temporary files; standalone-image deletion is not supported. Zero candidates means no files both pass the age/compatibility checks and contain reducible content. When history slimming is not enabled, the empty-result menu links to **Slim history**. Scan notes explain retained files and unsupported formats. A directory called `.tmp` or `cache` is not automatically disposable: installed plugins may still reference its resources through links.

Open Claude sessions, their subagents/tool results and resume/fork sources are protected when live processes can be matched to native session registrations. Unrelated closed sessions can remain eligible while Claude runs. Missing or uncertain ownership retains the provider's candidates; Codex still requires its clients and services to be closed. Open files, incomplete scans, uncertain references and changed files also block affected operations. A computer restart is not required. Live analysis is a snapshot that may change. Session deletion currently requires complete deep analysis of the provider; an unrelated malformed or oversized transcript can also block deletion.

PNG compression excludes APNG, unknown/unsupported chunks, damaged images, extended attributes, JPEG/WebP and Base64 images. History slimming handles supported Base64 images separately. Direct file transactions require the source and application work directory on the same filesystem. See [native compatibility evidence](native-compatibility.md) for capability checks and validation limits.

### System temporary files

Quick clean and ordinary CLI `clean` also inspect `/tmp`, `/var/tmp`, the operating system's user temp directory (`os.tmpdir()`, typically `/var/folders/.../T` on macOS), `$TMPDIR`, `$TMP`, `$TEMP`, and Claude's `$CLAUDE_CODE_TMPDIR` when set. Paths are canonicalized and deduplicated (`/tmp` is commonly `/private/tmp` on macOS). Provider roots and cc-clean state are excluded from these scans. **Clean → Clean temporary files** and CLI `clean --temp-only` select temporary cleanup without history slimming, duplicate removal or PNG compression. `--temp-only` cannot be combined with explicit targets or history-slimming flags. Explicit file/session operations and history-only CLI flags do not add system-temp targets.

Only these relative layouts are eligible, where `<uid>` is the current user ID:

| Provider | File layout | Category |
| --- | --- | --- |
| Claude Code | `claude-<uid>/<project>/tasks/<id>.output` and legacy `claude/<project>/tasks/<id>.output` | Temporary task outputs |
| Claude Code | `claude-<4 lowercase hex>-cwd` and `claude-<uid>/cwd-<lowercase hex>` | Temporary working-directory records |
| Codex | `hook_outputs/<UUID>/<UUID>.txt` | Temporary full hook outputs |
| Codex | `codex-app-installer-<suffix>/Codex.dmg` | Leftover desktop installers |

Only regular files owned by the current user, without hard links or group/world write access, qualify. Nested directories must also have safe ownership and permissions. Symlinks are not followed; discovered inbound links retain their targets. Arbitrary scratchpad files, source, images, lock files, sockets, daemon data and other cache contents are retained. Directories are never removed wholesale. References elsewhere on the machine are not exhaustively scanned: old task/hook outputs can still be referenced by a saved conversation, and those full outputs become unavailable after deletion.

Session-created outputs add a separate category. Complete Claude/Codex histories are inspected for successful `mktemp -d` commands, simple Python `tempfile.mkdtemp()` allocation-and-print scripts, bounded `mkdir` commands, and completed Codex file additions inside standard system temp paths. For `mktemp` and Python, the expanded path printed by the command supplies the historical location, including custom temp roots and `$TMPDIR` / `${TMPDIR}` variants. For `mkdir`, literal paths and variables assigned earlier in the same command identify directories under standard system temp roots. The current environment is never substituted into old commands. Directory birth time must match the creation event, and its identity is checked again before use. A path mentioned in chat, a failed command, a background-start/interrupted result, or an arbitrary provider-like prefix is not creation evidence.

Within a verified directory, only `.md`, `.txt`, `.log`, `.csv`, `.tsv`, `.out` and `.output` files qualify. Source repositories (including Git worktrees), source/config/scratchpad directories, hidden files, README/AGENTS/license files, code, JSON and images are retained. Recognized project manifests (including Node, Cargo, Python, Go, CMake and Gradle manifests) also protect exported source trees without version-control metadata. References from another history file in either configured provider retain the scope, including variable paths and conservative basename matches. Missing, compressed, malformed or changing history evidence prevents session-output cleanup. Both providers' activity checks must pass even when cleaning only one provider.

Discovery cannot enumerate every possible temporary path or establish ownership from arbitrary scripts. `mkdir` support reads only a bounded command prefix: literal temporary-path assignments, absolute `cd`, temporary-path `rm -rf` / `rm -fr`, and `mkdir` / `/bin/mkdir` with optional `-p` and `--`, separated by `&&`, semicolons or newlines. For example, `E=/tmp/session-export && mkdir -p "$E" && git archive ...` can establish creation of `/tmp/session-export`. Unknown syntax stops recognition; unresolved variables, conditional blocks and shell substitutions are not interpreted. Python support is intentionally limited to imports of `tempfile` / `pathlib` / `os`, one `mkdtemp` assignment, optional `pathlib.Path` and `os.chmod(..., 0o700)`, and a final `print` of that variable. Python scripts that also write files, run subprocesses, or reassign variables are retained. Other command forms and external references outside the configured histories are not exhaustively tracked.

Every system-temp candidate must have `mtime` strictly more than 72 hours old, with no single-target exception. Quick clean shows category counts, estimated savings and the irreversible effect before requiring Enter. Execution rechecks ownership, paths, file identity, age, processes and open files, and uses the existing transaction/recovery mechanism. Files on another filesystem from cc-clean's state directory are skipped.

## Accounting and recovery

Statistics come only from `~/.config/cc-clean/cleanup.jsonl`. An actual cleanup execution records one line per provider/root scope, using its logical size immediately before and after execution. System-temp entries have `scope: "system-temp"` and count only matched eligible-layout files, not the entire shared temp directory; the UI labels these measurements **Matched temp files**. Opening the app, analysis, previews and cancelled confirmations do not create cleanup history. An executed cleanup with no eligible items records zero changes. Without history, savings and cleaned records are both zero. Application caches, receipts and work files are not subtracted from savings.

Each line is a JSON object, for example:

```json
{"schemaVersion":1,"operationId":"12345678-1234-1234-1234-123456789abc","provider":"claude","root":"/Users/example/.claude","source":"analyze","startedAt":"2026-11-08T10:00:00.000Z","finishedAt":"2026-11-08T10:00:02.000Z","status":"completed","beforeBytes":10485760,"afterBytes":8388608,"savedBytes":2097152,"cleanedRecords":2,"cleanupTypes":[{"type":"delete-sessions","cleanedRecords":2}],"needsReview":false}
```

- **Times and sizes:** `startedAt` is the execution start, after confirmation; `finishedAt` is its end. `savedBytes` equals `beforeBytes - afterBytes`.
- **Records and types:** count only completed, finalized actions. `delete-sessions` counts sessions including deleted descendants; `delete-files`, `compress-png` and `slim-history` count files. `deduplicate-history` counts only the removed plaintext, not its retained compressed sibling. Slimming and duplicate removal do not count as deleting a session. `cleanupTypes` groups the counts, whose sum is `cleanedRecords`. Skipped and failed items do not count.
- **Totals:** sum verified history entries, separately for Claude and Codex. Incomplete measurements use `null` and set `needsReview`; those operations are excluded from totals. Recovery updates the same operation ID without double counting.

Hard links count once. These are logical bytes, not physical free space on APFS or another filesystem. Native startup files or concurrent writes inside the source directory can affect the measured difference, including making it negative. The receipt's `confirmedReductionBytes` remains a separate action-level diagnostic; it is not the statistics total.

Quick clean and analysis-driven cleanup share one executor. Detailed receipts remain alongside the JSONL history for safe recovery. Before the next mutation, unfinished direct-file transactions are reconciled. A delayed recovery cannot reconstruct the original after-size, so it records an unknown measurement rather than crediting a later scan. Uncertain native deletions remain `needs-review`, receive no savings credit, are not automatically retried, and block new mutations for that provider. Inspect `stats --json`; removing receipts is not a recovery procedure. Whole-machine power-loss recovery is unverified.

Metadata analysis reads bounded record prefixes; usage and field analysis parse deeply on request. Missing, oversized, damaged, forked or imported data can produce partial or unknown usage, which is not a complete bill. Deleting sessions changes current usage reports while preserving historical cleanup savings.

Codex analysis reads both `.jsonl` and `.jsonl.zst` in `sessions` and `archived_sessions`, streaming compressed histories without materializing an uncompressed file. Storage totals and read progress use on-disk file sizes; record, field and embedded-image sizes use decoded content and are not estimates of reclaimable disk space. Metadata sampling is limited to the first 1 MiB of decoded content.

When same-basename plain and compressed histories coexist, analysis prefers the plain file for usage and counts both files toward storage. The compressed sibling is not assumed identical: the session remains incomplete for cleanup checks. Analysis does not rewrite, compress or deduplicate histories; the separate cleanup check below verifies equality before offering duplicate removal. Codex's normal native compression removes the plain original after publishing the compressed file; continuing a session with writes materializes the plain file and removes the compressed one. See [compatibility evidence and limits](native-compatibility.md#codex-compressed-history-read-support).

## Remove duplicate Codex originals

Ordinary Codex `clean` and **Quick clean** include **Remove duplicate originals (keep zstd)**. Only same-basename pairs in `sessions/` or `archived_sessions/` qualify: the entire `.jsonl.zst` stream, including every concatenated frame, must decompress to exactly the `.jsonl` bytes. The plain original is removed and the compressed file remains unchanged, retaining all conversation text, usage and context. This does not generate new compressed files. Temporary-only cleanup and standalone **Slim history** / history-only CLI flags exclude this operation.

Both files and all their aliases must have been last modified **more than 72 hours ago**, even when the plain original is explicitly selected. Fully accounted hardlinks across the supported Codex/Orca homes are coordinated: missing same-basename compressed siblings are linked to the verified compressed inode before any plaintext alias is removed. Existing compressed bytes remain unchanged. Active or uncertain sessions in any home, unaccounted links, symbolic links, additional independent copies claiming the same identity, cross-rollout references, damaged compression and unknown index dependencies are retained. Each stored file and the decoded history are limited to 64 MiB. The summary counts one physical original per pair and only its size as estimated savings; **View files** identifies every removed and retained alias, coordinated home and compressed link to create.

Execution rechecks equality, hashes, file identity, age and activity, and uses the existing Codex index transactions and interruption recovery. Index offsets and cached text remain unchanged because decoded history bytes do not change. No undo copy remains after success. Validation uses synthetic byte/layout/SQLite/receipt tests; actual cleanup and native continuation were not exercised for this feature. See [duplicate cleanup evidence and limits](native-compatibility.md#codex-duplicate-history-cleanup).

## Third-party attribution

Shell-output compaction contains modified TypeScript ports of selected [RTK CLI](https://github.com/rtk-ai/rtk) filters, copyright **2026 RTK AI Labs**, licensed under **Apache License 2.0**. The pinned upstream revision is [`653efb6ed02bd287d686c50e830dd1009356904f`](https://github.com/rtk-ai/rtk/tree/653efb6ed02bd287d686c50e830dd1009356904f). Only the Apache-2.0 CLI `src/` code is used; RTK's BUSL-1.1 engine/proxy code is not included.

See the distributed [Apache-2.0 license](../third_party/rtk/LICENSE) and [source/function mapping and modifications](../third_party/rtk/UPSTREAM.md). This port implements the subset described above, not all RTK filters or its runtime.
