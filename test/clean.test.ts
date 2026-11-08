import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, symlink, link, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRoot } from '../src/scan.ts';
import { createPlan, executePlan, recoverOperations } from '../src/clean.ts';
import { readStats } from '../src/stats.ts';
import { readCleanupLog } from '../src/history.ts';

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cc-clean-test-')));
  const root = join(base, 'codex'), stateDir = join(base, 'state');
  await mkdir(root); await writeFile(join(root, '.codex-global-state.json'), '{}');
  const path = join(root, '..codex-global-state.json.tmp-old');
  await writeFile(path, 'old temporary state');
  const now = Date.now(); await utimes(path, new Date(now - 73*3600000), new Date(now - 73*3600000));
  return {base, root, stateDir, path, now};
}
const inactive = async () => null;

test('automatic cleanup only plans verified old temporary files and dry-run leaves source intact', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'old-unknown.tmp'), 'protected');
  const plan = await createPlan(await scanRoot(f.root, 'codex'), {now:f.now, version:'0.167.0'});
  assert.equal(plan.actions.length, 1);
  const receipt = await executePlan(plan, {stateDir:f.stateDir, dryRun:true, checkActivity:inactive});
  assert.equal(receipt.confirmedReductionBytes, 0);
  assert.equal(await readFile(f.path, 'utf8'), 'old temporary state');
  assert.equal((await readStats(f.stateDir)).providers.codex.savedBytes, 0);
  await assert.rejects(access(join(f.stateDir,'cleanup.jsonl')),{code:'ENOENT'});
});

test('strict 72-hour boundary and referenced temporary files are protected', async () => {
  const f = await fixture(); await utimes(f.path,new Date(f.now-72*3600000),new Date(f.now-72*3600000));
  assert.equal((await createPlan(await scanRoot(f.root,'codex'),{now:f.now,version:'0.167.0'})).actions.length,0);
  await utimes(f.path,new Date(f.now-74*3600000),new Date(f.now-74*3600000));
  await symlink(f.path,join(f.root,'in-use'));
  assert.equal((await createPlan(await scanRoot(f.root,'codex'),{now:f.now,version:'0.167.0'})).actions.length,0);
});

test('hardlinks and active clients prevent mutation',async()=>{
  const f=await fixture(); await link(f.path,join(f.base,'alias'));
  assert.equal((await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'})).actions.length,0);
  const other=await fixture(); const plan=await createPlan(await scanRoot(other.root,'codex'),{version:'0.167.0'});
  const result=await executePlan(plan,{stateDir:other.stateDir,checkActivity:async()=> 'Client is running'});
  assert.equal(result.confirmedReductionBytes,0); await access(other.path);
});

test('changed fingerprint is skipped and never credited',async()=>{
  const f=await fixture(); const plan=await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'});
  await writeFile(f.path,'changed');
  const result=await executePlan(plan,{stateDir:f.stateDir,checkActivity:inactive});
  assert.equal(result.confirmedReductionBytes,0); assert.equal(await readFile(f.path,'utf8'),'changed');
});

test('both entry points account actual deletion once, partitioned by provider',async()=>{
  for (const source of ['clean','analyze'] as const) {
    const f=await fixture(); const plan=await createPlan(await scanRoot(f.root,'codex'),{source,version:'0.167.0'});
    const result=await executePlan(plan,{stateDir:f.stateDir,checkActivity:inactive});
    assert.equal(result.confirmedReductionBytes,19); await assert.rejects(access(f.path));
    const stats=await readStats(f.stateDir);
    assert.equal(stats.providers.codex.savedBytes,19);
    assert.equal(stats.providers.claude.savedBytes,0);
    assert.equal(stats.providers.codex.cleanedRecords,1);
    const [log]=await readCleanupLog(f.stateDir);
    assert.equal(log.startedAt,result.executionStartedAt);assert.equal(log.finishedAt,result.finishedAt);
    assert.equal(log.beforeBytes,21);assert.equal(log.afterBytes,2);assert.equal(log.savedBytes,19);
    assert.deepEqual(log.cleanupTypes,[{type:'delete-files',cleanedRecords:1}]);
    await recoverOperations(f.stateDir,inactive);
    assert.equal((await readStats(f.stateDir)).providers.codex.savedBytes,19);
  }
});

import { rename, lstat, realpath, unlink } from 'node:fs/promises';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Receipt, Plan } from '../src/clean.ts';
import { atomicJson } from '../src/state.ts';
function pngFixture() {
  const chunk=(type:string,data=Buffer.alloc(0))=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4);return b;};
  const header=Buffer.alloc(13);header.writeUInt32BE(32);header.writeUInt32BE(32,4);header[8]=8;header[9]=6;
  const raw=Buffer.alloc(32*(1+32*4));
  return {raw,input:Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:0})),chunk('IEND')])};
}
async function interruptedReceipt(f:Awaited<ReturnType<typeof fixture>>, plan:Plan) {
  const receipt:Receipt={...plan,executionStartedAt:new Date().toISOString(),status:'needs-review',rootBeforeBytes:21,rootAfterBytes:null,confirmedReductionBytes:0,attributionComplete:false};
  const dir=join(f.stateDir,'providers','codex','work',receipt.operationId,receipt.actions[0].id);
  const path=join(f.stateDir,'providers','codex','operations',receipt.operationId+'.json');
  await mkdir(dir,{recursive:true});
  return {receipt,dir,path};
}
test('lossless PNG execution preserves scanlines, mode and modification time and credits measured reduction',async()=>{
  const f=await fixture(),sample=pngFixture();const path=join(f.root,'generated_images','sample.png');
  await mkdir(join(f.root,'generated_images'));await writeFile(path,sample.input,{mode:0o640});
  const original=await lstat(path);
  const p=await createPlan(await scanRoot(f.root,'codex'),{filePaths:[path],version:'0.167.0'});
  const r=await executePlan(p,{stateDir:f.stateDir,checkActivity:inactive});
  const compressed=await readFile(path),after=await lstat(path);
  assert.equal(r.confirmedReductionBytes,sample.input.length-compressed.length);
  assert.ok(r.confirmedReductionBytes>0,JSON.stringify(r));
  const idat:Buffer[]=[];for(let at=8;at<compressed.length;){const length=compressed.readUInt32BE(at);if(compressed.toString('ascii',at+4,at+8)==='IDAT')idat.push(compressed.subarray(at+8,at+8+length));at+=length+12;}
  assert.deepEqual(inflateSync(Buffer.concat(idat)),sample.raw);
  assert.equal(after.mode&0o777,0o640);assert.ok(Math.abs(after.mtimeMs-original.mtimeMs)<1);
  assert.equal((await readStats(f.stateDir)).providers.codex.savedBytes,r.confirmedReductionBytes);
});
test('prepared deletion recovery restores the original and never credits a move',async()=>{
  const f=await fixture(),p=await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'});
  const {receipt,dir,path}=await interruptedReceipt(f,p);await atomicJson(path,receipt);await rename(f.path,join(dir,'0.original'));
  await recoverOperations(f.stateDir,inactive);
  assert.equal(await readFile(f.path,'utf8'),'old temporary state');
  assert.equal((await readStats(f.stateDir)).providers.codex.savedBytes,0);
});
test('applied deletion recovery finishes cleanup exactly once',async()=>{
  const f=await fixture(),p=await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'});
  const {receipt,dir,path}=await interruptedReceipt(f,p);const a=receipt.actions[0];a.status='completed';a.recoveryState='applied';a.afterBytes=0;receipt.confirmedReductionBytes=a.beforeBytes;
  await rename(f.path,join(dir,'0.original'));await atomicJson(path,receipt);
  await recoverOperations(f.stateDir,inactive);await recoverOperations(f.stateDir,inactive);
  await assert.rejects(access(f.path));await assert.rejects(access(join(dir,'0.original')));
  assert.equal((await readStats(f.stateDir)).providers.codex.savedBytes,0);
  const logs=await readCleanupLog(f.stateDir);assert.equal(logs.length,1);
  assert.equal(logs[0].savedBytes,null);assert.equal(logs[0].cleanedRecords,1);assert.equal(logs[0].needsReview,true);
});
test('recovery preserves an unrelated replacement and original backup for inspection',async()=>{
  const f=await fixture(),p=await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'});
  const {receipt,dir,path}=await interruptedReceipt(f,p);await rename(f.path,join(dir,'0.original'));await writeFile(f.path,'replacement');await atomicJson(path,receipt);
  await recoverOperations(f.stateDir,inactive);
  assert.equal(await readFile(f.path,'utf8'),'replacement');assert.equal(await readFile(join(dir,'0.original'),'utf8'),'old temporary state');
  const stats=await readStats(f.stateDir);assert.equal(stats.providers.codex.pending,1);assert.equal(stats.providers.codex.savedBytes,0);
});
test('replacement source root and symlink work directory cannot redirect mutation or recovery',async()=>{
  const f=await fixture(),p=await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'});
  const original=join(f.base,'original');await rename(f.root,original);await symlink(original,f.root);
  const result=await executePlan(p,{stateDir:f.stateDir,checkActivity:inactive});
  assert.equal(result.confirmedReductionBytes,0);await access(f.path);
});
test('abort stops pending actions without false savings',async()=>{
  const f=await fixture(),p=await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'});
  const controller=new AbortController();controller.abort();
  const r=await executePlan(p,{stateDir:f.stateDir,signal:controller.signal,checkActivity:inactive});
  assert.equal(r.status,'interrupted');assert.equal(r.confirmedReductionBytes,0);await access(f.path);
});

import { recompressPng } from '../src/png.ts';
async function pngTransaction() {
  const f=await fixture(),sample=pngFixture(),image=join(f.root,'generated_images','test.png');
  await mkdir(join(f.root,'generated_images'));await writeFile(image,sample.input);
  const plan=await createPlan(await scanRoot(f.root,'codex'),{filePaths:[image],version:'0.167.0'});
  const tx=await interruptedReceipt(f,plan),a=tx.receipt.actions[0],compressed=(await recompressPng(sample.input))!;
  a.beforeHash=createHash('sha256').update(sample.input).digest('hex');a.afterHash=createHash('sha256').update(compressed).digest('hex');a.afterBytes=compressed.length;
  await link(image,join(tx.dir,'0.original'));await writeFile(join(tx.dir,'output'),compressed);await atomicJson(tx.path,tx.receipt);
  return {...tx,f,sample,image,compressed};
}
test('PNG recovery before replacement removes the transaction link and preserves original bytes',async()=>{
  const t=await pngTransaction();await recoverOperations(t.f.stateDir,inactive);
  assert.deepEqual(await readFile(t.image),t.sample.input);assert.equal((await lstat(t.image)).nlink,1);
  assert.equal((await readStats(t.f.stateDir)).providers.codex.pending,1);
  assert.equal((await readStats(t.f.stateDir)).providers.codex.savedBytes,0);
});
test('PNG recovery finalizes once without inventing a missing end snapshot',async()=>{
  const t=await pngTransaction();await rename(join(t.dir,'output'),t.image);
  await recoverOperations(t.f.stateDir,inactive);await recoverOperations(t.f.stateDir,inactive);
  assert.deepEqual(await readFile(t.image),t.compressed);await assert.rejects(access(join(t.dir,'0.original')));
  assert.equal((await readStats(t.f.stateDir)).providers.codex.savedBytes,0);
  const logs=await readCleanupLog(t.f.stateDir);assert.equal(logs.length,1);
  assert.equal(logs[0].afterBytes,null);assert.equal(logs[0].cleanedRecords,1);
});
test('prepared recovery with missing source and backup remains pending',async()=>{
  const f=await fixture(),p=await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'}),t=await interruptedReceipt(f,p);
  await atomicJson(t.path,t.receipt);await unlink(f.path);await recoverOperations(f.stateDir,inactive);
  assert.equal((await readStats(f.stateDir)).providers.codex.pending,1);
});
test('applied deletion recovery retains backup when the source root is replaced',async()=>{
  const f=await fixture(),p=await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'}),t=await interruptedReceipt(f,p),a=t.receipt.actions[0];
  await rename(f.path,join(t.dir,'0.original'));a.status='completed';a.recoveryState='applied';a.afterBytes=0;t.receipt.confirmedReductionBytes=a.beforeBytes;await atomicJson(t.path,t.receipt);
  await rename(f.root,join(f.base,'old-root'));await mkdir(f.root);await recoverOperations(f.stateDir,inactive);
  assert.equal(await readFile(join(t.dir,'0.original'),'utf8'),'old temporary state');
  const stats=await readStats(f.stateDir);assert.equal(stats.providers.codex.pending,1);assert.equal(stats.providers.codex.savedBytes,0);
});
test('transaction directory symlink cannot redirect recovery',async()=>{
  const f=await fixture(),p=await createPlan(await scanRoot(f.root,'codex'),{version:'0.167.0'}),t=await interruptedReceipt(f,p);
  await rename(f.path,join(t.dir,'0.original'));await atomicJson(t.path,t.receipt);
  const external=join(f.base,'external');await rename(t.dir,external);await symlink(external,t.dir);await recoverOperations(f.stateDir,inactive);
  assert.equal(await readFile(join(external,'0.original'),'utf8'),'old temporary state');assert.equal((await readStats(f.stateDir)).providers.codex.pending,1);
});

import { DatabaseSync } from 'node:sqlite';
import { analyze } from '../src/analyze.ts';
const sessionIds=['12345678-1234-1234-1234-123456789001','12345678-1234-1234-1234-123456789002','12345678-1234-1234-1234-123456789003'];
async function nativePlanFixture() {
  const f=await fixture();await mkdir(join(f.root,'sessions'));
  const db=new DatabaseSync(join(f.root,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT)');
  for(const id of sessionIds){const path=join(f.root,'sessions',id+'.jsonl');await writeFile(path,JSON.stringify({type:'session_meta',payload:{id,cwd:'/project',cli_version:'0.167.0'}})+'\n');await utimes(path,new Date(f.now-73*3600000),new Date(f.now-73*3600000));db.prepare('INSERT INTO threads VALUES(?,?,?,0)').run(id,path,'/project');}
  db.close();const inventory=await scanRoot(f.root,'codex'),analysis=await analyze(inventory,{deep:true});
  return {...f,inventory,analysis};
}
test('native deletion rejects changed index relationships before invoking Codex',async()=>{
  const f=await nativePlanFixture(),p=await createPlan(f.inventory,{version:'0.167.0',source:'analyze',sessions:f.analysis.sessions,sessionIds:[sessionIds[0]]});
  const db=new DatabaseSync(join(f.root,'state_5.sqlite'));db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(sessionIds[0],sessionIds[1]);db.close();
  const r=await executePlan(p,{stateDir:f.stateDir,checkActivity:inactive});
  assert.equal(r.confirmedReductionBytes,0);assert.equal(r.actions[0].nativeStarted,undefined);assert.match(r.actions[0].reason!,/deletion scope changed/);
  for(const id of sessionIds)await access(join(f.root,'sessions',id+'.jsonl'));
});
test('planning rejects a new spawn edge added after analysis instead of binding the stale scope',async()=>{
  const f=await nativePlanFixture();
  const db=new DatabaseSync(join(f.root,'state_5.sqlite'));db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(sessionIds[0],sessionIds[1]);db.close();
  await assert.rejects(createPlan(f.inventory,{version:'0.167.0',sessions:f.analysis.sessions,sessionIds:[sessionIds[0]]}),/deletion scope changed/);
  for(const id of sessionIds)await access(join(f.root,'sessions',id+'.jsonl'));
});
test('planning rejects a changed parent even when all descendants remain selected',async()=>{
  const f=await nativePlanFixture();
  const db=new DatabaseSync(join(f.root,'state_5.sqlite'));db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(sessionIds[0],sessionIds[1]);db.close();
  await assert.rejects(createPlan(f.inventory,{version:'0.167.0',sessions:f.analysis.sessions,sessionIds:sessionIds.slice(0,2)}),/deletion scope changed/);
});
test('native deletion rechecks the exact action closure immediately before launch',async()=>{
  const f=await nativePlanFixture();
  const db=new DatabaseSync(join(f.root,'state_5.sqlite'));db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(sessionIds[0],sessionIds[1]);db.close();
  const analysis=await analyze(f.inventory,{deep:true});
  const plan=await createPlan(f.inventory,{version:'0.167.0',sessions:analysis.sessions,sessionIds:[sessionIds[0]]});
  plan.actions[0].sessionIds=[sessionIds[0]];plan.actions[0].files=plan.actions[0].files.filter(file=>file.path.endsWith(sessionIds[0]+'.jsonl'));
  const receipt=await executePlan(plan,{stateDir:f.stateDir,checkActivity:inactive});
  assert.equal(receipt.actions[0].nativeStarted,undefined);assert.match(receipt.actions[0].reason!,/deletion scope changed/);
  assert.equal(receipt.confirmedReductionBytes,0);
});
test('an unpreviewed compressed rollout prevents planning and execution',async()=>{
  const f=await nativePlanFixture(),options={version:'0.167.0',sessions:f.analysis.sessions,sessionIds:[sessionIds[0]]};
  const plan=await createPlan(f.inventory,options);
  await writeFile(join(f.root,'sessions',sessionIds[0]+'.jsonl.zst'),'unvalidated compressed fixture');
  await assert.rejects(createPlan(await scanRoot(f.root,'codex'),options),/Compressed sessions/);
  const receipt=await executePlan(plan,{stateDir:f.stateDir,checkActivity:inactive});
  assert.equal(receipt.actions[0].nativeStarted,undefined);assert.match(receipt.actions[0].reason!,/Compressed sessions/);
});
test('native postchecks reject unrelated index and file changes, allowing measured startup maintenance only',async t=>{
  const scenarios=[
    {name:'changed survivor metadata',code:`db.prepare('UPDATE threads SET cwd=? WHERE id=?').run('/changed',${JSON.stringify(sessionIds[1])});`},
    {name:'new thread',code:`db.prepare('INSERT INTO threads VALUES(?,?,?,0)').run('66666666-6666-4666-8666-666666666666',root+'/new.jsonl','/new');`},
    {name:'changed unrelated file',code:`fs.writeFileSync(root+'/protected.txt','changed');`},
    {name:'removed unrelated file',code:`fs.unlinkSync(root+'/protected.txt');`},
    {name:'new unrelated file',code:`fs.writeFileSync(root+'/unexpected.txt','new');`},
    {name:'known native maintenance',code:`fs.mkdirSync(root+'/log',{recursive:true});fs.writeFileSync(root+'/log/codex.log','startup');`,allowed:true},
  ];
  for(const scenario of scenarios)await t.test(scenario.name,async()=>{
    const f=await nativePlanFixture();await writeFile(join(f.root,'protected.txt'),'unchanged');
    const survivor=await readFile(join(f.root,'sessions',sessionIds[1]+'.jsonl'),'utf8');
    const plan=await createPlan(f.inventory,{version:'0.167.0',sessions:f.analysis.sessions,sessionIds:[sessionIds[0]]});
    const bin=join(f.base,'bin');await mkdir(bin);
    await writeFile(join(bin,'codex'),`#!${process.execPath}
const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');
if(process.argv[2]==='--version'){console.log('codex-cli 0.167.0');process.exit(0);}
const root=process.env.CODEX_HOME;const id=process.argv[3];
const db=new DatabaseSync(root+'/state_5.sqlite');
fs.unlinkSync(root+'/sessions/'+id+'.jsonl');db.prepare('DELETE FROM threads WHERE id=?').run(id);
${scenario.code}
db.close();
`,{mode:0o700});
    const previous=process.env.PATH;process.env.PATH=bin+':'+previous;
    try {
      const receipt=await executePlan(plan,{stateDir:f.stateDir,checkActivity:inactive});
      assert.equal(receipt.actions[0].nativeStarted,true);
      if(scenario.allowed){assert.equal(receipt.status,'completed');assert.equal(receipt.confirmedReductionBytes,receipt.rootBeforeBytes!-receipt.rootAfterBytes!);}
      else {assert.equal(receipt.status,'needs-review');assert.equal(receipt.attributionComplete,false);assert.equal(receipt.confirmedReductionBytes,0);}
      assert.equal(await readFile(join(f.root,'sessions',sessionIds[1]+'.jsonl'),'utf8'),survivor);
    } finally {if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
  });
});
test('a cycle cannot be hidden by another valid selected native root',async()=>{
  const f=await nativePlanFixture();f.analysis.sessions.find(s=>s.id===sessionIds[1])!.parentId=sessionIds[2];f.analysis.sessions.find(s=>s.id===sessionIds[2])!.parentId=sessionIds[1];
  await assert.rejects(createPlan(f.inventory,{version:'0.167.0',sessions:f.analysis.sessions,sessionIds}),/cycle/);
});
test('Claude deletion groups subagent files and preserves project memory and history',async()=>{
  const f=await fixture(),id=sessionIds[0],root=join(f.base,'claude'),project=join(root,'projects','p');
  await mkdir(join(project,id,'subagents'),{recursive:true});await mkdir(join(project,id,'tool-results'));await mkdir(join(project,'memory'));
  const record={type:'user',sessionId:id,cwd:'/project',version:'2.1.319',uuid:'u1',message:{role:'user',content:'synthetic'}};
  await writeFile(join(project,id+'.jsonl'),JSON.stringify(record)+'\n');
  await writeFile(join(project,id,'subagents','agent-child.jsonl'),JSON.stringify({...record,agentId:'child',isSidechain:true})+'\n');
  await writeFile(join(project,id,'tool-results','output.txt'),'owned output');await writeFile(join(project,'memory','MEMORY.md'),'retained memory');await writeFile(join(root,'history.jsonl'),'retained history');
  for(const path of [join(project,id+'.jsonl'),join(project,id,'subagents','agent-child.jsonl'),join(project,id,'tool-results','output.txt')])await utimes(path,new Date(f.now-73*3600000),new Date(f.now-73*3600000));
  const inv=await scanRoot(root,'claude'),analysis=await analyze(inv,{deep:true});
  const p=await createPlan(inv,{source:'analyze',sessions:analysis.sessions,sessionIds:[id]}),r=await executePlan(p,{stateDir:f.stateDir,checkActivity:inactive});
  assert.ok(r.confirmedReductionBytes>0);assert.deepEqual(new Set(p.actions[0].sessionIds),new Set([id,'child']));
  await assert.rejects(access(join(project,id+'.jsonl')));await assert.rejects(access(join(project,id,'subagents','agent-child.jsonl')));
  assert.equal(await readFile(join(project,'memory','MEMORY.md'),'utf8'),'retained memory');assert.equal(await readFile(join(root,'history.jsonl'),'utf8'),'retained history');
  assert.equal((await readStats(f.stateDir)).providers.claude.savedBytes,r.confirmedReductionBytes);
});
