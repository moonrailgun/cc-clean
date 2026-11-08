import { open, lstat, realpath, rename, unlink, link, readdir, statfs } from 'node:fs/promises';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import type { FileEntry, Inventory, Provider, ScanProgress, Session } from './types.ts';
import { scanRoot } from './scan.ts';
import { privateDir, atomicJson, jsonFiles, within, existingDir, readOrdinaryFile } from './state.ts';
import { recompressPng, MAX_PNG_BYTES } from './png.ts';
import { checkActivity as defaultActivity, type ActivityCheck } from './activity.ts';
import { deleteCodexSession } from './codex-delete.ts';
import { validateReceipt } from './state.ts';
import { readCodexIndex, type IndexThread } from './providers/codex.ts';
import { readCleanupLog, recordCleanup } from './history.ts';
import { slimHistory, assertLegacyCodexMeta, MAX_HISTORY_BYTES, type SlimOptions, type SlimCounts } from './slim.ts';
const exec=promisify(execFile);
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface Action {
  id:string;kind:'delete-files'|'compress-png'|'codex-delete'|'slim-history';targetId:string;files:FileEntry[];
  slimOptions?:SlimOptions;slimCounts?:SlimCounts;
  sessionIds?:string[];status:'planned'|'completed'|'skipped'|'failed';reason?:string;
  beforeBytes:number;afterBytes:number;recoveryState:'prepared'|'applied'|'finalized';
  estimatedSavingsBytes?:number|null;
  beforeHash?:string;afterHash?:string;nativeStarted?:boolean;
}
export interface Plan {
  schemaVersion:1;operationId:string;provider:Provider;root:string;version:string;
  source:'clean'|'analyze';startedAt:string;actions:Action[];warnings:string[];scanComplete:boolean;
  rootIdentity?:{dev:number;ino:number};codexIndexFingerprint?:string;
  explicitTarget?:string;
}
export interface Receipt extends Plan {
  status:'completed'|'partial'|'failed'|'interrupted'|'needs-review'|'dry-run';
  rootBeforeBytes:number|null;rootAfterBytes:number|null;confirmedReductionBytes:number;
  attributionComplete:boolean;executionStartedAt?:string;finishedAt?:string;
}
interface PlanOptions {now?:number;version?:string;source?:'clean'|'analyze';filePaths?:string[];deleteImages?:boolean;sessions?:Session[];sessionIds?:string[];otherRoots?:string[];slim?:SlimOptions}
export function singleSelectedTarget(options:Pick<PlanOptions,'filePaths'|'sessionIds'>):string|undefined {
  const targets=[...new Set([...(options.filePaths??[]),...(options.sessionIds??[])])];
  return targets.length===1?targets[0]:undefined;
}
export function ageProtectionReason(action:Action,explicitTarget?:string,now=Date.now()):string|null {
  if(action.kind==='compress-png')return null;
  // Descendants are additional targets, even when only the parent was selected.
  const single=explicitTarget&&(action.sessionIds
    ? action.sessionIds.length===1&&action.sessionIds[0]===explicitTarget
    : action.files.length===1&&action.files[0].path===explicitTarget);
  if(single)return null;
  const recent=action.files.find(f=>!Number.isFinite(now)||!Number.isFinite(f.mtimeMs)||now-f.mtimeMs<=72*3600000);
  return recent?`72-hour protection: ${recent.path}; all files in a bulk destructive operation must have a valid modification time more than 72 hours ago. Entire operation retained.`:null;
}
export function protectRecentContent(plan:Plan,now=Date.now()):Plan {
  plan.actions=plan.actions.filter(action=>{
    const reason=ageProtectionReason(action,plan.explicitTarget,now);
    if(reason)plan.warnings.push(reason);
    return !reason;
  });
  return plan;
}
const replacement=(kind:Action['kind'])=>kind==='compress-png'||kind==='slim-history';
function same(entry:FileEntry,s:Awaited<ReturnType<typeof lstat>>) {return s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.dev===entry.dev&&s.ino===entry.ino&&s.size===entry.size&&s.mtimeMs===entry.mtimeMs&&s.ctimeMs===entry.ctimeMs;}
function referenced(inv:Inventory,path:string) {return inv.links.some(l=>{const target=isAbsolute(l.target)?resolve(l.target):resolve(dirname(l.path),l.target);return path===target||within(target,path)||within(path,target);});}
function makeAction(kind:Action['kind'],id:string,files:FileEntry[],sessionIds?:string[]):Action {
  const bytes=files.reduce((n,f)=>n+f.size,0);
  return {id:randomUUID(),kind,targetId:id,files,sessionIds,status:'planned',beforeBytes:bytes,afterBytes:bytes,estimatedSavingsBytes:replacement(kind)?null:bytes,recoveryState:'prepared'};
}

// Legacy rollouts can be referenced by another thread's byte offsets. Inspect
// every header, not just selected files, and refuse materialized/shared layouts.
export async function verifyCodexRewriteLayout(inv:Inventory,signal?:AbortSignal) {
  if(!inv.complete||process.env.CODEX_SQLITE_HOME)throw new Error('Codex rewrite requires a complete scan and default SQLite location');
  const protectedPath=(path:string)=>/^(?:(?:sessions|archived_sessions)(?:\/|$)|config\.toml$|thread_history_.*\.sqlite)/.test(path);
  if(inv.links.some(l=>protectedPath(relative(inv.root,l.path)))||inv.files.some(f=>/^thread_history_.*\.sqlite/.test(f.relative)||/^(?:sessions|archived_sessions)\/.*\.jsonl\.zst$/.test(f.relative)))
    throw new Error('Linked, compressed or materialized Codex history cannot be rewritten');
  const config=inv.files.find(f=>f.relative==='config.toml');
  if(config) {
    if(config.size>64*1024)throw new Error('Codex config exceeds the rewrite inspection limit');
    const text=(await readVerified(inv.root,config)).toString('utf8');
    // Fail closed on custom/escaped TOML keys instead of guessing SQLite location.
    if(/sqlite|\\|^\s*["']/im.test(text))throw new Error('Custom or unrecognized Codex SQLite configuration cannot be rewritten');
  }
  for(const f of inv.files.filter(f=>f.category==='sessions')) {
    signal?.throwIfAborted();
    await verifyFile(inv.root,f);
    const handle=await open(f.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      if(!same(f,await handle.stat()))throw new Error('Codex history changed before header inspection');
      const buffer=Buffer.alloc(Math.min(f.size,1024*1024));
      let length=0,newline=-1;
      while(length<buffer.length&&newline<0) {
        const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);
        if(!bytesRead)break;
        length+=bytesRead;newline=buffer.subarray(0,length).indexOf(10);
      }
      if(newline<0&&length<f.size)throw new Error('Codex history header exceeds the inspection limit');
      assertLegacyCodexMeta(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,newline<0?length:newline))));
      if(!same(f,await handle.stat()))throw new Error('Codex history changed during header inspection');
    } finally {await handle.close();}
    await verifyFile(inv.root,f);
  }
}
function verifyCodexScope(action:Action,threads:IndexThread[],inventory:Inventory,sessions?:Session[]) {
  // Native deletion also removes compressed siblings; these have not been analyzed.
  if(inventory.files.some(f=>/^(?:sessions|archived_sessions)\/.*\.jsonl\.zst$/.test(f.relative)))throw new Error('Compressed sessions are unsupported; native deletion scope cannot be verified');
  const byId=new Map(threads.map(t=>[t.id,t]));
  const closure=new Set([action.targetId]);let changed=true;
  while(changed){changed=false;for(const thread of threads)if(thread.parentId&&closure.has(thread.parentId)&&!closure.has(thread.id)){closure.add(thread.id);changed=true;}}
  const planned=new Set(action.sessionIds);
  if(!byId.has(action.targetId)||planned.size!==closure.size||[...closure].some(id=>!planned.has(id)))throw new Error('Session index or deletion scope changed; preview again');
  const paths=new Set<string>();
  for(const id of closure) {
    const row=byId.get(id);
    if(!row?.path||!within(inventory.root,row.path)||row.attachedParentId||threads.some(t=>t.attachedParentId===id))throw new Error('Native session index is incomplete; deletion blocked');
    if(paths.has(row.path))throw new Error('Native session files have shared ownership');
    paths.add(row.path);
    if(sessions) {
      const session=sessions.find(s=>s.id===id);
      if(!session||session.files.length!==1||session.files[0].path!==row.path||session.parentId!==row.parentId||session.archived!==row.archived)throw new Error('Session index or deletion scope changed; preview again');
    }
  }
  if(action.files.length!==paths.size||action.files.some(f=>!paths.has(f.path)))throw new Error('Native deletion scope differs from the preview');
}
// Observed startup writes and tagged 0.167.0 deletion paths only. Rollouts are
// deliberately excluded: migration/compression are disabled by the adapter.
function nativeMaintenancePath(path:string) {
  return /^(?:state_5|logs_2|goals_1|memories_1|queue_1|thread_history_1|agent_message_board_1)\.sqlite(?:-(?:wal|shm|journal))?$/.test(path)
    || /^(?:installation_id|session_index\.jsonl(?:\.lock)?)$/.test(path)
    || /^(?:skills\/\.system|tmp\/arg0-(?:macos|linux)|log|thread-writer-locks)(?:\/|$)/.test(path)
    || /^\.tmp\/(?:plugins\.sync\.lock|git-[^/]+(?:\/.*)?)$/.test(path);
}
function nativeChangesExpected(before:Inventory,after:Inventory,targets:Set<string>) {
  const files=new Map(before.files.filter(f=>!targets.has(f.path)&&!nativeMaintenancePath(f.relative)).map(f=>[f.path,f]));
  for(const file of after.files) {
    if(targets.has(file.path)||nativeMaintenancePath(file.relative))continue;
    const prior=files.get(file.path);
    if(!prior||['dev','ino','size','mtimeMs','ctimeMs','nlink','mode'].some(key=>prior[key as keyof FileEntry]!==file[key as keyof FileEntry]))return false;
    files.delete(file.path);
  }
  if(files.size)return false;
  const links=(inv:Inventory)=>inv.links.filter(l=>!nativeMaintenancePath(relative(inv.root,l.path)));
  // Links are not counted as reclaimed bytes, but unexpected changes still make attribution unsafe.
  return JSON.stringify(links(before))===JSON.stringify(links(after));
}
async function validState(root:string) {
  try {const v=JSON.parse((await readOrdinaryFile(join(root,'.codex-global-state.json'),4*1024*1024)).toString('utf8'));return !!v&&typeof v==='object'&&!Array.isArray(v);}catch{return false;}
}
export async function createPlan(inv:Inventory,options:PlanOptions={}):Promise<Plan> {
  const now=options.now??Date.now();const version=options.version??'unknown';
  const plan:Plan={schemaVersion:1,operationId:randomUUID(),provider:inv.provider,root:inv.root,version,source:options.source??'clean',explicitTarget:singleSelectedTarget(options),startedAt:new Date(now).toISOString(),actions:[],warnings:[...inv.errors],scanComplete:inv.complete};
  if(!inv.exists)return plan;
  const rootStat=await lstat(inv.root);plan.rootIdentity={dev:rootStat.dev,ino:rootStat.ino};
  if((options.otherRoots??[]).some(r=>r===inv.root||within(r,inv.root)||within(inv.root,r)))throw new Error('Source directories overlap; mutations blocked');
  if(!inv.complete){plan.warnings.push('Scan is incomplete; no mutation plan created');return plan;}
  const eligible=(f:FileEntry)=>f.nlink===1&&!referenced(inv,f.path)&&within(inv.root,f.path);
  if(options.sessionIds?.length) {
    const sessions=options.sessions??[];
    const selected=new Set(options.sessionIds);
    for(const id of selected) if(!uuid.test(id)||sessions.filter(s=>s.id===id).length!==1)throw new Error(`Unknown or ambiguous session ID: ${id}`);
    let changed=true;while(changed){changed=false;for(const s of sessions)if(s.parentId&&selected.has(s.parentId)&&!selected.has(s.id)){selected.add(s.id);changed=true;}}
    const groups=sessions.filter(s=>selected.has(s.id));
    if(groups.some(s=>!s.complete||!s.files.length||s.files.some(f=>!eligible(f))))throw new Error('Session structure, ownership or references are incomplete; deletion blocked');
    const owned=new Set<string>();for(const s of groups) for(const f of s.files){if(owned.has(f.path)||sessions.some(other=>!selected.has(other.id)&&other.files.some(x=>x.path===f.path)))throw new Error('Session files have shared ownership');owned.add(f.path);}
    if(inv.provider==='claude') {
      if(groups.some(s=>s.version!=='2.1.319'))throw new Error('Unverified Claude session format version (supported: 2.1.319)');
      plan.actions.push(makeAction('delete-files',[...selected].join(', '),groups.flatMap(s=>s.files),[...selected]));
    } else {
      if(version!=='0.167.0')throw new Error('Unverified Codex version (supported: 0.167.0)');
      for(const s of groups.filter(s=>!s.parentId||!selected.has(s.parentId))) {
        const ids=new Set([s.id]);let more=true;while(more){more=false;for(const c of groups)if(c.parentId&&ids.has(c.parentId)&&!ids.has(c.id)){ids.add(c.id);more=true;}}
        plan.actions.push(makeAction('codex-delete',s.id,groups.filter(c=>ids.has(c.id)).flatMap(c=>c.files),[...ids]));
      }
      if(new Set(plan.actions.flatMap(a=>a.sessionIds!)).size!==selected.size)throw new Error('Session relationships contain a cycle; deletion blocked');
      const index=await readCodexIndex(inv);
      if(!index.complete||!index.fingerprint||groups.some(s=>!index.threads.some(t=>t.id===s.id&&t.path&&s.files.some(f=>f.path===t.path))))throw new Error('Native session index is incomplete; deletion blocked');
      for(const action of plan.actions)verifyCodexScope(action,index.threads,inv,groups);
      plan.codexIndexFingerprint=index.fingerprint;
    }
    return protectRecentContent(plan,now);
  }
  const selected=options.filePaths?new Set(options.filePaths):null;
  if(selected&&[...selected].some(p=>!inv.files.some(f=>f.path===p)))throw new Error('Selection contains unknown files');
  if(options.slim?.removeImages||options.slim?.compactTools) {
    if(inv.provider==='codex') {
      try {await verifyCodexRewriteLayout(inv);}catch(error){plan.warnings.push((error as Error).message);return plan;}
    }
    for(const f of inv.files) {
      if(f.category!=='sessions'||selected&&!selected.has(f.path))continue;
      if(!eligible(f)||f.size>MAX_HISTORY_BYTES){plan.warnings.push(`${f.relative}: history is linked, referenced or exceeds 64 MiB; retained`);continue;}
      plan.actions.push({...makeAction('slim-history',f.relative,[f]),slimOptions:{...options.slim}});
    }
    return protectRecentContent(plan,now);
  }
  const stateValid=inv.provider==='codex'&&version==='0.167.0'&&await validState(inv.root);
  for(const f of inv.files) {
    if(selected&&!selected.has(f.path))continue;
    if(!eligible(f))continue;
    if(/^generated_images\/.+\.png$/i.test(f.relative)&&inv.provider==='codex') {
      if(f.size<=MAX_PNG_BYTES)plan.actions.push(makeAction(options.deleteImages?'delete-files':'compress-png',f.relative,[f]));
    } else if(stateValid&&/^\.\.codex-global-state\.json\.tmp-[^/]+$/.test(f.relative)) {
      plan.actions.push(makeAction('delete-files',f.relative,[f]));
    }
  }
  protectRecentContent(plan,now);
  if(selected&&plan.actions.length===0)plan.warnings.push('Selected files have no eligible operations');
  return plan;
}
async function verifyFile(root:string,f:FileEntry) {
  if(!within(root,f.path)||await realpath(root)!==root)throw new Error('Source path changed');
  let cursor=root;
  for(const part of relative(root,dirname(f.path)).split('/').filter(Boolean)) {cursor=join(cursor,part);const s=await lstat(cursor);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Parent directory changed or contains a symlink');}
  if(!same(f,await lstat(f.path)))throw new Error('File changed or has hard links');
}
async function readVerified(root:string,f:FileEntry) {
  await verifyFile(root,f);const data=await readOrdinaryFile(f.path,MAX_PNG_BYTES);await verifyFile(root,f);return data;
}
export async function estimateSavings(plan:Plan,signal?:AbortSignal,onProgress?:(progress:ScanProgress)=>void) {
  for(const [index,action] of plan.actions.entries()) {
    signal?.throwIfAborted();
    onProgress?.({phase:'estimating',completed:index,total:plan.actions.length,currentFile:action.targetId});
    if(action.kind==='compress-png') {
      try {
        const output=await recompressPng(await readVerified(plan.root,action.files[0]));
        action.estimatedSavingsBytes=output?Math.max(0,action.beforeBytes-output.length):0;
      } catch(error) {
        action.estimatedSavingsBytes=null;
        plan.warnings.push(`${action.targetId}: savings estimate unavailable: ${(error as Error).message}`);
      }
    } else if(action.kind==='slim-history') {
      try {
        const input=await readVerified(plan.root,action.files[0]);
        const {output,counts}=slimHistory(input,plan.provider,action.slimOptions!);
        action.slimCounts=counts;action.estimatedSavingsBytes=output?input.length-output.length:0;
        if(output){action.beforeHash=hash(input);action.afterHash=hash(output);}
      } catch(error) {
        action.estimatedSavingsBytes=0;
        plan.warnings.push(`${action.targetId}: history retained: ${(error as Error).message}`);
      }
    }
    signal?.throwIfAborted();
  }
  plan.actions=plan.actions.filter(a=>a.kind!=='slim-history'||!!a.estimatedSavingsBytes);
  onProgress?.({phase:'estimating',completed:plan.actions.length,total:plan.actions.length});
}
async function verifyRoot(r:Plan) {
  const s=await lstat(r.root);
  if(!r.rootIdentity||!s.isDirectory()||s.isSymbolicLink()||await realpath(r.root)!==r.root||s.dev!==r.rootIdentity.dev||s.ino!==r.rootIdentity.ino)throw new Error('Source directory identity changed');
}
async function verifyParents(r:Plan,a:Action) {
  await verifyRoot(r);
  for(const f of a.files)if(!within(r.root,f.path)||!await existingDir(dirname(f.path))||await realpath(dirname(f.path))!==dirname(f.path))throw new Error('Source parent directory changed');
}
async function exists(path:string) {try {await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function acquireLock(stateDir:string):Promise<()=>Promise<void>> {
  await privateDir(stateDir);
  const path=join(stateDir,'mutation.lock'), guardPath=join(stateDir,'mutation.acquire');
  let guard;
  // Serialize stale-lock reclamation; an interrupted acquisition requires inspection, never guessing ownership.
  try {guard=await open(guardPath,'wx',0o600);} catch {throw new Error('Another operation is acquiring the mutation lock, or mutation.acquire requires review');}
  try {
    if(await exists(path)) {
      const data=JSON.parse((await readOrdinaryFile(path,1024)).toString('utf8'));
      if(!Number.isSafeInteger(data.pid)||data.pid<=0)throw new Error('Invalid mutation lock');
      try {process.kill(data.pid,0);throw new Error('Another cleanup operation is running');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      await unlink(path);
    }
    const f=await open(path,'wx',0o600);
    try {await f.writeFile(JSON.stringify({pid:process.pid}));await f.sync();}finally{await f.close();}
    const owned=await lstat(path);
    return async()=>{const current=await lstat(path);if(current.ino===owned.ino&&current.dev===owned.dev)await unlink(path);};
  } finally {await guard.close();await unlink(guardPath);}
}
function receiptPath(stateDir:string,r:Plan) {return join(stateDir,'providers',r.provider,'operations',`${r.operationId}.json`);}
function workPath(stateDir:string,r:Plan,a:Action) {return join(stateDir,'providers',r.provider,'work',r.operationId,a.id);}
async function verifyBackup(dir:string,a:Action,index:number) {
  if(!await existingDir(dir))throw new Error('Transaction directory is missing');
  const f=a.files[index],s=await lstat(join(dir,`${index}.original`));
  if(!s.isFile()||s.isSymbolicLink()||s.dev!==f.dev||s.ino!==f.ino||s.size!==f.size||s.mtimeMs!==f.mtimeMs||s.nlink> (replacement(a.kind)?2:1))throw new Error('Original transaction file identity changed; retained for review');
}
async function cleanupWork(dir:string,a:Action) {
  if(!await existingDir(dir))return;
  for(const name of await readdir(dir)) {
    const match=/^(\d+)\.original$/.exec(name);
    if(match) {const index=Number(match[1]);if(index>=a.files.length)throw new Error('Unknown transaction file');await verifyBackup(dir,a,index);}
    else if(name!=='output')throw new Error('Work directory contains unknown files');
    const path=join(dir,name),s=await lstat(path);
    if(!s.isFile()||s.isSymbolicLink())throw new Error('Invalid work file');
    await unlink(path);
  }
}
async function currentHash(root:string,path:string):Promise<string> {
  if(!within(root,path)||await realpath(root)!==root||await realpath(dirname(path))!==dirname(path))throw new Error('Recovery path changed');
  return hash(await readOrdinaryFile(path,MAX_PNG_BYTES));
}
function updateTotal(r:Receipt) {r.confirmedReductionBytes=r.actions.reduce((n,a)=>n+(a.status==='completed'?a.beforeBytes-a.afterBytes:0),0);}
interface ExecuteOptions {stateDir:string;dryRun?:boolean;signal?:AbortSignal;checkActivity?:ActivityCheck;onProgress?:(message:string)=>void}
export async function executePlan(plan:Plan,options:ExecuteOptions):Promise<Receipt> {
  const r:Receipt=structuredClone({...plan,status:'completed',rootBeforeBytes:null,rootAfterBytes:null,confirmedReductionBytes:0,attributionComplete:true});
  if(options.dryRun){r.status='dry-run';return r;}
  const {stateDir}=options;const check=options.checkActivity??defaultActivity;
  if(plan.root===stateDir||within(plan.root,stateDir)||within(stateDir,plan.root))throw new Error('Application and source directories overlap');
  const unlock=await acquireLock(stateDir);
  const save=()=>atomicJson(receiptPath(stateDir,r),r);
  const finish=async()=>{updateTotal(r);r.finishedAt=new Date().toISOString();await save();await recordCleanup(stateDir,r);return r;};
  let expectedIndexFingerprint=plan.codexIndexFingerprint;
  try {
    await recoverUnlocked(stateDir,check);
    const pending=(await jsonFiles(join(stateDir,'providers',r.provider,'operations'))).some(({data})=>(data as Receipt).status==='needs-review');
    if(pending)throw new Error('An operation needs review; new mutations blocked. Inspect stats for details');
    r.executionStartedAt=new Date().toISOString();
    const before=await scanRoot(r.root,r.provider);r.rootBeforeBytes=before.complete?before.totalBytes:null;
    if(!before.complete){r.status='failed';r.warnings.push('Pre-execution scan is incomplete');r.actions.forEach(a=>{a.status='skipped';a.reason='Scan is incomplete';a.recoveryState='finalized';});return await finish();}
    if(!r.actions.length){r.status=plan.scanComplete?'completed':'failed';r.rootAfterBytes=r.rootBeforeBytes;return await finish();}
    const busy=await check(r.provider,r.root);
    if(busy){r.actions.forEach(a=>{a.status='skipped';a.reason=busy;a.recoveryState='finalized';});r.warnings.push(busy);r.status=r.source==='analyze'?'partial':'completed';r.rootAfterBytes=r.rootBeforeBytes;return await finish();}
    if(r.provider==='codex'&&r.actions.some(a=>a.kind==='slim-history'))await verifyCodexRewriteLayout(before,options.signal);
    r.status='needs-review';await save();
    for(const a of r.actions) {
      if(options.signal?.aborted){r.status='interrupted';break;}
      options.onProgress?.(`${a.kind}: ${a.targetId}`);
      const dir=workPath(stateDir,r,a);
      try {
        const activity=await check(r.provider,r.root,a.files.map(f=>f.path));if(activity)throw new Error(activity);
        await verifyRoot(r);
        if(a.files.some(f=>referenced(before,f.path)))throw new Error('References or scan state changed');
        for(const f of a.files)await verifyFile(r.root,f);
        const ageReason=ageProtectionReason(a,r.explicitTarget);if(ageReason)throw new Error(ageReason);
        if(a.kind==='codex-delete') {
          const pre=await scanRoot(r.root,r.provider);if(!pre.complete)throw new Error('Scan before native deletion is incomplete');
          const index=await readCodexIndex(pre);if(!index.complete||!expectedIndexFingerprint||index.fingerprint!==expectedIndexFingerprint)throw new Error('Session index or deletion scope changed; preview again');
          verifyCodexScope(a,index.threads,pre);
          a.beforeBytes=pre.totalBytes;a.nativeStarted=true;await save();
          try {await deleteCodexSession(r.root,a.targetId);}catch {r.attributionComplete=false;throw new Error('Native deletion could not be confirmed; inspect the pending operation');}
          const post=await scanRoot(r.root,r.provider);
          const remaining=await readCodexIndex(post),removed=new Set(a.sessionIds);
          const survivors=new Map(index.threads.filter(t=>!removed.has(t.id)).map(t=>[t.id,JSON.stringify(t)]));
          if(!post.complete||!remaining.complete||!remaining.fingerprint||remaining.threads.length!==survivors.size||remaining.threads.some(t=>survivors.get(t.id)!==JSON.stringify(t))||a.files.some(f=>post.files.some(p=>p.path===f.path))||!nativeChangesExpected(pre,post,new Set(a.files.map(f=>f.path)))||await check(r.provider,r.root)){r.attributionComplete=false;throw new Error('Native deletion results or additional writes need review');}
          expectedIndexFingerprint=remaining.fingerprint;
          a.beforeBytes=pre.totalBytes;a.afterBytes=post.totalBytes;a.recoveryState='finalized';a.status='completed';updateTotal(r);await save();continue;
        }
        await privateDir(dir);
        const workStat=await lstat(dir);if(a.files.some(f=>f.dev!==workStat.dev))throw new Error('Work and source directories must be on the same filesystem');
        const space=await statfs(dir);if(space.bavail*space.bsize<a.beforeBytes*2+1024*1024)throw new Error('Insufficient working space');
        if(replacement(a.kind)) {
          const f=a.files[0];
          if(process.platform==='darwin'){const {stdout}=await exec('/usr/bin/xattr',[f.path],{timeout:5000});if(stdout.trim())throw new Error('File has extended attributes; original retained');}
          const input=await readVerified(r.root,f);
          const slim=a.kind==='slim-history'?slimHistory(input,r.provider,a.slimOptions!):null;
          const output=slim?slim.output:await recompressPng(input);
          if(!output){a.status='skipped';a.reason='Transformation did not reduce file size';a.recoveryState='finalized';await save();continue;}
          if(slim) {
            if(a.beforeHash!==hash(input)||a.afterHash!==hash(output))throw new Error('History differs from its preview; original retained');
            a.slimCounts=slim.counts;
          }
          a.beforeHash=hash(input);a.afterHash=hash(output);a.afterBytes=output.length;
          const out=await open(join(dir,'output'),'wx',f.mode&0o777);
          try {await out.writeFile(output);await out.chmod(f.mode&0o777);await out.utimes(new Date(f.mtimeMs),new Date(f.mtimeMs));await out.sync();}finally{await out.close();}
          await save();await verifyFile(r.root,f);
          // A hardlink preserves the original inode until the atomic replacement is journaled.
          await link(f.path,join(dir,'0.original'));
          await verifyBackup(dir,a,0);
          const linked=await lstat(f.path);if(linked.ino!==f.ino||linked.dev!==f.dev||linked.nlink!==2||linked.size!==f.size||linked.mtimeMs!==f.mtimeMs)throw new Error('File changed before replacement');
          await rename(join(dir,'output'),f.path);
        } else {
          a.afterBytes=0;await save();
          for(let i=0;i<a.files.length;i++){await verifyFile(r.root,a.files[i]);await rename(a.files[i].path,join(dir,`${i}.original`));await verifyBackup(dir,a,i);}
        }
        a.recoveryState='applied';a.status='completed';updateTotal(r);await save();
        await cleanupWork(dir,a);a.recoveryState='finalized';await save();
      } catch(e) {
        a.reason=(e as Error).message;
        if(a.recoveryState==='applied'){r.attributionComplete=false;r.status='needs-review';await save();break;}
        if(a.kind==='codex-delete'&&a.nativeStarted){r.attributionComplete=false;a.status='failed';r.status='needs-review';await save();break;}
        const restored=await rollbackPrepared(r,a,dir);
        a.status=restored?'skipped':'failed';a.recoveryState=restored?'finalized':'prepared';
        if(!restored){r.attributionComplete=false;r.status='needs-review';await save();break;}
        await save();
      }
    }
    const after=await scanRoot(r.root,r.provider);r.rootAfterBytes=after.complete?after.totalBytes:null;
    for(const a of r.actions)if(a.status==='planned'){a.status='skipped';a.reason='Operation stopped';a.recoveryState='finalized';}
    if(r.attributionComplete&&r.status!=='interrupted')r.status=r.actions.some(a=>a.status==='failed')?'partial':r.source==='analyze'&&r.actions.length>0&&!r.actions.some(a=>a.status==='completed')?'partial':'completed';
    return await finish();
  } finally {await unlock();}
}
async function rollbackPrepared(r:Plan,a:Action,dir:string):Promise<boolean> {
  try {
    await verifyParents(r,a);
    if(!await existingDir(dir)){for(const f of a.files)await verifyFile(r.root,f);return true;}
    for(let i=0;i<a.files.length;i++) {
      const f=a.files[i],backup=join(dir,`${i}.original`);
      if(!await exists(backup)){await verifyFile(r.root,f);continue;}
      await verifyBackup(dir,a,i);
      if(!within(r.root,f.path)||await realpath(dirname(f.path))!==dirname(f.path))return false;
      if(await exists(f.path)) {
        if(!replacement(a.kind))return false;
        const current=await lstat(f.path);if(current.ino!==f.ino||current.dev!==f.dev||current.size!==f.size||current.mtimeMs!==f.mtimeMs||!current.isFile())return false;
        await unlink(backup);
      } else {await link(backup,f.path);await unlink(backup);}
    }
    await cleanupWork(dir,a);return true;
  }catch{return false;}
}
async function recoverUnlocked(stateDir:string,check:ActivityCheck) {
  await readCleanupLog(stateDir);
  for(const provider of ['claude','codex'] as const) {
    for(const {path,data} of await jsonFiles(join(stateDir,'providers',provider,'operations'))) {
      const r=validateReceipt(data,provider);
      if(path!==receiptPath(stateDir,r)||r.root===stateDir||within(r.root,stateDir)||within(stateDir,r.root))throw new Error('Invalid operation record path');
      if(r.actions.every(a=>a.recoveryState==='finalized')){
        if(r.executionStartedAt&&!r.finishedAt){r.status='interrupted';r.rootAfterBytes=null;r.finishedAt=new Date().toISOString();await atomicJson(path,r);}
        await recordCleanup(stateDir,r);continue;
      }
      if(await check(provider,r.root))continue;
      let pending=false;
      for(const a of r.actions) {
        if(!uuid.test(a.id)||a.files.some(f=>!within(r.root,f.path)))throw new Error('Recovery target is outside the source directory');
        if(a.recoveryState==='finalized')continue;
        const dir=workPath(stateDir,r,a);
        if(a.kind==='codex-delete'){if(a.nativeStarted){pending=true;}else{a.status='skipped';a.reason='Previous operation did not start native deletion';a.recoveryState='finalized';}continue;}
        try {
          await verifyParents(r,a);
          if(replacement(a.kind)&&a.recoveryState==='prepared') {
            const f=a.files[0],s=await lstat(f.path).catch(()=>null);
            if(s?.ino===f.ino&&s.dev===f.dev&&s.size===f.size&&s.mtimeMs===f.mtimeMs) {
              if(await rollbackPrepared(r,a,dir)){a.status='skipped';a.reason='Previous operation was interrupted; original file was not replaced';a.afterBytes=a.beforeBytes;a.recoveryState='finalized';continue;}
            }
            if(a.afterHash&&s&&(await currentHash(r.root,f.path))===a.afterHash){a.status='completed';a.recoveryState='applied';}
          }
          if(a.recoveryState==='applied') {
            if(a.kind==='delete-files'&&(await Promise.all(a.files.map(f=>exists(f.path)))).some(Boolean)){pending=true;continue;}
            if(replacement(a.kind)&&(!a.afterHash||(await currentHash(r.root,a.files[0].path))!==a.afterHash)){pending=true;continue;}
            a.status='completed';updateTotal(r);await atomicJson(path,r);await cleanupWork(dir,a);a.recoveryState='finalized';
          } else if(await rollbackPrepared(r,a,dir)){a.status='skipped';a.reason='Previous operation was interrupted; original files restored';a.afterBytes=a.beforeBytes;a.recoveryState='finalized';} else pending=true;
        }catch{pending=true;}
      }
      r.attributionComplete=!pending;r.status=pending?'needs-review':'interrupted';
      // A later recovery scan cannot reconstruct the directory size when cleanup was interrupted.
      r.rootAfterBytes=null;r.finishedAt=new Date().toISOString();updateTotal(r);await atomicJson(path,r);await recordCleanup(stateDir,r);
    }
  }
}
export async function recoverOperations(stateDir:string,check:ActivityCheck=defaultActivity) {const unlock=await acquireLock(stateDir);try{await recoverUnlocked(stateDir,check);}finally{await unlock();}}
