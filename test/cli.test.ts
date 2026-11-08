import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,writeFile,readFile,realpath,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { validateReceipt } from '../src/state.ts';
const exec=promisify(execFile);const cli=resolve('src/cli.ts');
async function envFixture(){const home=await mkdtemp(join(tmpdir(),'cc-clean-cli-'));return {...process.env,HOME:home,CODEX_HOME:join(home,'codex'),CLAUDE_CONFIG_DIR:join(home,'claude')};}
async function run(args:string[],env:NodeJS.ProcessEnv){try{const r=await exec(process.execPath,['--disable-warning=ExperimentalWarning',cli,...args],{env,timeout:20000});return {...r,code:0};}catch(e){const r=e as {stdout:string;stderr:string;code:number};return r;}}
test('help and bare non-TTY usage do not create application state',async()=>{const env=await envFixture();const r=await run(['--help'],env);assert.equal(r.code,0);assert.match(r.stdout,/cc-clean analyze/);assert.equal((await run([],env)).code,0);});
test('JSON analysis is one clean object and absent providers are explicit',async()=>{const env=await envFixture();const r=await run(['analyze','--json'],env);assert.equal(r.code,0,r.stderr);const data=JSON.parse(r.stdout);assert.equal(data.schemaVersion,1);assert.equal(data.reports.length,2);assert.equal(data.reports[0].totalBytes,0);});
test('unknown flags and noninteractive delete without confirmation fail before mutation',async()=>{const env=await envFixture();assert.equal((await run(['clean','--force'],env)).code,2);const r=await run(['analyze','delete','--provider','codex','--session','12345678-1234-1234-1234-123456789abc'],env);assert.equal(r.code,2);assert.match(r.stderr,/--yes/);});
test('JSON stats separates providers and dry-run never earns savings',async()=>{const env=await envFixture();await mkdir(env.CODEX_HOME!);await writeFile(join(env.CODEX_HOME!,'.codex-global-state.json'),'{}');const dry=await run(['clean','--provider','codex','--dry-run','--json'],env);assert.equal(dry.code,0,dry.stderr);assert.equal(JSON.parse(dry.stdout).receipts[0].status,'dry-run');const r=await run(['stats','--json'],env);assert.equal(JSON.parse(r.stdout).providers.codex.savedBytes,0);});

async function claudeFixture(t:test.TestContext) {
  const env=await envFixture();
  t.after(()=>rm(env.HOME!,{recursive:true,force:true}));
  const rootId='12345678-1234-1234-1234-123456789abc', childId='a1b2c3d4e5f6';
  const project=join(env.HOME!,'project'), otherProject=join(env.HOME!,'other-project');
  await mkdir(project); await mkdir(otherProject);
  const paths={
    root:join(env.CLAUDE_CONFIG_DIR!,'projects','-synthetic',rootId+'.jsonl'),
    child:join(env.CLAUDE_CONFIG_DIR!,'projects','-synthetic',rootId,'subagents','agent-'+childId+'.jsonl'),
    tool:join(env.CLAUDE_CONFIG_DIR!,'projects','-synthetic',rootId,'tool-results','result.txt'),
    memory:join(env.CLAUDE_CONFIG_DIR!,'projects','-synthetic','memory','MEMORY.md'),
    other:join(env.CLAUDE_CONFIG_DIR!,'projects','-other','87654321-4321-4321-4321-cba987654321.jsonl'),
  };
  const record=(sessionId:string,cwd:string,agentId?:string)=>JSON.stringify({type:'user',sessionId,cwd,agentId,version:'2.1.319',timestamp:'2026-11-01T10:00:00.000Z',message:{role:'user',content:'synthetic'}})+'\n';
  const contents={root:record(rootId,project),child:record(rootId,project,childId),tool:'owned tool result',memory:'retained project memory',other:record('87654321-4321-4321-4321-cba987654321',otherProject)};
  for(const name of Object.keys(paths) as (keyof typeof paths)[]){await mkdir(dirname(paths[name]),{recursive:true});await writeFile(paths[name],contents[name]);}
  return {env,rootId,childId,project,paths,contents};
}

test('Claude deletion dry-run expands non-UUID subagents and owned tool results while retaining memory',async t=>{
  const f=await claudeFixture(t);
  const result=await run(['analyze','delete','--provider','claude','--session',f.rootId,'--dry-run','--json'],f.env);
  assert.equal(result.code,0,result.stderr);
  const receipt=JSON.parse(result.stdout).receipts[0];
  assert.equal(receipt.status,'dry-run');
  assert.equal(receipt.confirmedReductionBytes,0);
  assert.equal(receipt.actions.length,1);
  assert.ok(receipt.warnings.some((warning:string)=>warning.includes('memory')&&warning.includes('history.jsonl')));
  const action=receipt.actions[0];
  assert.deepEqual(new Set(action.sessionIds),new Set([f.rootId,f.childId]));
  const expected=await Promise.all([f.paths.root,f.paths.child,f.paths.tool].map(path=>realpath(path)));
  assert.deepEqual(new Set(action.files.map((file:{path:string})=>file.path)),new Set(expected));
  assert.equal(action.beforeBytes,Buffer.byteLength(f.contents.root+f.contents.child+f.contents.tool));
  assert.equal(action.status,'planned');
  for(const name of Object.keys(f.paths) as (keyof typeof f.paths)[])assert.equal(await readFile(f.paths[name],'utf8'),f.contents[name]);
  assert.equal(validateReceipt(receipt,'claude'),receipt);
});

test('session project filtering resolves a symlink to its canonical project directory',async t=>{
  const f=await claudeFixture(t), alias=join(f.env.HOME!,'project-alias');
  await symlink(f.project,alias);
  const result=await run(['analyze','--provider','claude','--view','sessions','--project',alias,'--json'],f.env);
  assert.equal(result.code,0,result.stderr);
  const sessions=JSON.parse(result.stdout).reports[0].sessions;
  assert.deepEqual(new Set(sessions.map((session:{id:string})=>session.id)),new Set([f.rootId,f.childId]));
  for(const session of sessions)assert.equal(session.project,await realpath(f.project));
});
