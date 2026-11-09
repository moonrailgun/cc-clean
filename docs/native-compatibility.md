# Native compatibility evidence

Validated on 2026-11-08, macOS 15.7.4 arm64, with Codex CLI **0.167.0** and Claude Code **2.1.319**. All mutation probes used disposable synthetic data roots. No existing user session was deleted or rewritten, and no model turn was requested. These are explicit version gates, not claims of forward compatibility.

## History slimming: synthetic checks only

The deletion evidence below does **not** validate resuming rewritten history. `slim-history` accepts recognized Codex record structures; Claude Code remains limited to 2.1.319. In-memory JSONL and SQLite tests cover untouched bytes, image placeholders, successful shell output, byte-offset remapping, cached items, ordinals, commit/rollback, receipt hashes, malformed-input rejection and idempotence. Synthetic filesystem fixtures check plain/zstd headers, ownership and references without invoking the planner, executor or native clients.

No native resume, generated continuation or end-to-end history rewrite probe has been run for this feature. Images and omitted output are permanently lost after a successful operation; transaction recovery is not undo. Keeping identities and signed fields unchanged does not prove native replay compatibility.

Codex supports independent plain legacy and paginated histories. The [history materializer](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/thread-store/src/local/thread_history_materialization.rs) and [turn-position schema](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/state/thread_history_migrations/0003_turn_rollout_positions.sql) persist byte positions. The implementation remaps known `thread_history_projection_state` and `thread_turns` offsets to rewritten UTF-8 line boundaries, and slims recognized canonical event items and `thread_items` / `thread_realtime_items` JSON caches. Ordinals, root-turn IDs and unrelated rows are preserved. Unknown offset schemas or update triggers are rejected; the native delete-only cache cleanup trigger is accepted.

Database identities, schemas and target rows are bound to preview hashes. SQLite write transactions stay open across the atomic JSONL replacement. The original is retained until index commits verify; interruption recovery accepts already-updated indexes and completes pending updates from the verified original. Conflicting state retains the backup for review. This mechanism completes an interrupted operation; it does not provide undo after successful finalization.

All current and archived headers, including `.jsonl.zst`, are inspected for inbound [history-lineage references](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/thread-store/src/local/rollout_lineage.rs). Shared, forked, imported, attached, compressed or hardlinked targets and referenced sources are retained. Unrelated compressed/hardlinked histories no longer block an independent target. Incomplete inventories, unreadable headers and unrecognized reference identities still prevent establishing dependency coverage. Compressed targets are inspected but not rewritten.

Codex configuration is parsed as TOML, including quoted/escaped keys and multiline strings. The root `sqlite_home` takes precedence over trimmed `CODEX_SQLITE_HOME`, matching the [native configuration resolver](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/config/mod.rs). Both can point to the scanned root; external databases are outside the verified inventory. Invalid or changed configuration and relative environment paths with an unknown native working directory cannot establish index coverage. Synthetic tests cover these cases and ensure parser errors do not expose configuration values.

The in-memory history transformer has a 64 MiB per-file resource bound; configuration inspection has a 64 KiB bound. These are implementation limits, not provider-version restrictions. Claude files must have consistent session identity and supported version fields. Compacted replacement histories and unrecognized image shapes are left untouched.

Every pending Codex history rewrite requires a `codexProjection` receipt; an empty array records that no history databases exist. Generic delete/compress actions cannot mutate session files. Execution validates fresh receipts, and recovery verifies the original projection state before restoring files or removing transaction artifacts.

## Codex 0.167.0

`src/codex-delete.ts` invokes `codex delete <uuid> --force` with an argument array. It accepts a full hexadecimal UUID only, verifies the installed version, requires a canonical absolute directory, fixes `CODEX_HOME`, `CODEX_SQLITE_HOME`, `sqlite_home` and `log_dir`, and runs with that directory as its working directory. There is no shell evaluation, session-name lookup, direct SQLite mutation, or fallback that unlinks rollouts after a native failure.

The command is a thin app-server client. In this version, the pinned `sqlite_home` and `log_dir` overrides exclude implicit shared-daemon reuse. The adapter rejects inherited `CODEX_EXEC_SERVER_URL` and `CODEX_EXEC_SERVER_NOISE_*` selection rather than connecting a remote executor. It disables `features.local_thread_store_compression` and `features.background_paginated_rollout_migration` for this invocation, because native startup can otherwise rewrite unrelated rollouts. Configuration may still cause ordinary native startup behavior; this adapter does not promise an entirely network-free child process.

Runtime overrides supersede ordinary system, cloud, user, and project configuration. Legacy managed configuration can override them. The adapter conservatively refuses deletion when `/etc/codex/requirements.toml` or `/etc/codex/managed_config.toml` exists, when their absence cannot be established, or when macOS reports a forced `config_toml_base64` / `requirements_toml_base64` preference for `com.openai.codex`. The macOS check queries only the two CoreFoundation presence flags, without copying, decoding, or displaying configuration values. No management policy is removed or bypassed.

Native startup can write outside the selected rollout. Before launching deletion, the adapter checks the root SQLite files and sidecars, `skills/.system`, `tmp`, `.tmp`, `log`, `logs`, `thread-writer-locks`, `sessions`, `archived_sessions`, `installation_id`, `session_index.jsonl`, and `session_index.jsonl.lock`. Links, special files, and hardlinked regular files in those paths are rejected. The `skills` ancestor is also checked. Ordinary user skill and plugin links outside those paths are allowed. One narrow exception permits native executable aliases at `tmp/arg0-{macos,linux}/codex-arg0*/{apply_patch,applypatch,codex-linux-sandbox}`; those leaf links are not traversed, and native stale-directory cleanup unlinks them. Linked ancestors and lock files remain rejected.

Each child command has a 15-second deadline and a combined 64 KiB output bound. On supported POSIX execution the entire child process group is killed, including a descendant retaining its parent's output pipe. Native stdout/stderr is never included in failure messages. A timeout or error requires reconciliation; it must not trigger an automatic retry or a success receipt.

### Reproducible native integration test

This test executes native deletion against disposable fixtures. Run it only when explicitly requested; development authorization alone does not authorize cleanup tests (see `AGENTS.md`).

```sh
node --disable-warning=ExperimentalWarning --test test/codex-delete.test.ts
```

The installed-CLI test skips when Codex is absent or has another version. It creates five minimal synthetic rollout files: a parent, its child, a grandchild, an archived child, and an unrelated survivor. `codex app-server --listen stdio://` receives only `initialize`, `thread/list`, and `thread/read`; it initializes the synthetic indexes without a model prompt. Read-only SQLite inspection verifies three spawn edges before deletion.

Deleting the parent through the adapter removes the parent, child, grandchild, and archived child JSONL files, their four `threads` rows, and their three `thread_spawn_edges` rows. The unrelated session remains in the native list and its `thread/read` turns are unchanged and nonempty. This proves transitive **spawn** descendants and archived spawn descendants for this fixture. It does not prove that every possible Codex attachment or auxiliary resource is deleted.

A separate synthetic probe with an attached relationship present only in the database found that its row and rollout survived deletion of the parent. Tagged source additionally checks attached relationships in rollout metadata and rejects parent deletion while such attached children exist. Therefore `attached_thread_parent_id` must not be treated as a spawn edge, and absence from `thread/list` alone is insufficient deletion proof. The planner refuses affected attached relationships.

Tagged deletion source removes every discovered rollout for the selected thread IDs, including each plain `.jsonl` and its `.jsonl.zst` sibling. It also removes their materialized `thread_history_1.sqlite` entries, selected agent message boards in `agent_message_board_1.sqlite`, and their `session_index.jsonl` names before the final state-row deletion. External history references are checked before cleanup. The planner conservatively refuses a source containing compressed rollouts because their ownership/content is not part of the current preview; it does not silently add compressed siblings to the deletion set. These auxiliary cleanup details are source evidence, not a claim that arbitrary attachments were exercised by the minimal fixture.

### Shared writes and accounting

Observed native startup writes included `state_5.sqlite`, `goals_1.sqlite`, `logs_2.sqlite`, `memories_1.sqlite`, `queue_1.sqlite`, their SQLite WAL/SHM files, `installation_id`, bundled `skills/.system` files, `tmp/arg0-macos` aliases/locks, `.tmp/plugins.sync.lock`, `.tmp/git-*`, and `thread-writer-locks/.coordination.lock`. Log output is pinned below the selected root. This startup overhead can exceed the bytes removed from a small synthetic conversation. Removing SQLite rows does not imply that the database file shrinks; cc-clean does not run `VACUUM`.

The executor compares complete pre/post root snapshots, includes native-created files as signed overhead, verifies planned rollout absence and index-row absence, and checks for external activity before and after the native command. Selected rollout fingerprints alone do not bind the native deletion set: SQLite/WAL spawn edges can change without those files changing. Planning recomputes each action's exact spawn closure from the freshly read index, checks files and parent/archive relationships against analysis, and execution repeats the closure check. Unknown/unindexed descendants and omitted selected sessions prevent mutation.

After deletion, the remaining index IDs and exposed path/project/parent/attachment/time/archive metadata must be unchanged. There must be no new thread. Non-target file fingerprints and links must be unchanged except for the observed native maintenance paths: the seven named SQLite databases above (including observed state/log/goals/memories/queue databases) and their sidecars, session name index/lock, installation ID, bundled system skills, native arg0 temporary directories, pinned log directory, thread-writer locks, `.tmp/plugins.sync.lock`, and `.tmp/git-*`. An unexpected change leaves `needs-review` and no credited reduction. This check does not compare every internal SQLite column or prove the absence of a same-metadata filesystem race.

Filesystem checks and graph checks are observations, not an operating-system transaction. Another process can change a directory, link, file, or database between checks and launch. Activity detection, immediate revalidation, and postchecks reduce that race; ambiguous or unexpected results remain `needs-review`. Minimal synthetic fixtures do not establish cleanup semantics for arbitrary images, goals, history entries, worktrees, or future record types; retained resources remain measured separately.

Tagged native source used to establish these boundaries:

- [Session deletion app-server client](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/session_archive_commands.rs)
- [Daemon exclusion for runtime configuration](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/daemon_startup.rs)
- [Environment-variable executor selection](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/exec-server/src/environment.rs)
- [Configuration layer precedence](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/config/src/loader/mod.rs)
- [macOS forced-preference query](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/config/src/loader/macos.rs)
- [Native executable alias creation and cleanup](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/arg0/src/lib.rs)
- [Native rollout and metadata deletion](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/thread-store/src/local/delete_thread.rs)
- [Session name index and lock](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/rollout/src/session_index.rs)
- [Host cleanup and background rollout maintenance](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/thread_manager.rs)
- [Versioned SQLite database paths](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/state/src/sqlite.rs)

## Claude Code 2.1.319

Native validation used a fresh `CLAUDE_CONFIG_DIR` and a canonical temporary project directory, with its encoded project directory below `projects`. Two synthetic main transcripts each contained a user message and assistant text response, linked through `uuid` / `parentUuid`, with matching `sessionId`, `cwd`, and `version: "2.1.319"`, `isSidechain: false`, and `userType: "external"`.

The native CLI was run in a bounded terminal session with `--bare --safe-mode --strict-mcp-config --setting-sources '' --ax-screen-reader --resume`. A fake API key, a loopback-only unreachable API endpoint, and disabled nonessential traffic prevented a model request from being useful; no prompt was submitted. The native resume picker initially displayed both synthetic conversations. After removal of one main JSONL, the picker displayed only the survivor. Native `--resume <surviving-uuid>` rendered its original user text and assistant answer unchanged. Claude Agent SDK 0.3.251 `listSessions` and `getSessionMessages` also reflected the same fixture, but the native picker and transcript rendering are the primary evidence.

This validates listing refresh and reading/resuming the surviving **plain main transcript** after deletion, for 2.1.319. It does not validate a generated continuation, arbitrary signed/tool payload rewriting, unknown attachments, or all subagent layouts. Do not advertise those broader guarantees based on this probe.

The supported cc-clean operation removes only a structurally verified session group: its main JSONL and independently verified uniquely owned subagent/tool-result files. Preserve project memory, configuration, file history, `history.jsonl`, and resources with uncertain ownership. Never substitute `claude purge`: its project/configuration scope is broader than a selected conversation. Unknown versions, malformed or incomplete transcripts, ambiguous references, and unsupported ownership relationships must prevent mutation.
