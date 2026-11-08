# cc-clean Implementation Plan

> Initial implementation is complete. Continue directly on `main`; no commits or publication are authorized. Current agent execution rules are in `AGENTS.md`.

**Goal:** Deliver the designed three-section CLI with local `npm run dev` and packaged `cc-clean` entry points.
**Architecture:** A read-only scanner and provider parsers produce stable objects. All mutations use one guarded executor and per-provider operation ledger; UI and CLI share these paths.
**Tech Stack:** Node.js 24+, TypeScript, Node test runner, @inquirer/prompts.
**Spec:** ../specs/2026-11-08-cc-clean-design.md

## Global Constraints
- User data remains read-only during development. The user subsequently prohibited automatic cleanup commands, including previews and cleanup tests. Use only read-only verification unless the user explicitly requests cleanup execution.
- All application text and user documentation are English. JSON and noninteractive arguments support Agent invocation without menu interaction.
- Application state: `~/.config/cc-clean/`; no environment bypass for safety checks.
- Strictly older than 72 hours for verified temporary files. Session/image deletion requires explicit confirmation.
- Unknown field mutation and embedded-image rewriting are not enabled.
- No Git commits, push, publication, or Computer Use.

## Review Focus
- Linked or replaced path components must never lead mutations outside a provider root.
- Crash recovery must preserve data and avoid double-counting.
- Incomplete or stale scans/usage must not masquerade as complete totals.
- Native deletion may touch shared SQLite/WAL files and descendants.
- Noninteractive/JSON commands must not prompt or contaminate stdout.

## Tasks
- [x] Scanner and analysis (`src/scan.ts`, `src/analyze.ts`, `src/providers/*`, `test/analyze.test.ts`): no-follow inventory, project/session attribution, bounded JSONL, read-only SQLite, usage/field reports and bounded cache. Interfaces in `src/types.ts`; export `scanRoot(root, provider, signal?)` and `analyze(inventory, {deep?, signal?, stateDir?}?)`.
- [x] PNG (`src/png.ts`, `test/png.test.ts`): export `recompressPng(input: Buffer): Promise<Buffer | null>`; null means no reduction; reject unsupported/damaged PNG. Test CRC, metadata, exact inflated scanlines, limits and APNG before implementation.
- [x] Native compatibility (`src/codex-delete.ts`, `test/codex-delete.test.ts`): isolated installed Codex deletion verification; export a safe UUID-only native invocation. Document supported versions and full mutation scope; never touch live roots.
- [x] Shared mutations (`src/config.ts`, `src/clean.ts`, `src/stats.ts`, `test/clean.test.ts`): test dry-run, cutoff, references, active-client blocking, fingerprint mismatch, transactions, restart recovery and per-provider accounting before implementation.
- [x] CLI/UI (`src/cli.ts`, `src/ui.ts`, `test/cli.test.ts`, `README.md`): strict flags, menu/navigation/filter/selection, reports, JSON, exit codes and local development instructions.
- [x] Integration: run typecheck, suite, isolated end-to-end cleanup and package/tarball smoke tests. Read-only live analysis smoke; independent review and fix material findings.

## Execution notes
- Work is implemented directly on the unborn `main` branch, as requested. No worktree, commit, push, or publication was created.
- User authorized implementation already; no additional plan approval gate.

## Initial verification — 2026-11-08, before the cleanup prohibition and English/Agent changes
- `npm run typecheck`, `npm test` (126 passed, 0 failed, 0 skipped), and `npm run build` passed.
- Installed a packed tarball into an isolated temporary directory; the installed command returned help and valid JSON analysis for two empty synthetic provider roots. No global installation or npm publication.
- Installed Codex 0.167.0 passed synthetic native cascade deletion, including archived descendants; the surviving session remained listed and readable with its original turns. Claude compatibility evidence is documented in `docs/native-compatibility.md`.
- Read-only live inventories completed for both providers, with three bounded session samples each. This was not a complete deep parse of all live transcripts. User data was never cleaned or rewritten.
- Terminal smoke covered the main menu, provider choice, directory search, nested directory browsing and return navigation.

## English and Agent verification — 2026-11-08
- Interface, help, diagnostics and README are in English. Source and README scans found no Chinese application text; Unicode user data remains supported.
- `npm run typecheck`, `npm run test:read-only` (68 passed, 0 failed, 0 skipped), and `npm run build` passed after the English and Agent changes.
- Packed the built files and installed the tarball in an isolated temporary prefix with lifecycle scripts disabled. The installed command passed four read-only JSON checks: help, version, analysis of absent synthetic roots, and statistics. The package contains 20 files, including the CLI, command schema, README, AGENTS.md and native compatibility documentation.
- Parser and read-only subprocess tests cover command discovery, structured errors, provider filtering, noninteractive output, and paths containing Chinese characters and spaces.
- No cleanup, cleanup preview, compression or deletion tests were run after the user's prohibition. The earlier 126-test result does not validate the latest cleanup argument wiring; that path remains untested in this revision.
- Work remains on `main`, without commits, publication or global installation.

## Implemented limits
- Mutations are enabled only on macOS. Native Codex deletion and verified temporary-file cleanup target 0.167.0; Claude transcript deletion targets schema version 2.1.319.
- Automatic image optimization supports verified standalone Codex PNGs. Claude has no verified automatic temporary-file or standalone-image rule yet. Field compression remains report-only pending rules.
- Session deletion requires complete provider deep analysis. Unknown, damaged or oversized records can block deletion, including unrelated sessions.
- Accounting reports logical bytes, not physical disk reclamation. Interruption recovery is tested; power-loss recovery and full live deep analysis are not.
