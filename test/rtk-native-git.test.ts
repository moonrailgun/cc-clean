// Copyright 2026 RTK AI Labs. Apache-2.0; modified by cc-clean.
// Synthetic fixtures from pinned git_cmd.rs and diff_cmd.rs pure transforms.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gitNativeFilters, matchGitNativeFilter } from '../src/vendor/rtk-native-git.ts';

const patch = 'diff --git a/src/a.ts b/src/a.ts\nindex 1234567..abcdef0 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n tail\n';
const compact = '[file] src/a.ts (+1 -1)\n-old\n+new';
const cases: [string, string[], string, string][] = [
  ['git-branch', ['git','branch','-a'], '* main\n  feature\n  remotes/origin/HEAD -> origin/main\n  remotes/origin/main\n  remotes/origin/release\n  remotes/upstream/release\n', '* main\n  feature\n  remote-only (1):\n    release'],
  ['git-stash-list', ['git','stash','list'], 'stash@{0}: WIP on main: abc1234 work\nstash@{1}: On feature: custom message\n', 'stash@{0}: abc1234 work\nstash@{1}: custom message'],
  ['git-stash-show', ['git','stash','show'], ' weird|name.txt | 3 +++\n image.png | Bin 0 -> 123 bytes\n 2 files changed, 3 insertions(+)\n', 'weird|name.txt 3 +\nimage.png (binary)\n2 changed 3 +'],
  ['git-stash-show', ['git','stash','show','-p'], patch, compact],
  ['git-stash-action', ['git','stash','push'], 'Saved working directory and index state WIP on main: abc1234 Work\n', 'ok stashed'],
  ['git-worktree-list', ['git','worktree','list'], '/tmp/path with spaces    abc1234 [main]\n/tmp/other    def5678 (detached HEAD)\n', '/tmp/path with spaces abc1234 [main]\n/tmp/other def5678 (detached HEAD)'],
  ['git-ls-tree', ['git','ls-tree','-r','--name-only','HEAD'], 'src/lib/one.ts\nsrc/lib/two.ts\n', 'src/lib/ one.ts two.ts\n'],
  ['git-show', ['git','show','HEAD'], 'commit abc1234\nAuthor: A <a@example.com>\nDate: today\n\n    Subject\n\n' + patch, 'commit abc1234\nAuthor: A <a@example.com>\nDate: today\n\n    Subject\n\n' + compact],
  ['git-commit', ['git','commit','-m','msg'], '[main abc123456789] message\n 1 file changed, 2 insertions(+)\n create mode 100644 a.ts\n', 'ok abc1234'],
  ['git-checkout', ['git','checkout','-b','feature'], "Switched to a new branch 'feature'\n", 'ok feature (new)'],
  ['git-checkout', ['git','switch','main'], "Already on 'main'\n", 'ok main'],
  ['git-checkout', ['git','restore','a.ts'], "Updated 1 path from the index\n", 'ok updated 1 path from the index'],
  ['git-push', ['git','push'], 'Enumerating objects: 4, done.\nCounting objects: 100% (4/4), done.\nTo github.com:owner/repo.git\n   abc1234..def5678  main -> main\n', 'To github.com:owner/repo.git\n   abc1234..def5678  main -> main'],
  ['git-fetch', ['git','fetch'], 'Enumerating objects: 4, done.\nFrom github.com:owner/repo\n * [new branch]      feature -> origin/feature\n', 'From github.com:owner/repo\n * [new branch]      feature -> origin/feature'],
  ['git-pull', ['git','pull'], 'Already up to date.\n', 'ok (up-to-date)'],
  ['git-pull', ['git','pull'], 'Updating abc1234..def5678\nFast-forward\n a.ts | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n', 'ok 1 files +2 -1'],
  ['diff-stdin', ['diff'], patch, compact],
];
for (const [name, argv, input, expected] of cases) test(name + ' ' + argv.join(' '), () => {
  assert.equal(matchGitNativeFilter(argv), name);
  assert.equal(gitNativeFilters[name](input), expected);
});

test('every formatter preserves empty, arbitrary, and failure output', () => {
  for (const [name, filter] of Object.entries(gitNativeFilters)) {
    for (const input of ['', 'unknown message\r\n', 'fatal: operation failed\n', '{"unknown":true}\n']) assert.equal(filter(input), input, name);
  }
});
test('custom formats and ambiguous commands do not match', () => {
  for (const args of [
    ['git','branch','-vv'], ['git','branch','--format=%(refname)'], ['git','branch','-d','feature'],
    ['git','stash','list','--format=%s'], ['git','stash','show','--name-only'], ['git','stash','pop'],
    ['git','worktree','list','--porcelain'], ['git','worktree','prune'], ['git','ls-tree','HEAD'],
    ['git','ls-tree','-z','--name-only','HEAD'], ['git','show','HEAD:a.ts'], ['git','show','--word-diff'],
    ['git','show','--format=%B'], ['git','show','--stat'], ['git','commit','--dry-run'],
    ['git','-c','alias.show=other','show'], ['diff','--side-by-side','a','b'],
  ]) assert.equal(matchGitNativeFilter(args), undefined, args.join(' '));
});
test('all tail lines are checked before summarizing confirmation or stats', () => {
  for (const [name, , input] of cases.filter(([name]) => !['git-push','git-fetch','git-ls-tree'].includes(name))) {
    const full = input + 'fatal: later failure\n';
    assert.equal(gitNativeFilters[name](full), full, name);
  }
  const hook = 'hook emitted important output\n[main abc123456] message\n';
  assert.equal(gitNativeFilters['git-commit'](hook), hook);
});
test('push and fetch keep remote warnings and rejected updates', () => {
  const input = 'Enumerating objects: 10, done.\nremote: security alert\n ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs\n';
  const expected = 'remote: security alert\n ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs';
  assert.equal(gitNativeFilters['git-push'](input), expected);
  assert.equal(gitNativeFilters['git-fetch'](input), expected);
  assert.equal(gitNativeFilters['git-push']('Counting objects: 100% (4/4), done.\n'), 'Counting objects: 100% (4/4), done.\n');
});
test('folded path runs preserve order, quoted paths, and non-saving input', () => {
  const input = 'src/long/a.ts\nsrc/long/b.ts\nspace name.ts\nsrc/long/c.ts\nsrc/long/d.ts\n';
  assert.equal(gitNativeFilters['git-ls-tree'](input), 'src/long/ a.ts b.ts\n"space name.ts"\nsrc/long/ c.ts d.ts\n');
  for (const raw of ['a\nb\n', 'src/a\nsrc/b', 'src/\nother/\n', 'src/a\n\nsrc/b\n']) assert.equal(gitNativeFilters['git-ls-tree'](raw), raw);
});
test('stash stat and branch validate records beyond their display limits', () => {
  const stats = Array.from({length:30}, (_,i)=>` file${i}.ts | 1 +`).join('\n') + '\nunknown metadata\n';
  assert.equal(gitNativeFilters['git-stash-show'](stats), stats);
  const branches = '* main\n' + Array.from({length:20},(_,i)=>`  remotes/origin/r${i}\n`).join('');
  assert.match(gitNativeFilters['git-branch'](branches), /remote-only \(20\)[\s\S]*\.\.\. \+10 more/);
  assert.equal(gitNativeFilters['git-branch'](branches + 'unknown metadata\n'), branches + 'unknown metadata\n');
});
test('strict unified parser rejects truncation, overrun, context-only, and unknown prose', () => {
  for (const input of [patch.replace(' tail\n',''),patch + '+lost\n',patch.replace('-old\n+new\n',' same\n'),patch+'unknown warning\n', 'diff --git a/a b/a\n', '--- a/a\n+++ b/a\n', '@@ -1 +1 @@\n-old\n+new\n']) {
    assert.equal(gitNativeFilters['diff-stdin'](input), input);
  }
});
test('strict parser preserves changed lines and newline annotations', () => {
  const input = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
  assert.equal(gitNativeFilters['diff-stdin'](input), '[file] a.txt (+1 -1)\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file');
});
test('combined hunk budgets account for each parent separately', () => {
  const input = 'diff --cc a.txt\nindex 1111111,2222222..3333333\n--- a/a.txt\n+++ b/a.txt\n@@@ -1,2 -1,2 +1,2 @@@\n  context\n- old1\n -old2\n++new\n';
  assert.equal(gitNativeFilters['diff-stdin'](input), '[file] a.txt (+1 -2)\n- old1\n -old2\n++new');
  assert.equal(gitNativeFilters['diff-stdin'](input.replace(' -old2\n','')), input.replace(' -old2\n',''));
});
test('rename, copy, mode, empty files, and binary facts retain their meaning', () => {
  const input = 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\ndiff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\ndiff --git a/image.png b/image.png\nindex 1111111..2222222 100644\nBinary files a/image.png and b/image.png differ\n';
  assert.equal(gitNativeFilters['diff-stdin'](input), '[file] new.txt (renamed from old.txt)\n[file] empty (new file)\n[file] image.png (binary)');
});
test('header names preserve GNU directory roots and spaced Git paths', () => {
  const input = 'diff -ru old/a.txt new/a.txt\n--- old/a.txt\t2026-11-10 10:00:00 +0800\n+++ new/a.txt\t2026-11-10 10:01:00 +0800\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(gitNativeFilters['diff-stdin'](input), '[file] new/a.txt (+1 -1)\n-a\n+b');
  const spaces = patch.replaceAll('src/a.ts','src/a file.ts');
  assert.equal(gitNativeFilters['diff-stdin'](spaces), compact.replace('src/a.ts','src/a file.ts'));
});
test('unsafe counts and unsupported producer formats stay byte-identical', () => {
  for (const input of [patch.replace('-1,3','-1,9007199254740993'), 'Index: a\nProperty changes on: a\n## -1 +1 ##\n-x\n+y\n', 'From abc1234 Mon Sep 17 00:00:00 2001\nSubject: patch\n\n'+patch, 'Only in ambiguous: dir: file\n', 'diff --git a/a b/a\nGIT binary patch\nliteral 1\nabc\n']) assert.equal(gitNativeFilters['diff-stdin'](input), input);
});
test('diagnostics appended to path lists and unknown progress prefixes survive', () => {
  const paths = 'src/long/a.ts\nsrc/long/b.ts\nfatal: cannot read tree\n';
  assert.equal(gitNativeFilters['git-ls-tree'](paths), paths);
  const transfer = 'Counting objects: unknown extension metadata\nTo server\n';
  assert.equal(gitNativeFilters['git-push'](transfer), transfer);
});
test('compaction never guesses a path split with excessive ambiguous spaces', () => {
  const input = patch.replaceAll('src/a.ts', 'src/' + 'a '.repeat(80) + 'file.ts');
  assert.equal(gitNativeFilters['diff-stdin'](input), input);
});
test('copy and mode changes retain independent annotations', () => {
  const input = 'diff --git a/a b/b\nsimilarity index 100%\ncopy from a\ncopy to b\nold mode 100644\nnew mode 100755\n';
  assert.equal(gitNativeFilters['diff-stdin'](input), '[file] b (copied from a, mode changed)');
  const incomplete = 'diff --git a/a b/a\nold mode 100644\n';
  assert.equal(gitNativeFilters['diff-stdin'](incomplete), incomplete);
});
test('standalone facts and SVN unified text have complete schemas', () => {
  const facts = 'Only in old: a.txt\nFiles old/b and new/b differ\nBinary files old/c and new/c differ\n';
  assert.equal(gitNativeFilters['diff-stdin'](facts), '[file] old/a.txt (only in one side)\n[file] new/b (differs)\n[file] new/c (binary)');
  const svn = 'Index: path/a.txt\n===================================================================\n--- path/a.txt\t(revision 1)\n+++ path/a.txt\t(working copy)\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(gitNativeFilters['diff-stdin'](svn), '[file] path/a.txt (+1 -1)\n-a\n+b');
});
