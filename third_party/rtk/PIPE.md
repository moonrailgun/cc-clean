# RTK pipe filters

`src/vendor/rtk-pipe.ts` is a TypeScript adaptation of RTK 0.49.0,
commit `653efb6ed02bd287d686c50e830dd1009356904f` (Apache-2.0).
Copyright (c) RTK contributors. See [LICENSE](LICENSE).
The registry contains all 23 groups / 28 names from `src/cmds/system/pipe_cmd.rs`.
Paths below are relative to the upstream repository.

| Names | Source functions |
| --- | --- |
| cargo-test, cargo | `src/cmds/rust/cargo_cmd.rs`: `filter_cargo_test` |
| pytest | `src/cmds/python/pytest_cmd.rs`: `filter_pytest_output` |
| go-test | `src/cmds/go/go_cmd.rs`: `filter_go_test_pipe` |
| go-build | `src/cmds/go/go_cmd.rs`: `filter_go_build` |
| ctest | `src/cmds/system/ctest_cmd.rs`: `filter_ctest_output` |
| tsc | `src/cmds/js/tsc_cmd.rs`: `filter_tsc_output` |
| vitest | `src/cmds/js/vitest_cmd.rs`: `VitestParser`; `src/parser/formatter.rs`: compact test formatter |
| grep, rg | `src/cmds/system/pipe_cmd.rs`: `grep_wrapper` |
| find, fd | `src/cmds/system/pipe_cmd.rs`: `find_wrapper` |
| git-log | `src/cmds/git/git_cmd.rs`: `filter_log_output`, limit 50 |
| git-diff | `src/cmds/git/git_cmd.rs`: `compact_diff`, limit 200 |
| git-status | `src/cmds/git/git_cmd.rs`: `format_status_output` |
| log | `src/cmds/system/log_cmd.rs`: `run_stdin_str` |
| mypy | `src/cmds/python/mypy_cmd.rs`: `filter_mypy_output` |
| ruff-check | `src/cmds/python/ruff_cmd.rs`: `filter_ruff_check_json` |
| ruff-format | `src/cmds/python/ruff_cmd.rs`: `filter_ruff_format` |
| sqlfluff-lint | `src/cmds/python/sqlfluff_cmd.rs`: `filter_sqlfluff_lint_json` |
| prettier | `src/cmds/js/prettier_cmd.rs`: `filter_prettier_output` |
| phpunit | `src/cmds/php/phpunit_cmd.rs`: `filter_phpunit_output` |
| pest, paratest, php-test | `src/cmds/php/test_output.rs`: `filter_test_runner_output` |
| ecs | `src/cmds/php/ecs_cmd.rs`: `filter_ecs_output` |
| phpstan | `src/cmds/php/phpstan_cmd.rs`: JSON/text filters |
| pint | `src/cmds/php/pint_cmd.rs`: `filter_pint_json` |

## Historical text adaptations

The functions operate only on strings. They do not execute a command, read the
filesystem, write tee/recall files, infer exit status, or emit telemetry. The shared
facade separately rejects terminal controls, oversized input and byte expansion.

Malformed/unknown formats return their original string, including its newlines.
Structured parsers validate known fields and types; unexpected diagnostic fields,
invalid counters and inconsistent test/message totals cause passthrough. Known
but unsupported variants also pass through. Unlike upstream's permissive parsing
or fallback tails, this never invents a successful result for unrecognized input.

Specific boundaries and intentional differences:

- Go tests require NDJSON. Unknown records retain their original bytes. Ordinary
  Go test text is outside this pipe parser. Orphan build diagnostics pass through.
- Git status requires porcelain v1, and log requires RTK's `---END---` markers.
  Ordinary long status and ordinary log output pass through. Diff validates file,
  hunk and metadata framing before compacting.
- Ruff check, SQLFluff lint and Pint require JSON; Pint human output passes through.
  Ruff's standard `name` and error `severity` fields are accepted. Other severities
  pass through to preserve their significance. SQLFluff accepts v2/v4 coordinates
  and validates nested fix operations before reporting fixability.
- Vitest JSON validates test totals and ordinary snapshot metadata. Snapshot
  failures, unhandled errors, suite-level messages and unknown assertion metadata
  pass through. Recognized human totals and failure blocks also work.
- Bare find output without path evidence remains unchanged. Grep/find diagnostics
  cause passthrough instead of being mistaken for matches or filenames.
- Cargo/pytest/tsc/mypy unknown lines remain intact, commonly by returning the entire
  input. Pytest warning summaries pass through. CTest retains unrecognized detail;
  repeated/nested advanced output has not been exhaustively verified against Rust.
- ECS retains issue text beyond upstream's whitelist. PHPStan retains global
  errors, identifiers, tips and message continuation lines, and its header includes
  global errors. The upstream PHPStan fixture has inconsistent totals and is
  deliberately preserved, with an exact test.
- Omitted list/detail entries have explicit count markers; grouped ties are sorted
  alphabetically for deterministic output. Unicode clipping uses code points.
  These changes can differ from Rust's unstable equal-count ordering and clipping.
- Exact byte parity across every upstream format is not claimed. Compact format
  and caps follow the pinned sources; conservative recognition, extra diagnostics
  and the conditions above favor preserving history over maximum compression.

## Verification and fixture provenance

`test/rtk-pipe.test.ts` covers every registry group and alias, malformed schemas,
unknown diagnostics, failure detail and list caps. Full output assertions include
Ruff repeated-rule and SQLFluff v4 fixtures, plus the deep pytest traceback.
`test/fixtures/rtk-pipe/*` are unchanged Apache-2.0 upstream fixtures from the
pinned `tests/fixtures/` directory (Copyright (c) RTK contributors).

Run only the pure tests:

```sh
node --disable-warning=ExperimentalWarning --test test/rtk-pipe.test.ts
```
