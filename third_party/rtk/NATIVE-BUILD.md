# Gradle and .NET historical text filters

Source: RTK 0.49.0, commit `653efb6ed02bd287d686c50e830dd1009356904f`, Apache-2.0.

| Source | Ported entrypoints |
| --- | --- |
| `src/cmds/jvm/gradlew_cmd.rs` | build, test, connected tests, lint context, dependency summaries, task detection |
| `src/cmds/dotnet/binlog.rs` | build/test/restore text diagnostics, deduplication, counts, duration, environment redaction |
| `src/cmds/dotnet/dotnet_cmd.rs` | build/test/restore issue formatting and output caps |

The fixtures under `fixtures/gradlew_*` and `fixtures/dotnet/` are unchanged
upstream test inputs. Tests exercise success, failure diagnostics, context,
dependency caps, unknown formats, redaction, and matcher selection.

Historical output cannot recreate binary MSBuild binlogs, TRX files, or
`dotnet format` JSON report files. These file readers and execution wrappers
are excluded. Binary diagnostic recovery is likewise excluded: this adapter
accepts text output only and rejects terminal control bytes at the shared boundary.
No temporary report files, binaries or historical commands are executed.

Unknown structures pass through. Gradle build filtering requires a build footer;
.NET requires recognized status/summary text. Failed tests with missing details
pass through. Forged huge diagnostic counts are rejected instead of allocated.
History rewriting additionally requires a completed, successful execution and
net byte savings including the irreversible-compaction marker.
