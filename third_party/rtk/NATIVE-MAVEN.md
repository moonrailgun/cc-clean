# RTK Maven historical output filters

`src/vendor/rtk-native-maven.ts` adapts RTK 0.49.0, commit
`653efb6ed02bd287d686c50e830dd1009356904f`, from
`src/cmds/jvm/mvn_cmd.rs`. Copyright (c) RTK contributors.
Licensed under Apache-2.0; see [LICENSE](LICENSE).

The module exports `mavenFilters` and `matchMavenFilter(argv)`. The matcher accepts
`mvn`, `mvnw` and `mvnd`, including executable paths. It follows the final free
lifecycle goal, consumes Maven value options, respects `--`, and bypasses filtering
for verbose/debug options. Quiet filtering is selected only for a supported goal.

| Exported filters | Upstream source |
| --- | --- |
| `mvn-test`, `mvnd-test` | `filter_surefire`, `filter_surefire_with_cap` |
| `mvn-compile`, `mvnd-compile` | `filter_compile` |
| `mvn-package`, `mvnd-package` | `filter_package`, `filter_package_with_cap` |
| `mvn-quiet`, `mvnd-quiet` | `filter_quiet`, `strip_module_tag` |
| Command routing | `mvn_takes_value`, `goals`, `detect_phase`, `route`, `is_verbose`, `is_quiet` |
| Shared test state | `SurefireBlock`, `FailingClassCap`, `FailuresSummaryCap`, `drive_surefire_line` |
| Parallel daemon state | `split_lane`, `is_lane_opener`, `Lane`, `Lanes`, `raw_owner` |

The test modes collapse successful Surefire/Failsafe classes, preserve failing
class blocks and application stack frames, and remove recognized framework stack
frames. Failing classes and summary entries have independent limits of 10 with
explicit omission counts. Daemon summary budgets span modules and plugin versions;
switching between Surefire and Failsafe resets the summary budget. Blank-separated
failing methods rearm their class trail. Compilation modes retain coordinates and
indented diagnostics and deduplicate warnings by text with coordinates removed.
Package mode also retains reactor and artifact-installation results.

Daemon parsing maintains up to 256 lanes including the root lane. New module tags
require a recognized module opener. Ambiguous raw output and overflow-module
diagnostics remain intact. Unfinished blocks are emitted at end of input. This
mirrors upstream's lane ownership and end-of-input behavior; it can move an
unfinished buffered block after already-emitted lines in malformed interleaving.

## Historical text adaptations

These functions operate on supplied text only. They never invoke Maven, inspect
reports or files, write tee/recall files, infer exit status, or emit telemetry.
The shared facade handles ANSI SGR/CRLF normalization, unsafe terminal controls,
oversized inputs and the requirement to reduce UTF-8 bytes.

Intentional conservative differences from upstream:

- Nonquiet modes require an exact recognized English build footer. Unknown,
  localized and truncated output without this footer returns unchanged.
- Malformed `Tests run` records, unsafe integer counters and totals smaller than
  failures plus errors plus skipped tests return the original input.
- Upstream discards unrecognized outer lines. This port removes only recognized
  Maven framing and keeps unfamiliar application/plugin diagnostics. A passing
  test block containing such text is retained, including its opening and closing
  records. Warning counters are retained as additional context.
- An output unchanged by filtering retains its original trailing newline and line
  endings. Pure filters do not strip ANSI. In particular, whitespace-only quiet
  output remains unchanged instead of becoming an empty string.
- A value option missing its argument is not routed. `mvnw` shares the `mvn`
  filters. Unknown option spellings are treated as atomic flags, as in upstream's
  Maven grammar; plugin-specific argument semantics are not inferred.

All eight filter modes are implemented. Exact output parity for every possible
plugin, localized log or arbitrary daemon interleaving is not claimed. More text
may survive than upstream; filtering does not establish command success.

## Tests and fixture provenance

`test/rtk-native-maven.test.ts` includes command grammar, verbose/quiet routing,
compiler continuations, warning deduplication, failure trails, per-test rearming,
both omission budgets, phase resets, application-tag ambiguity, lane overflow,
malformed counters and unknown diagnostics. Full output assertions compare all
four upstream `mvnd` expected fixtures byte-for-byte. Two ordinary Maven slice
fixtures have independently specified complete expected output.

The following files under `test/fixtures/rtk-maven/` are copied unchanged from the
pinned upstream `tests/fixtures/` directory, under Apache-2.0, Copyright (c) RTK
contributors:

- `mvnd_reactor_pass_raw.txt`, `mvnd_reactor_pass_expected.txt`
- `mvnd_test_fail_raw.txt`, `mvnd_test_fail_expected.txt`
- `mvnd_reactor_fail_raw.txt`, `mvnd_reactor_fail_expected.txt`
- `mvnd_compile_error_raw.txt`, `mvnd_compile_error_expected.txt`
- `mvn_test_pass_slice_raw.txt`, `mvn_compile_error_slice_raw.txt`

Run only the pure tests:

```sh
node --disable-warning=ExperimentalWarning --test test/rtk-native-maven.test.ts
```
