# AWS and forge formatter port

Copyright 2026 RTK AI Labs. Licensed under Apache-2.0. cc-clean modified these
formatters into pure TypeScript with schema checks and conservative fallbacks.
The source is RTK 0.49.0 at commit
`653efb6ed02bd287d686c50e830dd1009356904f`.

`src/vendor/rtk-native-cloud.ts` exports 48 formatters and their argv matcher.
Every formatter has a positive synthetic fixture derived from the pinned source.
These functions consume existing text; they never execute AWS, GitHub, GitLab,
Graphite, Git, network requests, credential lookup, or telemetry. They never write
tee files, read configuration, or infer success from an unavailable exit code.

## Complete mapping

All paths below are relative to the pinned upstream repository. Source line
numbers identify formatter definitions, not the command execution wrappers.

| Exported filter | Upstream source |
| --- | --- |
| `aws-sts-identity` | `src/cmds/cloud/aws_cmd.rs:473`, `filter_sts_identity` |
| `aws-s3-ls` | `aws_cmd.rs:480`, `filter_s3_ls` |
| `aws-ec2-instances` | `aws_cmd.rs:497`, `filter_ec2_instances` |
| `aws-ecs-list-services` | `aws_cmd.rs:557`, `filter_ecs_list_services` |
| `aws-ecs-describe-services` | `aws_cmd.rs:577`, `filter_ecs_describe_services` |
| `aws-rds-instances` | `aws_cmd.rs:604`, `filter_rds_instances` |
| `aws-cfn-list-stacks` | `aws_cmd.rs:633`, `filter_cfn_list_stacks` |
| `aws-cfn-describe-stacks` | `aws_cmd.rs:658`, `filter_cfn_describe_stacks` |
| `aws-logs-events` | `aws_cmd.rs:711`, `filter_logs_events`; get/filter aliases |
| `aws-cfn-events` | `aws_cmd.rs:763`, `filter_cfn_events` |
| `aws-lambda-list` | `aws_cmd.rs:826`, `filter_lambda_list` |
| `aws-lambda-get` | `aws_cmd.rs:855`, `filter_lambda_get` |
| `aws-iam-roles` | `aws_cmd.rs:946`, `filter_iam_roles`; principal helper at 904 |
| `aws-iam-users` | `aws_cmd.rs:985`, `filter_iam_users` |
| `aws-dynamodb-items` | `aws_cmd.rs:1094`, `filter_dynamodb_items`; typed helper at 1012; scan/query aliases |
| `aws-ecs-tasks` | `aws_cmd.rs:1136`, `filter_ecs_tasks` |
| `aws-security-groups` | `aws_cmd.rs:1239`, `filter_security_groups`; rule helper at 1192 |
| `aws-s3-objects` | `aws_cmd.rs:1285`, `filter_s3_objects` |
| `aws-eks-cluster` | `aws_cmd.rs:1312`, `filter_eks_cluster` |
| `aws-sqs-messages` | `aws_cmd.rs:1329`, `filter_sqs_messages` |
| `aws-dynamodb-get-item` | `aws_cmd.rs:1355`, `filter_dynamodb_get_item` |
| `aws-logs-query-results` | `aws_cmd.rs:1381`, `filter_logs_query_results` |
| `aws-s3-transfer` | `aws_cmd.rs:1432`, `filter_s3_transfer`; sync/cp aliases |
| `aws-secrets-get` | `aws_cmd.rs:1503`, `filter_secrets_get` |
| `aws-json` | `aws_cmd.rs:206`, `is_structured_operation`; generic JSON path at 221 |
| `gh-pr-list` | `src/cmds/git/gh_cmd.rs:352`, `format_pr_list` |
| `gh-pr-view` | `gh_cmd.rs:457`, `format_pr_view` |
| `gh-pr-checks` | `gh_cmd.rs:559`, `format_pr_checks` |
| `gh-pr-status` | `gh_cmd.rs:667`, `format_pr_status`; entry helper at 693 |
| `gh-issue-list` | `gh_cmd.rs:751`, `format_issue_list` |
| `gh-issue-view` | `gh_cmd.rs:817`, `format_issue_view` |
| `gh-run-list` | `gh_cmd.rs:878`, `format_run_list` |
| `gh-run-view` | `gh_cmd.rs:945`, `format_run_view` |
| `gh-repo-view` | `gh_cmd.rs:993`, `format_repo_view` |
| `glab-mr-list` | `src/cmds/git/glab_cmd.rs:426`, `format_mr_list` |
| `glab-mr-view` | `glab_cmd.rs:476`, `format_mr_view` |
| `glab-issue-list` | `glab_cmd.rs:663`, `format_issue_list` |
| `glab-issue-view` | `glab_cmd.rs:716`, `format_issue_view` |
| `glab-ci-list` | `glab_cmd.rs:795`, `format_ci_list` |
| `glab-ci-status` | `glab_cmd.rs:844`, `format_ci_status` |
| `glab-ci-trace` | `glab_cmd.rs:915`, `filter_ci_trace` |
| `glab-release-list` | `glab_cmd.rs:981`, `format_release_list` |
| `glab-release-view` | `glab_cmd.rs:1064`, `filter_release_view` |
| `gt-log` | `src/cmds/git/gt_cmd.rs:188`, `filter_gt_log_entries` |
| `gt-submit` | `gt_cmd.rs:219`, `filter_gt_submit` |
| `gt-sync` | `gt_cmd.rs:278`, `filter_gt_sync` |
| `gt-restack` | `gt_cmd.rs:333`, `filter_gt_restack` |
| `gt-create` | `gt_cmd.rs:354`, `filter_gt_create` |

Shared Markdown filtering derives from `gh_cmd.rs:31` and the corresponding
GitLab implementation. ARN suffixes, byte sizes, dates and confirmation wording
derive from `src/core/utils.rs`; list caps derive from `src/core/truncate.rs`.

## Historical-output adaptations

- Every structured record is validated before selecting a display cap. Required
  fields, known optional fields and nested objects used in the summary have
  explicit schemas. Unknown fields or malformed records return the original
  input. Recognized API metadata listed through `ignored(...)` is intentionally
  omitted like upstream; its internal schema is not interpreted. This includes
  EC2 networking metadata, GitLab timestamps and IAM policy conditions.
- Unrecognized formats and empty render results preserve input byte-for-byte.
  JSON-only formatters do not guess at human-readable CLI output. Commands with
  explicit output/query/template/web/comments flags bypass matching. Common
  global repository, profile and region options are recognized. Unknown leading
  options fail open; this matcher is not a complete CLI grammar.
- Generic AWS JSON compaction removes only JSON whitespace. Numeric lexemes,
  string escapes and duplicate object keys remain unchanged. DynamoDB numeric
  strings retain every digit without a JavaScript number round-trip. Invalid or
  unrecognized DynamoDB types and excessive nesting fail open. Structured
  summaries reject unsafe integer JSON values.
- CloudFormation in-progress or unrecognized event states remain raw. Every
  failure/rollback reason is retained, including beyond the upstream cap. Stack
  summaries retain status reasons. ECS partial API failures remain raw. List
  summaries with recognized failure text beyond the display cap remain raw.
  S3 transfers retain every error and reject unknown lines.
- Pagination is explicitly reported for recognized generic tokens and DynamoDB
  continuation keys. Nonempty S3 continuation tokens and common prefixes remain
  raw. CloudWatch's forward/backward log tokens are recognized response metadata;
  their presence alone does not assert another page exists.
- GitHub reviews support both the upstream `reviews.nodes` shape and the CLI's
  array shape. Check failures include timeout/action-required/error states.
  GitHub PR status includes `needsReview`, overflow counts and changes requested;
  it does not silently omit those sections. Unknown TSV check statuses retain
  their literal row. Watching checks keeps the latest name/link row as upstream.
- Workflow text requires recognizable status/job sections and retains unknown
  job text. GitLab trace filtering preserves errors in otherwise disposable
  runner/artifact lines. GitLab status gives failure precedence over success on
  a mixed line. Releases add an overflow count. Release views containing code
  fences remain raw, preventing accidental deletion inside examples.
- Markdown chooses the earliest backtick or tilde fence and preserves unclosed
  fences, correcting the upstream backtick-first search. Graphite log filtering
  also removes angle brackets surrounding a removed email address. Graphite
  confirmations require complete recognized success lines; unknown output never
  becomes an invented success confirmation.
- Tee hints are omitted because there is no retained external tee file. Command
  labels and a workflow run identifier unavailable to the input-only callback
  are omitted. The parent facade enforces terminal controls, input bounds and
  byte savings; these functions do not mutate a history record themselves.

## Other upstream entrypoints

AWS's generic mutation/passthrough paths, command capture and exit-code handling
have no pure historical equivalent. `gh api` and `glab api` preserve output.
`gh pr create`, `glab mr create` and GitLab MR action confirmations depend on a
successful execution wrapper; this module does not infer those outcomes.
`gh pr merge` is passthrough upstream. GitHub PR diff and GitLab MR diff delegate
to the separate Git diff formatter; non-diff format flags must remain raw.
GitLab CI view is an interactive TUI and is not matched.

Graphite short log and branch are identity filters upstream. Graphite's Git
delegations (status/diff/show/add/push/pull/fetch/stash/worktree) belong to the
separate Git registry. All remaining commands in these four families pass through.

## Verification

```sh
node --disable-warning=ExperimentalWarning --test test/rtk-native-cloud.test.ts
```

The 60 pure tests cover all 48 exports, the registry inventory, unknown and
malformed input, nested schemas, failure retention, pagination, exact numbers,
Markdown fences, check watching, global options and custom-output bypasses. No
AWS/forge executable, credentials, live service or cleanup command is invoked.
