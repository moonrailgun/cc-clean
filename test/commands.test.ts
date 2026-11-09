import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSchema, help, parseCommand, UsageError } from '../src/commands.ts';

// Parser-only checks: these never plan or execute cleanup.
const id = '12345678-1234-1234-1234-123456789abc';
test('noninteractive cleanup requires explicit confirmation or preview', () => {
  for (const flags of [[], ['--json'], ['--no-interactive']]) {
    assert.throws(() => parseCommand(['clean', ...flags], false), UsageError);
  }
  assert.equal(parseCommand(['clean', '--yes', '--json'], true).interactive, false);
  assert.equal(parseCommand(['clean', '--dry-run'], false).values['dry-run'], true);
  assert.equal(parseCommand(['clean'], true).interactive, true);
  assert.equal(parseCommand(['clean', '--yes'], true).interactive, true);
  assert.throws(() => parseCommand(['clean', '--no-interactive'], true), /--yes/);
});
test('explicit file lists require a single provider and absolute paths', () => {
  const parsed = parseCommand(['clean', '--provider', 'codex', '--file', '/tmp/a b.png', '--file', '/tmp/unicode-图片.png', '--yes'], false);
  assert.deepEqual(parsed.values.file, ['/tmp/a b.png', '/tmp/unicode-图片.png']);
  for (const args of [
    ['clean', '--file', '/tmp/a', '--yes'],
    ['clean', '--provider', 'codex', '--file', './a', '--yes'],
    ['analyze', 'delete', '--provider', 'codex', '--file', '/tmp/a', '--session', id, '--yes'],
  ]) assert.throws(() => parseCommand(args, false), UsageError);
  assert.equal(parseCommand(['analyze', 'delete', '--provider', 'codex', '--file', '/tmp/a', '--dry-run'], false).deleting, true);
});
test('history flags are independent clean-only opt-ins and keep confirmation requirements', () => {
  const quick = parseCommand(['clean'], true);
  assert.equal(quick.values['remove-images'], undefined);
  assert.equal(quick.values['compact-tools'], undefined);
  assert.equal(quick.values['remove-reasoning'], undefined);
  assert.equal(quick.values['remove-request-archives'], undefined);
  assert.throws(() => parseCommand(['clean', '--provider', 'claude', '--remove-reasoning', '--yes'], false), /Codex/);
  for (const flag of ['--remove-request-archives']) {
    assert.throws(() => parseCommand(['clean', '--provider', 'codex', flag, '--yes'], false), /Claude/);
    assert.throws(() => parseCommand(['clean', '--temp-only', flag, '--yes'], false), /--temp-only/);
    assert.equal(parseCommand(['clean', '--provider', 'claude', flag, '--yes'], false).provider, 'claude');
    assert.ok(commandSchema.commands[0].options.includes(flag.slice(2)));
    assert.ok(help.includes(flag));
  }
  for (const flags of [['--remove-images'], ['--compact-tools'], ['--remove-reasoning'], ['--remove-request-archives'], ['--remove-images', '--compact-tools', '--remove-reasoning', '--remove-request-archives']]) {
    assert.throws(() => parseCommand(['clean', ...flags, '--json'], true), /--yes/);
    const parsed = parseCommand(['clean', ...flags, '--yes', '--json'], true);
    assert.equal(parsed.interactive, false);
    for (const flag of flags) assert.equal(parsed.values[flag.slice(2) as keyof typeof parsed.values], true);
    assert.equal(parseCommand(['clean', ...flags, '--yes'], true).interactive, true);
    assert.equal(parseCommand(['clean', ...flags, '--dry-run'], false).values['dry-run'], true);
    for (const command of [['analyze'], ['stats'], ['analyze', 'delete', '--provider', 'claude', '--session', id, '--yes']])
      assert.throws(() => parseCommand([...command, ...flags], true), /require clean/);
  }
});
test('deletion requires explicit UUIDs or file paths with valid command-specific flags', () => {
  assert.deepEqual(parseCommand(['analyze', 'delete', '--provider', 'claude', '--session', id, '--session', id, '--yes'], false).values.session, [id, id]);
  for (const args of [
    ['analyze', 'delete', '--yes'],
    ['analyze', 'delete', '--provider', 'claude', '--yes'],
    ['analyze', 'delete', '--provider', 'claude', '--session', '../file', '--yes'],
    ['stats', '--yes'], ['analyze', '--dry-run'], ['stats', '--file', '/tmp/a'],
    ['analyze', '--session', id], ['clean', '--view', 'usage', '--yes'],
    ['analyze', 'delete', '--provider', 'claude', '--session', id, '--view', 'sessions', '--yes'],
  ]) assert.throws(() => parseCommand(args, false), UsageError);
});
test('read-only commands can disable interaction even in a terminal', () => {
  assert.equal(parseCommand(['analyze', '--no-interactive'], true).interactive, false);
  assert.equal(parseCommand(['stats', '--json'], true).interactive, false);
  assert.equal(parseCommand(['--json'], true).command, undefined);
  assert.equal(parseCommand(['analyze', '--view', 'sessions', '--project', '/tmp/project'], false).values.project, '/tmp/project');
  for (const args of [
    ['analyze', '--provider', 'unknown'], ['analyze', '--view', 'unknown'],
    ['analyze', '--project', '/tmp/project'], ['analyze', '--view', 'sessions', '--project', './relative'],
    ['analyze', 'unexpected'], ['unknown'], ['--provider', 'codex'],
  ]) assert.throws(() => parseCommand(args, false), UsageError);
});
test('machine discovery describes all commands and published flags in English', () => {
  assert.equal(commandSchema.ageProtection.hours, 72);
  assert.match(commandSchema.ageProtection.basis, /modification time; strictly older/);
  assert.match(commandSchema.ageProtection.exception, /--yes and multi-selection do not bypass/);
  assert.match(help, /Multiple selections and --yes do not bypass it/);
  assert.deepEqual(commandSchema.commands.map(item => item.command), ['clean', 'analyze', 'analyze delete', 'stats']);
  for (const command of commandSchema.commands) for (const option of command.options) assert.ok(option in commandSchema.options, option);
  assert.equal(/\p{Script=Han}/u.test(help + JSON.stringify(commandSchema)), false);
  assert.equal(parseCommand(['--help', '--json'], false).values.help, true);
  assert.equal(parseCommand(['--version', '--json'], false).values.version, true);
});

test('temporary-only cleanup is discoverable, exclusive and requires normal confirmation', () => {
  assert.ok(commandSchema.commands[0].options.includes('temp-only'));
  assert.match(help, /--temp-only/);
  assert.equal(parseCommand(['clean', '--temp-only'], true).interactive, true);
  assert.equal(parseCommand(['clean', '--temp-only', '--yes'], true).interactive, true);
  assert.equal(parseCommand(['clean', '--temp-only', '--yes', '--json'], true).interactive, false);
  assert.equal(parseCommand(['clean', '--temp-only', '--dry-run'], false).values['temp-only'], true);
  assert.throws(() => parseCommand(['clean', '--temp-only', '--json'], true), /--yes/);
  for (const args of [['analyze'], ['stats'], ['clean', '--remove-images'], ['clean', '--compact-tools'],
    ['clean', '--remove-reasoning'], ['clean', '--provider', 'codex', '--file', '/tmp/report.md']])
    assert.throws(() => parseCommand([...args, '--temp-only', '--yes'], false), /--temp-only/);
});
