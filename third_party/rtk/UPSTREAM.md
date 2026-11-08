# RTK source attribution

`src/vendor/rtk.ts` is a modified TypeScript port of selected Rust filters from [RTK](https://github.com/rtk-ai/rtk), copyright 2026 RTK AI Labs, at commit [`653efb6ed02bd287d686c50e830dd1009356904f`](https://github.com/rtk-ai/rtk/tree/653efb6ed02bd287d686c50e830dd1009356904f).

The imported code is from RTK's **Apache-2.0 CLI `src/` tree**. The upstream license is distributed unchanged as [LICENSE](LICENSE). No separate upstream NOTICE file was found at this revision. This attribution applies to the ported code, not to every part of the RTK repository: no BUSL-1.1 engine or proxy code is included.

## Ported functions

| cc-clean function | Pinned upstream source |
| --- | --- |
| `grep` | [`src/cmds/system/pipe_cmd.rs::grep_wrapper`](https://github.com/rtk-ai/rtk/blob/653efb6ed02bd287d686c50e830dd1009356904f/src/cmds/system/pipe_cmd.rs#L88) |
| `find` | [`src/cmds/system/pipe_cmd.rs::find_wrapper`](https://github.com/rtk-ai/rtk/blob/653efb6ed02bd287d686c50e830dd1009356904f/src/cmds/system/pipe_cmd.rs#L129) |
| `cargoTest` | [`src/cmds/rust/cargo_cmd.rs::AggregatedTestResult`](https://github.com/rtk-ai/rtk/blob/653efb6ed02bd287d686c50e830dd1009356904f/src/cmds/rust/cargo_cmd.rs#L1080) and successful-test filtering |
| `pytest` | [`src/cmds/python/pytest_cmd.rs::build_pytest_summary`](https://github.com/rtk-ai/rtk/blob/653efb6ed02bd287d686c50e830dd1009356904f/src/cmds/python/pytest_cmd.rs#L227), all-passed branch |

## Modifications by cc-clean

- Ported Rust grouping, sorting, truncation and test-summary logic to TypeScript; adapted output labels to plain text.
- Restricted parsing to recognized historical output. Unknown formats, diagnostics, terminal controls and failed tests remain unchanged. Pytest filtering accepts only all-passed summaries.
- Retained the 10 matches/files per group and 20 directory limits. Cargo summaries also retain suite counts, ignored/filtered counts and available durations.
- Require smaller output. The history adapter additionally pairs tool calls/results, checks successful completion, preserves execution metadata, and adds an explicit irreversible-compaction marker.
- Do not execute commands or import RTK's CLI runtime, telemetry, recall storage, engine or proxy. This is a subset, not a complete RTK implementation.

When updating the port, pin the new revision, verify the license of each source file, retain copyright/license/modification notices, and update this mapping and the synthetic filter tests together.
