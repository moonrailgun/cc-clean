# RTK historical-output port

This directory records the source and scope of cc-clean's modified TypeScript
port of the Apache-2.0 RTK CLI filters. Copyright 2026 RTK AI Labs and RTK
contributors. The retained license is [Apache License 2.0](LICENSE).

The upstream snapshot is **RTK 0.49.0**, commit
[`653efb6ed02bd287d686c50e830dd1009356904f`](https://github.com/rtk-ai/rtk/tree/653efb6ed02bd287d686c50e830dd1009356904f).
Source paths in the inventories refer to that immutable snapshot. The port uses
the Apache-2.0 CLI and text helpers; it does not contain the separately licensed
BUSL engine/proxy.

## Source and coverage inventory

| Inventory | Coverage |
| --- | --- |
| [Pipe filters](PIPE.md) | Every upstream pipe group: 23 groups, 28 names including aliases |
| [Declarative filters](RULES.md) | All 62 built-in TOML filters, original files and 151 inline fixtures |
| [Native filters and helpers](NATIVE.md) | Native registry, language/system/container filters and explicit-context helpers |
| [Git](NATIVE-GIT.md) | Native Git command families and strict diff helpers |
| [Gradle and .NET](NATIVE-BUILD.md) | Build, test, lint, dependencies and restore text |
| [Maven](NATIVE-MAVEN.md) | Maven and daemon test, compile, package and quiet modes |
| [AWS and forge CLIs](NATIVE-CLOUD.md) | 48 AWS, GitHub, GitLab and Graphite formatters |

`src/vendor/rtk.ts` exposes command matching and historical-text filtering.
`rtk-pipe.ts`, `rtk-rules.ts` and `rtk-native.ts` provide the implementations.
Individual inventories name the upstream functions, retained fixtures, supported
formats and intentional differences. Helpers needing extra source-language,
stream, command or formatting context are exported separately; they are not
automatically applied to arbitrary historical stdout.

## History integration

Quick clean enables shell-output compaction through the shared history-slimming
path. The same implementation serves the explicit compact-tools option. It
recognizes literal shell commands, supported command wrappers and unambiguous
execution-session polling without executing the recorded code. Only completed,
successful output is eligible. Unknown or conflicting completion metadata,
failed commands and ambiguous session attribution preserve the original output.

The adapter replaces only recognized output spans, retaining call IDs, unknown
metadata, record formatting and untouched JSON number lexemes. A visible marker
states that omitted content is unavailable. A rewrite requires net UTF-8 byte
savings including that marker. Existing age, active-session, dependent-history
and SQLite coordination checks continue to govern any actual history mutation.

The shared facade rejects output over 1 MiB, commands over 4,096 characters,
declarative-rule lines over 4,096 characters and unsafe terminal controls. ANSI
SGR colors and CRLF can be normalized only as part of an actual filtered result.
Unsupported schemas and formats pass through. Format-specific requirements
matter: JSON, porcelain and RTK-delimited filters cannot reconstruct information
that the original command did not record.

## Deliberate boundaries

This is a port of historical-text transformations, not an RTK command runner.
It does not execute commands, force machine-output flags, query Git or services,
inspect source files, read external reports or binary build artifacts, load
custom RTK filters, retain tee/recall files, install hooks, or emit telemetry.
Functions that need those unavailable inputs are listed in the inventories.
Passthrough commands remain passthrough. Exact byte parity for every producer
version, locale and output variant is not claimed: schema validation and
diagnostic retention deliberately preserve more history than upstream in some
cases.

The `kubeServices` port in `rtk-native-container.ts` retains named Kubernetes
`targetPort` mappings (for example, `80→http`), defaulting to the service port
only when the target is omitted. Unsupported target types preserve the raw output.

## Verification

```sh
npm run test:read-only
npm run typecheck
npm run build
python3 scripts/import-rtk-rules.py --check
```

The checks use synthetic buffers and retained upstream fixtures. They do not
establish real-history cleanup or native-client continuation compatibility.
No cleanup or cleanup preview is needed to verify this port. See
[native compatibility evidence](../../docs/native-compatibility.md) for the
distinction between this port's tests and earlier prerequisite evidence.
