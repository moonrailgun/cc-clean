import test from 'node:test';
import assert from 'node:assert/strict';
import { execWrapperCall } from '../src/exec-wrapper.ts';

test('recognizes a single statically printed tool result without running JavaScript', () => {
  for (const source of [
    'text(await tools.exec_command({"cmd":"cargo test","max_output_tokens":1000}));',
    "const result = await tools.exec_command({cmd: 'cargo test', tty: false}); text(result);",
    'let r = await tools.exec_command({cmd: `cargo test`});text(r)',
    '// @exec: {"max_output_tokens": 2000}\nconst r = await tools.exec_command({cmd: "cargo test"}); text(r);',
  ]) assert.deepEqual(execWrapperCall(source), {name: 'exec_command', args: {cmd: 'cargo test', ...(source.includes('max_output_tokens":1000') ? {max_output_tokens: 1000} : source.includes('tty') ? {tty: false} : {})}});
  assert.deepEqual(execWrapperCall('text(await tools.write_stdin({session_id: 12, chars: "", yield_time_ms: 1000}));'),
    {name: 'write_stdin', args: {session_id: 12, chars: '', yield_time_ms: 1000}});
  assert.deepEqual(execWrapperCall("text(await tools.exec_command({cmd: 'rg \\\"hello\\\" src', workdir: '/tmp'}))"),
    {name: 'exec_command', args: {cmd: 'rg "hello" src', workdir: '/tmp'}});
});

test('rejects transformed results, multiple calls, computed inputs and executable syntax', () => {
  for (const source of [
    'const r = await tools.exec_command({cmd:"cargo test"}); text(r.output)',
    'const r = await tools.exec_command({cmd:"cargo test"}); r.exit_code = 0; text(r)',
    'text(await tools.exec_command({cmd: buildCommand()}))',
    'text(await tools.exec_command({cmd: `cargo ${mode}`}))',
    'text(await tools.exec_command({...options, cmd: "cargo test"}))',
    'text(await tools.exec_command({cmd: "cargo test", cmd: "other"}))',
    'text(await tools.exec_command({["cmd"]: "cargo test"}))',
    'text(await tools.exec_command({cmd:"cargo test"})); text("extra")',
    'text(await tools.exec_command({cmd:"cargo test"})); text(await tools.exec_command({cmd:"pytest"}))',
    'const r = await tools.exec_command({cmd:"cargo test"}); text(other)',
    'if (false) text(await tools.exec_command({cmd:"cargo test"}))',
    'text(await tools.exec_command({cmd: "cargo test", value: /regex/}))',
    'text(await tools.exec_command({cmd: "cargo test", value: NaN}))',
    'text(await tools.exec_command({__proto__: {cmd: "cargo test"}}))',
  ]) assert.equal(execWrapperCall(source), undefined, source);
});
