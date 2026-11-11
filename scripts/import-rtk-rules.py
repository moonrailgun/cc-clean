#!/usr/bin/env python3
"""Regenerate pinned RTK rules without runtime TOML or third-party dependencies."""

import argparse
import json
from pathlib import Path
import shutil
import tomllib

ROOT = Path(__file__).resolve().parents[1]
PIN = "653efb6ed02bd287d686c50e830dd1009356904f"
RETAINED = ROOT / "third_party/rtk/filters"
HEADER = f"""// Copyright 2026 RTK AI Labs. Licensed under Apache-2.0.
// Generated TypeScript adaptation by cc-clean; do not edit directly.
// Source: RTK {PIN}, src/filters/*.toml.
// Regenerate: python3 scripts/import-rtk-rules.py
import type {{ RtkRuleDefinition }} from './rtk-rules.ts';

"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Pinned upstream checkout; copies its original TOML files")
    parser.add_argument("--check", action="store_true", help="Check generated files without changing files")
    args = parser.parse_args()
    source = args.source / "src/filters" if args.source else RETAINED
    files = sorted(source.glob("*.toml"))
    if not files:
        parser.error(f"No TOML rules found in {source}")
    definitions = {}
    fixtures = []
    for path in files:
        parsed = tomllib.loads(path.read_text(encoding="utf-8"))
        if set(parsed) - {"filters", "tests"}:
            parser.error(f"Unexpected top-level fields in {path.name}")
        for name, definition in parsed["filters"].items():
            if name in definitions:
                parser.error(f"Duplicate rule: {name}")
            definitions[name] = definition
        for name, tests in parsed.get("tests", {}).items():
            fixtures.extend({"filter": name, **fixture} for fixture in tests)
    if set(definitions) != {fixture["filter"] for fixture in fixtures}:
        parser.error("Each rule must have inline fixtures, and each fixture must reference a rule")
    encode = lambda value: json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    outputs = {
        ROOT / "src/vendor/rtk-rules-data.ts": HEADER
        + "export const rtkRuleDefinitions: Readonly<Record<string, RtkRuleDefinition>> = "
        + encode(dict(sorted(definitions.items()))).rstrip() + ";\n",
        RETAINED / "fixtures.json": encode(sorted(fixtures, key=lambda fixture: fixture["filter"])),
    }
    if args.check:
        for path, content in outputs.items():
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                parser.exit(1, f"Generated file differs: {path.relative_to(ROOT)}\n")
        if args.source:
            for path in files:
                retained = RETAINED / path.name
                if not retained.exists() or retained.read_bytes() != path.read_bytes():
                    parser.exit(1, f"Retained source differs: {path.name}\n")
    else:
        RETAINED.mkdir(parents=True, exist_ok=True)
        if args.source:
            for path in files:
                shutil.copyfile(path, RETAINED / path.name)
        for path, content in outputs.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
    print(f"{'Verified' if args.check else 'Generated'} {len(files)} TOML files, {len(definitions)} rules, {len(fixtures)} fixtures ({PIN})")


if __name__ == "__main__":
    main()
