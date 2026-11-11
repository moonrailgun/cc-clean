# RTK native historical-text filters

Source: RTK 0.49.0, commit
`653efb6ed02bd287d686c50e830dd1009356904f`, Copyright (c) RTK contributors,
Apache-2.0. See [LICENSE](LICENSE) and [UPSTREAM.md](UPSTREAM.md).
The TypeScript files carry their upstream source attribution. Tests contain
synthetic source-derived cases except fixtures explicitly identified as copied.

`src/vendor/rtk-native.ts` exports `nativeFilters` and `matchNativeFilter(argv)`.
These adapters consume supplied strings. They do not execute commands, discover
projects, read manifests or reports, inspect repositories, call services, write
tee files, or collect telemetry. Command matching selects a candidate; the
formatter must also recognize its captured format. A match does not prove that
the command succeeded. The history adapter separately requires a completed,
successful execution, supported envelope, and net UTF-8 byte savings.

This inventory covers every source file in the pinned `src/cmds` tree. There is
no `src/cmds/swift` directory at this revision. Source paths in the tables are
relative to `src/cmds/`. “Pipe” refers to [PIPE.md](PIPE.md); declarative command
rules are recorded separately in [RULES.md](RULES.md). Family-specific native
details are in [NATIVE-CLOUD.md](NATIVE-CLOUD.md),
[NATIVE-GIT.md](NATIVE-GIT.md), [NATIVE-BUILD.md](NATIVE-BUILD.md), and
[NATIVE-MAVEN.md](NATIVE-MAVEN.md).

## JavaScript and TypeScript

Implementation: `rtk-native-js.ts`, with explicit generic-lint support in
`rtk-native-helpers.ts`.

| Source file | Pure paths and historical availability |
| --- | --- |
| `js/bun_cmd.rs` | `filter_bun_pkg` → `bun-package`; `filter_bun_pm_ls_json`, `filter_bun_pm_ls_tree`, `filter_bun_pm_ls_text` → `bun-list`. Captured JSON objects/arrays and recognized text/tree dependency lists are supported. Build/test/bunx are execution/delegation wrappers, not new filters. |
| `js/deno_cmd.rs` | `filter_deno_output` → `deno`, removing recognized download/task noise while retaining other lines. Commands with explicit/custom diagnostic formats must still pass content recognition. Runner selection and command invocation are excluded. |
| `js/lint_cmd.rs` | `filter_eslint_json` → `eslint`; `filter_pylint_json` → `pylint`; `compact_path` is shared rendering. `filter_generic_lint` → explicit `filterGenericLint`, never inferred from arbitrary command output. Linter/project detection requires filesystem context. |
| `js/next_cmd.rs` | `filter_next_build`, `extract_time` → `next-build`, retaining route/build summary and source-selected warnings/errors. Route tables require recognized size columns and complete rows; see the corrections below. |
| `js/ng_cmd.rs` | `filter_build`, `cells`, `header_columns`, `is_row`, `compact_line` → `ng-build`. Build watch/interactive flags bypass routing; workspace builder/watch discovery requires unavailable configuration. |
| `js/npm_cmd.rs` | `filter_npm_output` → `npm`, removing npm framing/notices according to source. This is also the captured output path for recognized npm run/exec invocations; nested command dispatch belongs to the facade. Execution/capture helpers are excluded. |
| `js/playwright_cmd.rs` | `collect_test_results`, `extract_playwright_regex`, `extract_failures_regex`, and `TestResult` rendering → `playwright`, for recognized JSON and human reports. JSON requires suites and consistent expected/unexpected/skipped totals. Flaky reports and top-level errors stay raw. Reporter injection and exit status are unavailable. |
| `js/pnpm_cmd.rs` | `filter_pnpm_install` → `pnpm-install`; `collect_dependencies`, `extract_list_text`, `format_dependency_listing` → `pnpm-list`/`pnpm-list-all`; `extract_outdated_text` and JSON outdated rendering → `pnpm-outdated`. List selectors choose the upstream capped or uncapped dependency mode. |
| `js/prettier_cmd.rs` | `filter_prettier_output`: pipe `prettier`. |
| `js/prisma_cmd.rs` | `filter_prisma_generate`, `filter_migrate_dev`, `filter_migrate_status`, `filter_migrate_deploy`, `filter_db_push` and their number/table/index extraction → five `prisma-*` filters. Status/deploy counts use complete captured reports rather than keyword occurrences; see below. No migrations or schema inspection are executed. |
| `js/tsc_cmd.rs` | `parse_diagnostic`, diagnostic buffering, `filter_tsc_output`: pipe `tsc`. |
| `js/vitest_cmd.rs` | JSON/text test parsing and compact rendering: pipe `vitest`. Jest routing uses the same recognized parser where selected by the facade. CLI reporter construction, stdout/stderr capture and tee-dependent hints are excluded. |

ESLint rejects messages with unsupported severities and aggregate counts that
contradict the messages. Pylint accepts the upstream parser's legacy JSON array;
the runner's JSON2 object output is not silently treated as that array. Native
text recognizers follow source marker-based behavior; arbitrary localized
reporters and custom versions are not an asserted compatibility contract.

Next.js parsing corrects the source's column-zero symbol counting: tree-prefixed
route rows count, legends do not, `○`/`●` are static, `ƒ`/`λ` are dynamic, and
`◐` is partial. Bracketed route paths survive, and first-load sizes normalize
`B`/`kB`. Page size versus first-load size is not reported as bundle growth.
Route rows do not contribute to diagnostic counts or build timing, even when
paths contain `error`, `warning`, or duration-like text.
Missing, incomplete or unknown route tables preserve the original output,
including unsupported size-free tables and additional SSG child-row formats.

Prisma status reports an applied count only from an explicit migration total
followed by the final up-to-date confirmation. Deploy counts the complete final
applied-migration tree, not progress lines, the total found on disk, or repeated
success prose. An explicit no-pending result reports zero. Other reports,
including pending status, failed deploys and incomplete lists, remain raw.
Synthetic examples in `test/fixtures/rtk-js/` cover these corrections both in
the filters and through in-memory history compaction; no commands are rerun.

## Rust, Go, Ruby, Scala, JVM, and .NET

Implementation: `rtk-native-rust.ts`, `rtk-native-ruby.ts`,
`rtk-native-extra.ts`, `rtk-native-system.ts`, and the delegated build modules.

| Source file | Pure paths and historical availability |
| --- | --- |
| `rust/cargo_cmd.rs` | Build/check text parsing, `extract_json_diagnostics`, `merge_diag_counts`, `cargo_build_success_line`, `cargo_build_failure_summary`, clippy grouping → `cargo-build`, `cargo-check`, `cargo-clippy`; `filter_cargo_install`, `format_crate_info` → `cargo-install`; `filter_cargo_nextest`, failure buffering/status/test-name helpers → `cargo-nextest`. `filter_cargo_test` is pipe `cargo-test`. |
| `rust/runner.rs` | Generic `run_err` and `run_test` invoke commands and classify exit status. No separate pure formatter; captured cargo/test paths are covered above. |
| `go/go_cmd.rs` | `filter_go_vet` → `go-vet`; Go JSON test event parsing and `filter_go_build` → pipe `go-test`/`go-build`. Tool/version probes and exit-derived fallback summaries require execution. |
| `go/golangci_cmd.rs` | `filter_golangci_json`, compact paths and linter/file grouping → `golangci-v1`/`golangci-v2`; v2 retains source-line samples. Only recognized JSON output flags route automatically. CLI version probing is excluded. |
| `ruby/rake_cmd.rs` | `filter_minitest_output`, `parse_minitest_summary`, `build_minitest_summary`, failure headers → `rake-test`. Project/runner detection is excluded. |
| `ruby/rspec_cmd.rs` | `strip_noise`, `filter_rspec_output`, `build_rspec_summary`, `filter_rspec_text`, numbered failures/backtrace reduction → `rspec`, JSON or recognized text. No JSON formatter is injected into historical executions. |
| `ruby/rubocop_cmd.rs` | `filter_rubocop_json`, `filter_rubocop_text`, severity ranking, autocorrect counts, compact Ruby paths → `rubocop`. JSON and recognized human summaries are supported. |
| `scala/sbt_cmd.rs` | `filter_sbt_compile`, `filter_sbt_test`, `filter_sbt_run` → `sbt-compile`, `sbt-test`, `sbt-run`. Common scoped test/compile/run tasks route; execution-based fallback success and arbitrary task dispatch are excluded. |
| `jvm/gradlew_cmd.rs` | Build/test/connected-test/lint/dependency text paths → `rtk-native-build.ts`; see [NATIVE-BUILD.md](NATIVE-BUILD.md). Gradle task invocation and auxiliary file collection are excluded. |
| `jvm/mvn_cmd.rs` | All four Maven modes and daemon equivalents, including parallel lane parsing, Surefire/Failsafe state and diagnostic caps → eight filters in `rtk-native-maven.ts`. Exact source mapping and conservative differences: [NATIVE-MAVEN.md](NATIVE-MAVEN.md). |
| `dotnet/binlog.rs` | Text build/test/restore diagnostics, deduplication, counts, duration, and environment redaction → `rtk-native-build.ts`. Binary binlog parsing cannot operate on a captured text result. |
| `dotnet/dotnet_cmd.rs` | Build/test/restore issue rendering and caps → `rtk-native-build.ts`. Command execution, report generation, binary recovery and exit-based classification are excluded. |
| `dotnet/dotnet_format_report.rs` | Auxiliary JSON format-report parsing/rendering is not exported. Historical stdout is not the report; the integration has no associated report contents or reliable report-to-execution binding. This is an unexposed pure report parser as well as an excluded file reader. |
| `dotnet/dotnet_trx.rs` | Auxiliary TRX XML parsing/rendering is not exported for the same missing-report/binding reason. Ordinary captured dotnet test text is handled separately; TRX contents are not guessed from it. |

Cargo JSON recognizes compiler messages, compiler artifacts, build-script events
and final build status. Unknown events, arbitrary mixed text and unrecognized
tails preserve the original. Install output requires a terminal result or
diagnostic, so an interrupted compilation is not summarized as installed.

## PHP and Python

| Source file | Pure paths and historical availability |
| --- | --- |
| `php/artisan_cmd.rs` | `filter_artisan_output` → `artisan`; `filter_artisan_test_output` delegates to the PHP test pipe path. Ordinary recognized Artisan text receives source box/dot/space reduction. |
| `php/ecs_cmd.rs` | `filter_ecs_output`: pipe `ecs`. |
| `php/paratest_cmd.rs` | Runner wrapper delegates to `test_output.rs`; facade/pipe `paratest`/`php-test`. |
| `php/pest_cmd.rs` | Runner wrapper delegates to `test_output.rs`; pipe `pest`. |
| `php/php_cmd.rs` | `filter_php_lint_output` → `php-lint`, matching `-l` or `--syntax-check`; generic `filter_php_output` → explicit `filterPhpOutput`. Generic PHP script output is not automatically interpreted as lint or success. |
| `php/phpstan_cmd.rs` | `filter_phpstan_json`, `filter_phpstan_text`, compact PHP paths: pipe `phpstan`. |
| `php/phpt_cmd.rs` | `filter_phpt_output`, `parse`, `after_colon`, `build_summary` → `phpt`, including environment, counters, and captured failure diffs. Reading missing `.diff` files or rerunning tests is excluded. |
| `php/phpunit_cmd.rs` | `filter_phpunit_output`, failure headings, count/summary/skipped rendering: pipe `phpunit`. |
| `php/pint_cmd.rs` | `filter_pint_json`: pipe `pint`; arbitrary human output is not treated as JSON. |
| `php/test_output.rs` | `is_progress_line`, `filter_test_runner_output`: PHP test pipe family. |
| `php/utils.rs` | ANSI/control stripping supports PHP helpers and pipe parsing. Tool path lookup, Composer executable detection and PHP runner discovery require filesystem access and are excluded. |
| `python/mypy_cmd.rs` | `filter_mypy_output`: pipe `mypy`. |
| `python/pip_cmd.rs` | `filter_pip_list` → `pip-list`; `filter_pip_outdated` → `pip-outdated`. JSON is required for routing. Other pip operations are upstream passthrough/declarative paths. |
| `python/pytest_cmd.rs` | `filter_pytest_output`, summary/duration parsing, captured-section and traceback handling: pipe `pytest`. Test invocation and injected arguments are excluded. |
| `python/ruff_cmd.rs` | `filter_ruff_check_json`, `filter_ruff_format`: pipe `ruff-check`/`ruff-format`. Command planning/graph passthrough is not a separate transform. |
| `python/sqlfluff_cmd.rs` | `filter_sqlfluff_lint_json`, `render_lint_json`, location/path helpers: pipe `sqlfluff-lint`. Format planning is handled by matcher constraints. |
| `python/uv_cmd.rs` | `filter_uv_run_output`, diagnostic/error/traceback extraction and deduplication → explicit `filterUvRun(input, stdout, stderr, exitCode)`. It is not automatically selected from a combined output string because stream separation/status are required. Other uv operations are delegation, passthrough or declarative rules. |

## Containers, cloud, HTTP, and Git

| Source file | Pure paths and historical availability |
| --- | --- |
| `cloud/aws_cmd.rs` | 25 AWS text/JSON filters, nested field formatters and generic lossless JSON-whitespace compaction → `rtk-native-cloud.ts`. Every entrypoint and schema boundary is listed in [NATIVE-CLOUD.md](NATIVE-CLOUD.md). |
| `cloud/container.rs` | `format_container_line`/parts and ports → `docker-ps`/`docker-ps-all`; images grouping → `docker-images`; `format_compose_ps`/`format_compose_build` → `compose-ps`/`compose-build`; `format_kubectl_pods`/`format_kubectl_services` → `kube-pods`/`kube-services`. Log paths delegate to the log pipe. |
| `cloud/curl_cmd.rs` | No-tee `filter_curl_output` → explicit `filterCurlOutput`; captured failure wording → `curlError(stderr, stdout)`. Byte-level invalid-UTF-8 detection is outside a JavaScript string callback; NUL inputs are conservatively preserved. Tee-backed truncation is excluded because the historical integration cannot create the promised recall file. No curl command is matched automatically. |
| `cloud/psql_cmd.rs` | `filter_psql_output`, `is_table_format`, `is_expanded_format`, `filter_table`, `filter_expanded` → `psql`. Recognized aligned tables/expanded records are supported; CSV/HTML/unaligned flags bypass matching. |
| `cloud/wget_cmd.rs` | `parse_error` → explicit `wgetError(stderr, stdout)`; stdout download summary/URL/size helpers → `summarizeWgetStdout(input, url)`. Successful downloaded-file summaries require real filename discovery and file metadata, so they are not reconstructed. No wget command is matched automatically. |
| `git/git_cmd.rs` | Branch/stash/worktree/ls-tree/show/commit/checkout/push/fetch/pull captured text → `rtk-native-git.ts`; log/status/ordinary diff → pipe. Exact functions and restrictions: [NATIVE-GIT.md](NATIVE-GIT.md). Repository probes, two-step command executions, unstated success confirmations and filesystem-dependent branches are excluded. |
| `git/diff_cmd.rs` | `parse_hunk_header`, `condense_unified_diff_strict` and captured-patch rendering → explicit registry `diff-stdin`. `compare_files`, `render_diff`, similarity/invisible-byte comparison require both original file operands, not merely their captured command output. Unsupported pure patch-producer branches are identified below and in [NATIVE-GIT.md](NATIVE-GIT.md). |
| `git/gh_cmd.rs` | Nine PR/issue/run/repository formatters plus Markdown filtering → cloud module. PR diff delegates to pipe diff; API/merge paths are passthrough. Create confirmations need execution success and are not guessed. |
| `git/glab_cmd.rs` | Nine MR/issue/CI/release formatters → cloud module. MR diff delegates to pipe diff; interactive CI view and API passthrough are not filters. MR create/action success depends on execution. |
| `git/gt_cmd.rs` | Log/submit/sync/restack/create → five cloud module filters. Git aliases delegate to native/pipe Git paths; short log/branch are upstream identity. No execution-derived confirmation is invented. |

Docker ps/images require the exact captured TSV formats used by upstream.
Default human tables are not converted by rerunning Docker. Kubernetes requires
validated PodList/ServiceList JSON. Pods with a waiting container state or an
explicitly unready container remain raw regardless of phase or waiting reason,
including `ImagePullBackOff` and `ErrImagePull`: phase-only rendering would hide
these details. Pod `Ready` conditions other than `True` also preserve the original,
including unmet readiness gates when all containers are ready. Malformed condition
structures remain raw; unrelated `False` conditions do not suppress summaries.
Compose and container log routing uses the existing log filter.

## System utilities and explicit content helpers

Implementation: `rtk-native-system.ts`, `rtk-native-system-text.ts`,
`rtk-native-helpers.ts`, `rtk-native-find.ts`, `rtk-native-search.ts`, and the pipe module.

| Source file | Pure paths and historical availability |
| --- | --- |
| `system/ast_grep_cmd.rs` | `filter_ast_grep` → `ast-grep`, bounded per-file/global source-line matches. Grouping appends to per-file arrays in linear time. JSON, headings, interactive and color variants bypass the text matcher. CLI discovery/execution is excluded. |
| `system/constants.rs` | Source ignore-name constants, reused by listing content. No independent output transform. |
| `system/ctest_cmd.rs` | `filter_ctest_output` and logical-line/test/summary/failure/time helpers: pipe `ctest`. Dashboard/execution modes are not reconstructed. |
| `system/deps.rs` | `summarize_cargo_str`, `summarize_package_json_str`, `summarize_requirements_str`, `summarize_pyproject_str`, `summarize_gomod_str` → explicit `summarizeDependencies(kind, input)`. Manifest discovery/file reads are excluded; ordinary `cat` is not assumed to request a dependency summary. |
| `system/env_cmd.rs` | Variable grouping, `is_lang_var`, `is_cloud_var`, `is_tool_var`, `is_interesting_var` → `env` and explicit `filterEnvironment(input, filter?)`. Only argument-free captured `env`/`printenv` listings route. Live process-environment gathering is excluded. |
| `system/find_cmd.rs` | Captured path grouping/caps: pipe `find`/`fd`. The separate native renderer is explicitly available: `group_by_dir` → `groupFindByDir`, `display_ordered` → `displayFindOrdered`, `build_capped_listing` → `buildCappedFindListing`, `filtered_hint` → `formatFindFilteredHint`, and `render` → `renderFind`. Callers supply paths, result cap, explicit-cap intent, filtered paths and optional already-existing recall text. Grouped/extension summaries, capped baseline, Unicode directory clipping, terminators and token-estimate guard follow source. Native directory walks, metadata/disclosure collection and glob/expression dispatch require operands/filesystem context and are excluded; no recall files or tracking records are created. |
| `system/format_cmd.rs` | `filter_black_output`, compact paths → `black`. Formatter detection by project files is excluded; Prettier delegates to its pipe filter. |
| `system/json_cmd.rs` | `render_json`, `filter_json_compact`, `compact_json`, `filter_json_string`, `extract_schema`, `schema_key` → explicit `filterJson(input, maxDepth, schemaOnly)`. Filename/extension validation and reads are excluded. `jq`, `cat`, curl and arbitrary JSON output are not automatically reduced to a schema. |
| `system/local_llm.rs` | `analyze_code`, language labels, imports/functions/structs/traits/pattern extraction → explicit `analyzeCode(input, language)`. Language/file discovery and any command wrapper are excluded. The helper is source heuristics, not an AST parser or a model call. |
| `system/log_cmd.rs` | `run_stdin_str`, `analyze_logs`, normalization: pipe `log`. File reads and follow/live streaming are excluded. |
| `system/ls.rs` | `parse_ls_line`, `perms_to_octal`, `human_size`, `compact_ls`, output grouping/caps → `ls-long`/`ls-long-all` for recognized English long listings. Native filesystem listing, abbreviations/metadata resolution and recursive/non-long output are not reconstructed. |
| `system/pipe_cmd.rs` | All 23 groups / 28 names, wrappers, lookup and aliases are in [PIPE.md](PIPE.md). This integration supplies deterministic command selection rather than unsafe arbitrary-output auto-detection. |
| `system/read.rs` | `format_with_line_numbers` → explicit `formatWithLineNumbers`; `apply_line_window`, head/tail/raw-byte slicing → `applyLineWindow`. Input is the complete supplied text. Reading files, efficient seek/read windows and tracking baseline are excluded. |
| `system/search.rs` | Captured grep/rg matching and path grouping: pipe `grep`/`rg`. The distinct native paths are explicit exports: `parse_match_line` → `parseSearchMatchLine`, `format_match_line` → `formatSearchMatchLine`, `match_block` → `formatSearchMatchBlock`, `SearchStreamFilter::feed_line` → `renderSearchStream`, `fold_path_prefix` → `foldSearchPathPrefix`, `clean_line` → `cleanSearchLine`, `compact_path` → `compactSearchPath`, and the grouped/context body of `run` → `renderSearchOutput`. Callers supply file/line display flags, total/per-file caps, maximum line length, pattern and optional context/context-only modes. Match/context separators, gap markers, omission counts and the capped-output byte-savings guard follow the no-tee path. Unrecognized buffered rows preserve the original; streaming formatting retains unknown lines. These context-aware exports are separate from the input-only registry and pipe wrappers. Search-engine execution, live stream delivery and filesystem-derived `wants_show_file` decisions are excluded. |
| `system/summary.rs` | `summarize_output`, output-type detection and test/build/log/list/JSON/generic summaries → explicit `summarizeOutput(input, command, success)`. Command execution and status discovery are excluded. |
| `system/tree.rs` | `filter_tree_output` → `tree`, recognized Unicode tree footer removal. Non-tree text, JSON/XML/HTML variants and filesystem tree generation are not inferred. |
| `system/wc_cmd.rs` | `filter_wc_output`, single/multiple-row formatting and common-directory prefixes → `wc-full`/`wc-single`/`wc-mixed`. Full/single modes preserve complete filenames after numeric columns, fixing upstream whitespace splitting. Ambiguous mixed-mode whitespace names remain raw. |

The source helpers also adapt `src/core/filter.rs` minimal/aggressive source
filtering and `text/src/lib.rs` smart truncation as `filterSource` and
`smartTruncate`. Their caller must supply language, level, and limits. They are
not selected automatically for shell `cat`, `head`, `tail`, or editor output.
These explicitly requested lossy helpers intentionally retain source fallback
behavior; they are distinct from the conservative command-history registry.

`src/cmds/mod.rs` and each of `cloud/mod.rs`, `dotnet/mod.rs`, `git/mod.rs`,
`go/mod.rs`, `js/mod.rs`, `jvm/mod.rs`, `php/mod.rs`, `python/mod.rs`,
`ruby/mod.rs`, `rust/mod.rs`, `scala/mod.rs`, and `system/mod.rs` are module
wiring, not output filters. `src/cmds/README.md` and the README files in
`cloud`, `dotnet`, `git`, `go`, `js`, `jvm`, `php`, `python`, `ruby`, `rust`,
and `system` are documentation. There is no Scala README at this pin.

## Fidelity and remaining boundaries

This is a port of recognized pure text paths, not the upstream executable.
Execution wrappers, tracker/telemetry, locale/env changes, interactive UI,
filesystem walking, auxiliary reports, tee recovery files and exit-based
fallbacks are intentionally absent. Pure functions requiring unavailable caller
context are either explicit exports above or explicitly listed as unexposed.
They are not described as live operations merely because they are unported.

The following pure-format boundaries remain; complete byte parity is not claimed:

- Strict captured diff omits mbox/Mercurial prose, encoded binary payloads,
  SVN properties, submodule prose and complex/ambiguous quoted GNU facts.
  These inputs remain raw; the detailed list is in [NATIVE-GIT.md](NATIVE-GIT.md).
- Auxiliary TRX and dotnet format reports, non-long ls and unsupported
  custom/JSON2 reporter shapes are not separate
  historical transforms. Their available substitutes and missing context are
  identified in the inventory, not silently replaced by generic truncation.
- Grouped equal-count ordering is deterministic here, unlike upstream hash-map
  iteration. Unicode clipping uses code points where Rust byte-oriented clipping
  could be invalid. ANSI/control normalization belongs primarily to the shared
  facade; explicit PHP cleaning accepts a broader CSI family than its source.
- Decimal rendering uses JavaScript number formatting in several native paths
  (including RSpec duration, PHPT time and displayed sizes). Halfway rounding and
  lexical float/integer distinctions can differ from Rust formatting/serde.
  `filterJson` rejects nonfinite and unsafe integer values instead of silently
  changing large integer identifiers. AWS generic JSON preserves number lexemes
  separately. Exact floating-point formatting parity is not established.
- Source text heuristics and manifest summaries intentionally remain heuristics;
  they do not implement a compiler or full TOML parser. Source display caps and
  omission markers are retained. No external tee filename is fabricated.
- Recognition is deliberately narrower for malformed counters, unsupported
  statuses, incomplete cargo output, conflicting ESLint aggregates, flaky
  Playwright runs and hidden Kubernetes waiting errors. More text may survive
  than upstream. Supported marker-based native summaries do not establish that
  every future CLI diagnostic shape is recognized.

## Verification

Run the pure native tests without invoking any historical commands:

```sh
node --disable-warning=ExperimentalWarning --test test/rtk-native*.test.ts
```

Tests cover each registered family, positive source-derived examples, command
selection, unknown/empty input, malformed structures, diagnostic preservation,
caps, explicit helpers and reviewer regressions. Maven tests include unchanged
upstream raw/expected fixtures; cloud/Git/build provenance and additional
fixture details are in their linked documents. These checks do not authorize or
perform history cleanup, cleanup previews, native deletion tests or live probes.
