# Git historical-text formatter port

Copyright 2026 RTK AI Labs. Licensed under Apache-2.0. cc-clean modified the
formatters into pure TypeScript with complete-input checks and conservative
fallbacks. The source is RTK 0.49.0, commit
`653efb6ed02bd287d686c50e830dd1009356904f`.

`src/vendor/rtk-native-git.ts` exports **13 working formatters** and an argv
matcher. They consume captured text only. They do not invoke Git, inspect a
repository or home directory, read files, produce tee files, or record telemetry.

## Mapping

Source paths are relative to the pinned upstream repository. Git log, status
and the regular Git diff formatter are owned by the separate pipe registry.

| Export | Upstream source and behavior |
| --- | --- |
| `git-branch` | `src/cmds/git/git_cmd.rs:3918`, `filter_branch_output`: local/current branches, deduplicated remote-only names, ten remote names and overflow count |
| `git-stash-list` | `git_cmd.rs:4219`, `filter_stash_list`: remove the recognized branch prefix from each stash message |
| `git-stash-show` | `git_cmd.rs:4240`, `compact_stash_stat`, `compress_stat_summary`, `parse_stash_stat`, `diffstat_row`; patch output uses the strict parser below |
| `git-stash-action` | `git_cmd.rs:4025`, `format_stash_message`: only an explicit single-line saved-worktree confirmation becomes `ok stashed` |
| `git-worktree-list` | `git_cmd.rs:4444`, `filter_worktree_list`: collapse alignment while preserving paths containing spaces and locked/prunable annotations |
| `git-ls-tree` | `git_cmd.rs:4477`, `ls_tree_folds`, `fold_ls_tree_paths`, `render_ls_tree`: reversible folding of consecutive same-directory path runs |
| `git-show` | `git_cmd.rs:497`, `run_show`, adapted to preserve the captured commit prefix verbatim and condense its captured patch |
| `git-commit` | `git_cmd.rs:3316`, `parse_commit_output`: seven-character hash confirmation after validating all output lines |
| `git-checkout` | `git_cmd.rs:3429`, `format_checkout_success`: explicit checkout/switch/restore confirmations |
| `git-push` | `git_cmd.rs`, `GIT_PUSH_NOISE_PREFIXES` and `run_push`: recognized numeric progress removal, preserving all other lines |
| `git-fetch` | `git_cmd.rs:3979`, `run_fetch`: the same progress removal without fabricating an exit-based confirmation |
| `git-pull` | `git_cmd.rs`, `run_pull`: explicit up-to-date or complete fast-forward/stat summaries |
| `diff-stdin` | `src/cmds/git/diff_cmd.rs:1901`, `parse_hunk_header`, and `:2127`, `condense_unified_diff_strict`: strict captured patch condensation |

## Parser contract

The strict diff parser counts every old and new hunk line. Combined diffs have
one budget for each parent, up to the upstream maximum of eight parents. It
retains changed lines and their adjacent no-final-newline annotations, omits
context only after validating the complete hunk, and reports per-file counts.
Truncated or overfull hunks, context-only/word diffs, unsafe numeric counts,
unrecognized metadata and stray marked lines preserve the entire input.

Supported producers are ordinary Git unified/combined patches, GNU unified
header pairs and simple directory command echoes, and SVN unified text sections.
Rename/copy pairs, matched mode changes, new/deleted empty files, and binary
file facts retain their meaning. Basic GNU `Only in`, identical/different-file,
binary and unmerged facts are represented as file notes. Timestamp suffixes are
removed only in recognized forms. Git C-quoted names stay quoted byte-for-byte;
they are not decoded into potentially multiline names. Git path splitting is
bounded to 64 candidate spaces; more ambiguous headers remain raw.

The following upstream parser branches deliberately remain byte-identical:
mbox/format-patch prose and signature regions; Mercurial message prologues;
encoded `GIT binary patch` payloads; SVN property blocks; submodule log prose;
complex shell-quoted GNU command echoes/facts and ambiguous `Only in` names;
empty SVN copy-target sections. These are unsupported captured producer shapes,
not claims that the upstream transforms require external effects.

## Historical adaptations and other entrypoints

- Matchers accept recognized output shapes and reject custom formats, verbose
  branch listings, porcelain/NUL path output, blob `show` specifications and
  unsupported options. Unknown, malformed and empty outputs remain unchanged.
  Every record is checked before list display caps are applied.
- A commit, checkout, stash or pull success is emitted only from an explicit
  recognized confirmation and completely recognized accompanying output. Hook
  output and later diagnostics preserve the original. No missing exit status is
  replaced with a guessed success. Push/fetch remove only recognized numeric
  progress; remote warnings, ref updates, failures and unknown lines survive.
- Worktree formatting does not shorten the home path because historical text
  supplies no verified home directory. Bare, verbose, porcelain and unknown
  worktree forms stay raw. Detached, verbose and remote-only branch listings
  stay raw rather than inventing a current branch.
- `run_show`, `probe_is_blob`, blob truncation, log walk probes and detached-HEAD
  queries depend on repository data absent from captured text. No query is
  reproduced. Show preserves its original commit metadata and message.
- `run_add`, write actions for branch/worktree/stash, generic passthrough,
  execution-dependent confirmation fallbacks and exit classification remain
  outside the text-only port. A failure is not summarized as success.
- `diff_cmd.rs` file-operand `compare_files`/`render_diff`, similarity calculation
  and invisible-byte comparison need two original file contents. A captured
  command result cannot reconstruct them, so this integration exposes only the
  stdin/captured-patch parser. Standalone ordinary `diff a b` is not matched;
  explicit `diff-stdin` is available through the registry.
- Upstream capture, command rewriting, environment/locale changes, tracking,
  tee files, token accounting and exit-code output are not implemented. The
  parent facade owns byte savings, terminal-control rejection and input bounds.

## Verification

```sh
node --disable-warning=ExperimentalWarning --test test/rtk-native-git.test.ts
```

The 33 pure tests cover every export, matcher exclusions, unknown/error/empty
passthrough, late failures, path reconstruction, stat limits, combined hunk
budgets, incomplete patches, newline witnesses, rename/copy/mode/binary facts,
GNU roots, SVN headers, path ambiguity and unsupported producer shapes. No Git
commands or filesystem comparisons are executed by these tests.
