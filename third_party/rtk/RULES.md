# RTK built-in declarative filters

Copyright 2026 RTK AI Labs. The retained TOML files and the adapted filtering
implementation are licensed under Apache-2.0. cc-clean modified the implementation
into pure TypeScript and generated static data for historical output filtering.

The pinned source is RTK 0.49.0, commit
`653efb6ed02bd287d686c50e830dd1009356904f`:
<https://github.com/rtk-ai/rtk/tree/653efb6ed02bd287d686c50e830dd1009356904f>.
That commit contains **62 TOML files, 62 filters, and 151 inline fixtures** under
`src/filters/`. Every file is retained byte-for-byte in `filters/`; none is omitted.

| Local file | Pinned upstream source | Adaptation |
| --- | --- | --- |
| `filters/*.toml` | `src/filters/*.toml`, with identical basenames | Unmodified originals, including inline tests |
| `filters/fixtures.json` | Every `[[tests.*]]` entry in those TOML files | Generated JSON preserving input and expected text |
| `../../src/vendor/rtk-rules-data.ts` | Every `[filters.*]` entry in those TOML files | Generated TypeScript data; no runtime TOML dependency |
| `../../src/vendor/rtk-rules.ts` | `src/core/toml_filter.rs` | Pure eight-stage filter and alphabetical built-in registry |
| `../../src/vendor/rtk-rules.ts` ANSI expression | `text/src/lib.rs`, `strip_ansi` | Same CSI-only expression as the Apache text crate |
| `../../test/rtk-rules.test.ts` | Inline fixtures and `collect_test_outcomes` | Original fixture expectations plus compatibility tests |

## Regeneration and verification

Python 3.11 or later is sufficient. No third-party Python packages or network
access are required. To regenerate from the retained originals:

```sh
python3 scripts/import-rtk-rules.py
python3 scripts/import-rtk-rules.py --check
```

To import from a checkout already pinned to the commit above, or verify that its
originals are byte-identical to the retained files:

```sh
python3 scripts/import-rtk-rules.py --source /path/to/pinned/rtk
python3 scripts/import-rtk-rules.py --check --source /path/to/pinned/rtk
node --disable-warning=ExperimentalWarning --test test/rtk-rules.test.ts
```

The test comparison follows upstream `collect_test_outcomes`: trailing LF
characters are ignored on both sides because TOML multiline strings can end in
a newline. The retained fixtures themselves are unchanged. The separate line
semantics tests assert exact output, including final-delimiter handling.

## Behavior and boundaries

The port applies the same ordered pipeline: optional ANSI removal, replacement
chains, whole-output match/`unless` short circuits, strip-or-keep line filtering,
Unicode code point truncation, head/tail selection, maximum-line limiting, and
the whitespace-only fallback. Registry matching follows the upstream BTreeMap's
alphabetical rule order. Unknown rule names return the original input.

All 400 regex occurrences compile eagerly. Rust Unicode digit, whitespace, word,
and boundary classes, LF-only dot/anchor behavior, scoped case flags, and Rust
capture replacement syntax are translated explicitly. Unsupported regex syntax
throws instead of silently skipping a rule. All syntax used in this pinned
corpus is supported. Node 24 is required, including its scoped regex flags.
Unicode property membership follows the Unicode tables bundled with Node;
future Unicode additions can differ from the pinned Rust regex crate's tables.

JavaScript uses a backtracking regex engine, unlike Rust's linear-time engine.
Callers must bound command length, input size, and individual line length before
calling these functions. The history facade owns those limits and the
terminal-control and byte-savings guards; the port does not silently truncate
inputs to satisfy them. Long whitespace runs in the original Pulumi patterns
and repeated `spring` tokens in the original command pattern require particular
care. Custom patterns are not a supported runtime configuration surface.

There is no loading of user or project configuration, command execution, network
access, telemetry, environment access, or file I/O in the runtime module.
`filter_stderr` is preserved as source metadata; historical text is supplied by
the caller and the module never captures process streams. Original rule quirks
and broad short-circuit behavior are preserved, including existing escaped
patterns; this port does not reinterpret the intent of a TOML expression.
