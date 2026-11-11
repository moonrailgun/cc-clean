// Copyright 2026 RTK AI Labs. Licensed under Apache-2.0.
// Generated TypeScript adaptation by cc-clean; do not edit directly.
// Source: RTK 653efb6ed02bd287d686c50e830dd1009356904f, src/filters/*.toml.
// Regenerate: python3 scripts/import-rtk-rules.py
import type { RtkRuleDefinition } from './rtk-rules.ts';

export const rtkRuleDefinitions: Readonly<Record<string, RtkRuleDefinition>> = {
  "ansible-playbook": {
    "description": "Compact ansible-playbook output",
    "match_command": "^ansible-playbook\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^ok: \\[",
      "^skipping: \\["
    ],
    "max_lines": 60
  },
  "basedpyright": {
    "description": "Compact basedpyright type checker output — strip blank lines, keep errors",
    "match_command": "^basedpyright\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Searching for source files",
      "^Found \\d+ source file",
      "^Pyright \\d+\\.\\d+",
      "^basedpyright \\d+\\.\\d+"
    ],
    "max_lines": 50,
    "on_empty": "basedpyright: ok"
  },
  "biome": {
    "description": "Compact Biome lint/format output — strip blank lines, keep diagnostics",
    "match_command": "^biome\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Checked \\d+ file",
      "^Fixed \\d+ file",
      "^The following command",
      "^Run it with"
    ],
    "max_lines": 50,
    "on_empty": "biome: ok"
  },
  "brew-install": {
    "description": "Compact brew install/upgrade output — strip downloads, short-circuit when already installed",
    "match_command": "^brew\\s+(install|upgrade)\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^==> Downloading",
      "^==> Pouring",
      "^Already downloaded:",
      "^###",
      "^==> Fetching"
    ],
    "match_output": [
      {
        "pattern": "already installed",
        "message": "ok (already installed)"
      }
    ],
    "max_lines": 20
  },
  "bundle-install": {
    "description": "Compact bundle install/update — strip 'Using' lines, keep installs and errors",
    "match_command": "^bundle\\s+(install|update)\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^Using ",
      "^\\s*$",
      "^Fetching gem metadata",
      "^Resolving dependencies"
    ],
    "match_output": [
      {
        "pattern": "Bundle complete!",
        "message": "ok bundle: complete"
      },
      {
        "pattern": "Bundle updated!",
        "message": "ok bundle: updated"
      }
    ],
    "max_lines": 30
  },
  "composer-install": {
    "description": "Compact composer install/update/require output — strip downloads, short-circuit when up-to-date",
    "match_command": "^composer\\s+(install|update|require)\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^  - Downloading ",
      "^  - Installing ",
      "^Loading composer",
      "^Updating dependencies"
    ],
    "match_output": [
      {
        "pattern": "Nothing to install, update or remove",
        "message": "ok (up to date)"
      }
    ],
    "max_lines": 30
  },
  "df": {
    "description": "Compact df output — truncate wide columns, limit rows",
    "match_command": "^df(\\s|$)",
    "strip_ansi": true,
    "truncate_lines_at": 80,
    "max_lines": 20
  },
  "dotnet-build": {
    "description": "Compact dotnet build output — short-circuit on success, strip banners",
    "match_command": "^dotnet\\s+build\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Microsoft \\(R\\)",
      "^Copyright \\(C\\)",
      "^  Determining projects"
    ],
    "match_output": [
      {
        "pattern": "0 Warning\\(s\\)\\n\\s+0 Error\\(s\\)",
        "message": "ok (build succeeded)"
      }
    ],
    "max_lines": 40
  },
  "du": {
    "description": "Compact du output",
    "match_command": "^du\\b",
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "truncate_lines_at": 120,
    "max_lines": 40
  },
  "fail2ban-client": {
    "description": "Compact fail2ban-client output",
    "match_command": "^fail2ban-client\\b",
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "max_lines": 30
  },
  "gcc": {
    "description": "Compact gcc/g++ compiler output — strip notes, keep errors and warnings",
    "match_command": "^g(cc|\\+\\+)\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s+\\|\\s*$",
      "^In file included from",
      "^\\s+from\\s",
      "^\\d+ warnings? generated",
      "^\\d+ errors? generated"
    ],
    "max_lines": 50,
    "on_empty": "gcc: ok"
  },
  "gcloud": {
    "description": "Compact gcloud output",
    "match_command": "^gcloud\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "truncate_lines_at": 120,
    "max_lines": 30
  },
  "hadolint": {
    "description": "Compact hadolint Dockerfile linting output",
    "match_command": "^hadolint\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "truncate_lines_at": 120,
    "max_lines": 40
  },
  "helm": {
    "description": "Compact helm output",
    "match_command": "^helm\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^W\\d{4}"
    ],
    "truncate_lines_at": 120
  },
  "iptables": {
    "description": "Compact iptables output",
    "match_command": "^iptables\\b",
    "strip_lines_matching": [
      "^\\s*$",
      "^Chain DOCKER",
      "^Chain BR-"
    ],
    "max_lines": 50,
    "truncate_lines_at": 120
  },
  "jira": {
    "description": "Compact Jira CLI output — strip verbose metadata, keep essentials",
    "match_command": "^jira\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s*--"
    ],
    "truncate_lines_at": 120,
    "max_lines": 40
  },
  "jj": {
    "description": "Compact Jujutsu (jj) output — strip blank lines, truncate",
    "match_command": "^jj\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Hint:",
      "^Working copy now at:"
    ],
    "max_lines": 30,
    "truncate_lines_at": 120
  },
  "jq": {
    "description": "Compact jq output — truncate large JSON results",
    "match_command": "^jq\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "max_lines": 40,
    "truncate_lines_at": 120
  },
  "just": {
    "description": "Compact just task runner output — strip recipe headers, keep command output",
    "match_command": "^just\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s*Available recipes:",
      "^\\s*just --list"
    ],
    "truncate_lines_at": 150,
    "max_lines": 50
  },
  "liquibase": {
    "description": "Compact liquibase output — strip headers and generic info",
    "match_command": "^liquibase(?:\\s|$)",
    "strip_ansi": true,
    "filter_stderr": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Starting Liquibase at",
      "^Liquibase (?:Community|Open Source)",
      "^Liquibase Home:",
      "^Java Home",
      "^Libraries:",
      "^\\s*-\\s+\\S+\\.jar",
      "^INFO \\[liquibase\\.integration\\]",
      "^INFO \\[liquibase\\.core\\] Reading resource",
      "^INFO \\[liquibase\\.core\\] Parsing",
      "^(?:\\[?INFO\\]?\\s*)?#+$",
      "^\\s*##"
    ],
    "on_empty": "liquibase: ok",
    "max_lines": 200
  },
  "make": {
    "description": "Compact make output",
    "match_command": "^make\\b",
    "strip_lines_matching": [
      "^make\\[\\d+\\]:",
      "^\\s*$",
      "^Nothing to be done"
    ],
    "max_lines": 50,
    "on_empty": "make: ok"
  },
  "markdownlint": {
    "description": "Compact markdownlint output — strip blank lines, limit rows",
    "match_command": "^markdownlint\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "max_lines": 50,
    "truncate_lines_at": 120
  },
  "mise": {
    "description": "Compact mise task runner output — strip status lines, keep task results",
    "match_command": "^mise\\s+(run|exec|install|upgrade)\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^mise\\s+(trust|install|upgrade).*✓",
      "^mise\\s+Installing\\s",
      "^mise\\s+Downloading\\s",
      "^mise\\s+Extracting\\s",
      "^mise\\s+\\w+@[\\d.]+ installed"
    ],
    "truncate_lines_at": 150,
    "max_lines": 50,
    "on_empty": "mise: ok"
  },
  "mix-compile": {
    "description": "Compact mix compile output",
    "match_command": "^mix\\s+compile(\\s|$)",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^Compiling \\d+ file",
      "^\\s*$",
      "^Generated\\s"
    ],
    "max_lines": 40,
    "on_empty": "mix compile: ok"
  },
  "mix-format": {
    "description": "Compact mix format output",
    "match_command": "^mix\\s+format(\\s|$)",
    "on_empty": "mix format: ok",
    "max_lines": 20
  },
  "nx": {
    "description": "Compact Nx monorepo output — strip task graph noise, keep results",
    "match_command": "^(pnpm\\s+)?nx\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s*>\\s*NX\\s+Running target",
      "^\\s*>\\s*NX\\s+Nx read the output",
      "^\\s*>\\s*NX\\s+View logs",
      "^———————",
      "^—————————",
      "^\\s+Nx \\(powered by"
    ],
    "truncate_lines_at": 150,
    "max_lines": 60
  },
  "ollama": {
    "description": "Strip ANSI spinners and cursor control from ollama output, keep final text",
    "match_command": "^ollama\\s+run\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\\s]*$",
      "^\\s*$"
    ]
  },
  "oxlint": {
    "description": "Compact oxlint output — strip blank lines, keep diagnostics",
    "match_command": "^oxlint\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Finished in \\d+",
      "^Found \\d+ warning"
    ],
    "max_lines": 50,
    "on_empty": "oxlint: ok"
  },
  "ping": {
    "description": "Compact ping output — strip per-packet lines, keep summary",
    "match_command": "^ping\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^PING ",
      "^Pinging ",
      "^\\d+ bytes from ",
      "^Reply from .+: bytes=",
      "^\\s*$"
    ],
    "tail_lines": 4
  },
  "pio-run": {
    "description": "Compact PlatformIO build output",
    "match_command": "^pio\\s+run(\\s|$|[;|&()<>])",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Verbose mode",
      "^CONFIGURATION:",
      "^LDF:",
      "^Library Manager:",
      "^Compiling\\s",
      "^Linking\\s",
      "^Building\\s",
      "^Checking size"
    ],
    "max_lines": 30,
    "on_empty": "pio run: ok"
  },
  "poetry-install": {
    "description": "Compact poetry install/lock/update output — strip downloads, short-circuit when up-to-date",
    "match_command": "^poetry\\s+(install|lock|update)\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^  [-•] Downloading ",
      "^  [-•] Installing .* \\(",
      "^Creating virtualenv",
      "^Using virtualenv"
    ],
    "match_output": [
      {
        "pattern": "No dependencies to install or update|No changes\\.",
        "message": "ok (up to date)"
      }
    ],
    "max_lines": 30
  },
  "pre-commit": {
    "description": "Compact pre-commit output",
    "match_command": "^pre-commit\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\[INFO\\] Installing environment",
      "^\\[INFO\\] Once installed this environment will be reused",
      "^\\[INFO\\] This may take a few minutes",
      "^\\s*$"
    ],
    "max_lines": 40
  },
  "ps": {
    "description": "Compact ps output — truncate wide lines, limit rows",
    "match_command": "^ps(\\s|$)",
    "strip_ansi": true,
    "truncate_lines_at": 120,
    "max_lines": 30
  },
  "pulumi-destroy": {
    "description": "Compact Pulumi destroy output",
    "match_command": "^pulumi\\s+destroy(\\s|$)",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Destroying \\(",
      "^Previewing (update|destroy)",
      "^View in Browser",
      "^View Live:",
      "^Duration:",
      "^Permalink:",
      "^\\s*Type\\s+Name\\s+",
      "^Loading policy packs",
      "^@ (Previewing (update|destroy)|Destroying)",
      "^More information at:",
      "^Use `pulumi ",
      "^The resources in the stack have been deleted",
      "^If you want to remove the stack completely",
      "^\\s+-\\s+.*\\bdeleting\\s+\\(",
      "^\\s{4,}at\\s+\\S+\\s*\\(",
      "^\\s{4,}at\\s+/",
      "^\\s+at\\s+processTicksAndRejections",
      "^\\s+promise:\\s+Promise",
      "^\\s+\\[Circular",
      "^\\s*<ref\\s+\\*\\d"
    ],
    "on_empty": "pulumi destroy: nothing to destroy"
  },
  "pulumi-preview": {
    "description": "Compact Pulumi preview output",
    "match_command": "^pulumi\\s+preview(\\s|$)",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Previewing update",
      "^View in Browser",
      "^View Live:",
      "^Duration:",
      "^Permalink:",
      "^\\s*Type\\s+Name\\s+",
      "^Loading policy packs",
      "^@ Previewing update",
      "^More information at:",
      "^Use `pulumi ",
      "^\\s{4,}at\\s+\\S+\\s*\\(",
      "^\\s{4,}at\\s+/",
      "^\\s+at\\s+processTicksAndRejections",
      "^\\s+promise:\\s+Promise",
      "^\\s+\\[Circular",
      "^\\s*<ref\\s+\\*\\d",
      "^\\s+pulumi:pulumi:Stack\\s+\\S+\\s+running\\s*$",
      "^\\s+\\S+\\s+\\S+\\s+\\d+\\s+errors?\\s*$",
      "^\\s+\\S+\\s+\\S+(?:\\s+\\S+)?\\s+\\d+\\s+errors?\\s*$"
    ],
    "on_empty": "pulumi preview: no changes"
  },
  "pulumi-refresh": {
    "description": "Compact Pulumi refresh (state reconciliation) output",
    "match_command": "^pulumi\\s+refresh(\\s|$)",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Refreshing \\(",
      "^Previewing (refresh|update)",
      "^View in Browser",
      "^View Live:",
      "^Duration:",
      "^Permalink:",
      "^\\s*Type\\s+Name\\s+",
      "^Loading policy packs",
      "^@ (Previewing refresh|Refreshing)",
      "^More information at:",
      "^Use `pulumi ",
      "^\\s+.*\\brefreshing\\s+\\(",
      "^\\s+[~+\\-]\\s+[^ ]+\\s+\\S+\\s+refreshing\\s*$",
      "^\\s{4,}at\\s+\\S+\\s*\\(",
      "^\\s{4,}at\\s+/",
      "^\\s+at\\s+processTicksAndRejections",
      "^\\s+promise:\\s+Promise",
      "^\\s+\\[Circular",
      "^\\s*<ref\\s+\\*\\d"
    ],
    "on_empty": "pulumi refresh: no drift"
  },
  "pulumi-stack": {
    "description": "Compact Pulumi stack (ls/output) output",
    "match_command": "^pulumi\\s+stack(\\s+(ls|output|history|select|init|rm|rename|tag|unselect|change-secrets-provider)\\b|\\s*$)",
    "strip_ansi": true,
    "match_output": [
      {
        "pattern": "No stacks found",
        "message": "pulumi stack: empty"
      }
    ],
    "strip_lines_matching": [
      "^\\s*$",
      "^Please choose a stack",
      "^More information at:",
      "^Use `pulumi ",
      "^Current stack outputs \\(0\\):",
      "^\\s+No output values currently"
    ],
    "on_empty": "pulumi stack: ok"
  },
  "pulumi-up": {
    "description": "Compact Pulumi up (apply) output",
    "match_command": "^pulumi\\s+up(\\s|$)",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Updating \\(",
      "^Previewing update",
      "^View in Browser",
      "^View Live:",
      "^Duration:",
      "^Permalink:",
      "^\\s*Type\\s+Name\\s+",
      "^Loading policy packs",
      "^@ (Previewing update|Updating)",
      "^More information at:",
      "^Use `pulumi ",
      "^\\s+\\+\\s+.*\\bcreating\\s+\\(",
      "^\\s+~\\s+.*\\bupdating\\s+\\(",
      "^\\s{4,}at\\s+\\S+\\s*\\(",
      "^\\s{4,}at\\s+/",
      "^\\s+at\\s+processTicksAndRejections",
      "^\\s+promise:\\s+Promise",
      "^\\s+\\[Circular",
      "^\\s*<ref\\s+\\*\\d"
    ],
    "on_empty": "pulumi up: no changes"
  },
  "quarto-render": {
    "description": "Compact quarto render output",
    "match_command": "^quarto\\s+render(\\s|$|[;|&()<>])",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s*processing file:",
      "^\\s*\\d+/\\d+\\s",
      "^\\s*running",
      "^\\s*Rendering",
      "^pandoc ",
      "^  Validating",
      "^  Resolving"
    ],
    "match_output": [
      {
        "pattern": "Output created:",
        "message": "ok (output created)"
      }
    ],
    "max_lines": 20
  },
  "rsync": {
    "description": "Compact rsync output — short-circuit on success, strip progress",
    "match_command": "^rsync\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^sending incremental file list",
      "^sent \\d"
    ],
    "match_output": [
      {
        "pattern": "total size is",
        "message": "ok (synced)",
        "unless": "error|failed|No such file"
      }
    ],
    "max_lines": 20
  },
  "shellcheck": {
    "description": "Compact shellcheck output — strip blank lines, keep caret indicators for error position",
    "match_command": "^shellcheck\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "max_lines": 50
  },
  "shopify-theme": {
    "description": "Compact shopify theme push/pull output",
    "match_command": "^shopify\\s+theme\\s+(push|pull)(\\s|$|[;|&()<>])",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s*Uploading",
      "^\\s*Downloading"
    ],
    "tail_lines": 5,
    "max_lines": 15,
    "on_empty": "shopify theme: ok"
  },
  "skopeo": {
    "description": "Compact skopeo output — truncate large manifests, strip verbosity",
    "match_command": "^skopeo\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Getting image source signatures",
      "^Copying blob",
      "^Copying config",
      "^Writing manifest",
      "^Storing signatures"
    ],
    "max_lines": 30,
    "truncate_lines_at": 120,
    "on_empty": "skopeo: ok"
  },
  "sops": {
    "description": "Compact sops output",
    "match_command": "^sops\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "max_lines": 40
  },
  "spring-boot": {
    "description": "Compact Spring Boot output — strip banner and verbose startup logs, keep key events. Matches gradle bootRun, and java -jar only when the jar filename itself contains \"spring\" (mvn spring-boot:run is routed to RTK's dedicated Maven filter and never reaches this one). Jars using the Maven/Gradle default <artifactId>-<version>.jar name, and jars under a path containing spaces, are deliberately left to full passthrough rather than risk misclassifying an unrelated tool.",
    "match_command": "^(mvn\\s+spring-boot:run|java\\s+-jar\\s+(?:\\S*[/\\\\])?[^/\\\\\\s]*(?i:spring)[^/\\\\\\s]*\\.jar|gradle\\s+.*bootRun)",
    "strip_ansi": true,
    "keep_lines_matching": [
      "Started\\s.*\\sin\\s",
      "Tomcat started on port",
      "ERROR",
      "WARN",
      "Exception",
      "Caused by:",
      "Application run failed",
      "BUILD\\s",
      "Tests run:",
      "FAILURE",
      "listening on port"
    ],
    "max_lines": 30
  },
  "ssh": {
    "description": "Compact ssh output — strip connection banners, keep command output",
    "match_command": "^ssh(?:\\s|$)",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Warning: Permanently added",
      "^Connection to .+ closed",
      "^Authenticated to",
      "^debug1:",
      "^OpenSSH_",
      "^Pseudo-terminal"
    ],
    "max_lines": 200,
    "truncate_lines_at": 120
  },
  "stat": {
    "description": "Compact stat output — strip device/inode/birth noise",
    "match_command": "^stat\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s*Device:",
      "^\\s*Birth:"
    ],
    "truncate_lines_at": 120,
    "max_lines": 20
  },
  "swift-build": {
    "description": "Compact swift build output — short-circuit on success, strip Compiling/Linking",
    "match_command": "^swift\\s+build\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Compiling ",
      "^Linking "
    ],
    "match_output": [
      {
        "pattern": "Build complete!",
        "message": "ok (build complete)",
        "unless": "warning:|error:"
      }
    ],
    "max_lines": 40
  },
  "systemctl-status": {
    "description": "Compact systemctl status output — strip blank lines, limit to 20 lines",
    "match_command": "^systemctl\\s+status\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "max_lines": 20
  },
  "task": {
    "description": "Compact go-task output — strip task headers, keep command results",
    "match_command": "^task\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^task: \\[.*\\] ",
      "^task: Task .* is up to date"
    ],
    "truncate_lines_at": 150,
    "max_lines": 50,
    "on_empty": "task: ok"
  },
  "terraform-plan": {
    "description": "Compact Terraform plan output",
    "match_command": "^terraform\\s+plan(\\s|$|[;|&()<>])",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^Refreshing state",
      "^\\s*#.*unchanged",
      "^\\s*$",
      "^Acquiring state lock",
      "^Releasing state lock"
    ],
    "max_lines": 80,
    "on_empty": "terraform plan: no changes detected"
  },
  "tofu-fmt": {
    "description": "Compact OpenTofu fmt output",
    "match_command": "^tofu\\s+fmt(\\s|$)",
    "strip_ansi": true,
    "on_empty": "tofu fmt: ok (no changes)",
    "max_lines": 30
  },
  "tofu-init": {
    "description": "Compact OpenTofu init output",
    "match_command": "^tofu\\s+init(\\s|$)",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^- Downloading",
      "^- Installing",
      "^- Using previously-installed",
      "^\\s*$",
      "^Initializing provider",
      "^Initializing the backend",
      "^Initializing modules"
    ],
    "max_lines": 20,
    "on_empty": "tofu init: ok"
  },
  "tofu-plan": {
    "description": "Compact OpenTofu plan output",
    "match_command": "^tofu\\s+plan(\\s|$)",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^Refreshing state",
      "^\\s*#.*unchanged",
      "^\\s*$",
      "^Acquiring state lock",
      "^Releasing state lock"
    ],
    "max_lines": 80,
    "on_empty": "tofu plan: no changes detected"
  },
  "tofu-validate": {
    "description": "Compact OpenTofu validate output",
    "match_command": "^tofu\\s+validate(\\s|$)",
    "strip_ansi": true,
    "match_output": [
      {
        "pattern": "Success! The configuration is valid",
        "message": "ok (valid)"
      }
    ]
  },
  "trunk-build": {
    "description": "Compact trunk build output",
    "match_command": "^trunk\\s+build(\\s|$|[;|&()<>])",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s*Compiling\\s",
      "^\\s*Downloading\\s",
      "^\\s*Fetching\\s",
      "^\\s*Fresh\\s",
      "^\\s*Checking\\s"
    ],
    "tail_lines": 10,
    "max_lines": 30,
    "on_empty": "trunk build: ok"
  },
  "turbo": {
    "description": "Compact Turborepo output — strip cache status noise, keep task results",
    "match_command": "^turbo\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s*cache (hit|miss|bypass)",
      "^\\s*\\d+ packages in scope",
      "^\\s*Tasks:\\s+\\d+",
      "^\\s*Duration:\\s+",
      "^\\s*Remote caching (enabled|disabled)"
    ],
    "truncate_lines_at": 150,
    "max_lines": 50,
    "on_empty": "turbo: ok"
  },
  "ty": {
    "description": "Compact ty type checker output — strip blank lines, keep errors",
    "match_command": "^ty\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^Checking \\d+ file",
      "^ty \\d+\\.\\d+"
    ],
    "max_lines": 50,
    "on_empty": "ty: ok"
  },
  "uv-sync": {
    "description": "Compact uv sync/pip install output — strip downloads, short-circuit when up-to-date",
    "match_command": "^uv\\s+(sync|pip\\s+install)\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s+Downloading ",
      "^\\s+Using cached ",
      "^\\s+Preparing "
    ],
    "match_output": [
      {
        "pattern": "Audited \\d+ package",
        "message": "ok (up to date)"
      }
    ],
    "max_lines": 20
  },
  "xcodebuild": {
    "description": "Compact xcodebuild output — strip build phases, keep errors/warnings/summary",
    "match_command": "^xcodebuild\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^CompileC\\s",
      "^CompileSwift\\s",
      "^Ld\\s",
      "^CreateBuildDirectory\\s",
      "^MkDir\\s",
      "^ProcessInfoPlistFile\\s",
      "^CopySwiftLibs\\s",
      "^CodeSign\\s",
      "^Signing Identity:",
      "^RegisterWithLaunchServices",
      "^Validate\\s",
      "^ProcessProductPackaging",
      "^Touch\\s",
      "^LinkStoryboards",
      "^CompileStoryboard",
      "^CompileAssetCatalog",
      "^GenerateDSYMFile",
      "^PhaseScriptExecution",
      "^PBXCp\\s",
      "^SetMode\\s",
      "^SetOwnerAndGroup\\s",
      "^Ditto\\s",
      "^CpResource\\s",
      "^CpHeader\\s",
      "^\\s+cd\\s+/",
      "^\\s+export\\s",
      "^\\s+/Applications/Xcode",
      "^\\s+/usr/bin/",
      "^\\s+builtin-",
      "^note: Using new build system"
    ],
    "max_lines": 60,
    "on_empty": "xcodebuild: ok"
  },
  "yadm": {
    "description": "Compact yadm (git wrapper) output — same filtering as git",
    "match_command": "^yadm\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$",
      "^\\s*\\(use \"git ",
      "^\\s*\\(use \"yadm "
    ],
    "truncate_lines_at": 120,
    "max_lines": 40
  },
  "yamllint": {
    "description": "Compact yamllint output — strip blank lines, limit rows",
    "match_command": "^yamllint\\b",
    "strip_ansi": true,
    "strip_lines_matching": [
      "^\\s*$"
    ],
    "max_lines": 50,
    "truncate_lines_at": 120
  }
};
