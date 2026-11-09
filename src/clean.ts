import { open, lstat, realpath, rename, unlink, link, readdir, statfs } from 'node:fs/promises';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import type { FileEntry, Inventory, Provider, ScanProgress, Session } from './types.ts';
import { scanRoot } from './scan.ts';
import { verifySessionTempEvidence } from './session-temp.ts';
import { scanSystemTemp, scopedTempKind, tempExcluded, verifySystemTempParents, type SystemTempScope } from './system-temp.ts';
import { privateDir, atomicJson, jsonFiles, within, existingDir, readOrdinaryFile } from './state.ts';
import { recompressPng, MAX_PNG_BYTES } from './png.ts';
import { checkActivity as defaultActivity, activityReason, type ActivityCheck } from './activity.ts';
import { deleteCodexSession, verifyCodexDeleteCapabilities } from './codex-delete.ts';
import { validateReceipt } from './state.ts';
import { readCodexIndex, type IndexThread } from './providers/codex.ts';
import { readCleanupLog, recordCleanup } from './history.ts';
import { slimHistory, MAX_HISTORY_BYTES, type SlimOptions, type SlimCounts, type SlimSavingsBytes } from './slim.ts';
import { decodeDuplicateHistory, verifyCodexRewriteLayout, verifyCodexDeletionHistories, previewProjection, prepareProjection, verifyProjectionBefore, type ProjectionReceipt } from './providers/codex-history.ts';
export { verifyCodexRewriteLayout } from './providers/codex-history.ts';
const exec=promisify(execFile);
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const unchangedHistory: SlimOptions = {removeImages:false,compactTools:false};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface Action {
  id:string;kind:'delete-files'|'compress-png'|'codex-delete'|'slim-history'|'deduplicate-history';targetId:string;files:FileEntry[];
  slimOptions?:SlimOptions;slimCounts?:SlimCounts;slimSavingsBytes?:SlimSavingsBytes;codexProjection?:ProjectionReceipt[];
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
  totalSessionBytes?:number|null;
  systemTemp?:SystemTempScope;
}
export interface Receipt extends Plan {
  status:'completed'|'partial'|'failed'|'interrupted'|'needs-review'|'dry-run';
  rootBeforeBytes:number|null;rootAfterBytes:number|null;confirmedReductionBytes:number;
  attributionComplete:boolean;executionStartedAt?:string;finishedAt?:string;
}
interface PlanOptions {now?:number;version?:string;source?:'clean'|'analyze';filePaths?:string[];deleteImages?:boolean;sessions?:Session[];sessionIds?:string[];otherRoots?:string[];slim?:SlimOptions;includeFileCleanup?:boolean;tempOnly?:boolean;systemTemp?:SystemTempScope;checkActivity?:ActivityCheck}
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
    const reason=ageProtectionReason(action,plan.systemTemp?undefined:plan.explicitTarget,now);
    if(reason)plan.warnings.push(reason);
    return !reason;
  });
  return plan;
}
export async function protectActiveContent(plan:Plan,check:ActivityCheck=defaultActivity):Promise<Plan> {
  if(!plan.actions.length)return plan;
  const reasons=await planActivity(plan,check);
  plan.actions=plan.actions.filter(a=>!reasons.has(a));
  for(const reason of new Set(reasons.values()))plan.warnings.push(`Activity protection: ${reason}`);
  return plan;
}
const replacement=(kind:Action['kind'])=>kind==='compress-png'||kind==='slim-history';
function same(entry:FileEntry,s:Awaited<ReturnType<typeof lstat>>) {return s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.dev===entry.dev&&s.ino===entry.ino&&s.size===entry.size&&s.mtimeMs===entry.mtimeMs&&s.ctimeMs===entry.ctimeMs&&(entry.uid===undefined||s.uid===entry.uid&&s.mode===entry.mode);}
function referenced(inv:Inventory,path:string) {return inv.links.some(l=>{const target=isAbsolute(l.target)?resolve(l.target):resolve(dirname(l.path),l.target);return path===target||within(target,path)||within(path,target);});}
function makeAction(kind:Action['kind'],id:string,files:FileEntry[],sessionIds?:string[]):Action {
  const bytes=files.reduce((n,f)=>n+f.size,0);
  return {id:randomUUID(),kind,targetId:id,files,sessionIds,status:'planned',beforeBytes:bytes,afterBytes:bytes,estimatedSavingsBytes:replacement(kind)?null:bytes,recoveryState:'prepared'};
}

async function verifyCodexScope(action:Action,threads:IndexThread[],inventory:Inventory,sessions?:Session[]) {
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
  await verifyCodexDeletionHistories(inventory,closure,paths);
}
// Known native startup database families and deletion paths. Rollouts are
// deliberately excluded: migration/compression are disabled by the adapter.
function nativeMaintenancePath(path:string) {
  return /^(?:state|logs|goals|memories|queue|thread_history|agent_message_board)_\d+\.sqlite(?:-(?:wal|shm|journal))?$/.test(path)
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
  const plan:Plan={schemaVersion:1,operationId:randomUUID(),provider:inv.provider,root:inv.root,version,source:options.source??'clean',systemTemp:options.systemTemp,explicitTarget:options.systemTemp?undefined:singleSelectedTarget(options),startedAt:new Date(now).toISOString(),actions:[],warnings:[...inv.errors],scanComplete:inv.complete};
  if(!inv.exists)return plan;
  const rootStat=await lstat(inv.root);plan.rootIdentity={dev:rootStat.dev,ino:rootStat.ino};
  if((options.otherRoots??[]).some(r=>r===inv.root||within(r,inv.root)||within(inv.root,r)))throw new Error('Source directories overlap; mutations blocked');
  if(!inv.complete){plan.warnings.push('Scan is incomplete; no mutation plan created');return plan;}
  const eligible=(f:FileEntry)=>f.nlink===1&&!referenced(inv,f.path)&&within(inv.root,f.path);
  if(options.systemTemp) {
    for(const f of inv.files)if(eligible(f)&&f.uid===options.systemTemp.uid&&!tempExcluded(f.path,options.systemTemp)&&scopedTempKind(inv.root,f.path,inv.provider,options.systemTemp))
      plan.actions.push(makeAction('delete-files',f.relative,[f]));
    return protectActiveContent(protectRecentContent(plan,now),options.checkActivity);
  }
  if(options.sessionIds?.length) {
    const sessions=options.sessions??[];
    const selected=new Set(options.sessionIds);
    for(const id of selected) if(!uuid.test(id)||sessions.filter(s=>s.id===id).length!==1)throw new Error(`Unknown or ambiguous session ID: ${id}`);
    let changed=true;while(changed){changed=false;for(const s of sessions)if(s.parentId&&selected.has(s.parentId)&&!selected.has(s.id)){selected.add(s.id);changed=true;}}
    const groups=sessions.filter(s=>selected.has(s.id));
    if(groups.some(s=>!s.complete||!s.files.length||s.files.some(f=>!eligible(f))))throw new Error('Session structure, ownership or references are incomplete; deletion blocked');
    const owned=new Set<string>();for(const s of groups) for(const f of s.files){if(owned.has(f.path)||sessions.some(other=>!selected.has(other.id)&&other.files.some(x=>x.path===f.path)))throw new Error('Session files have shared ownership');owned.add(f.path);}
    if(inv.provider==='claude') {
      plan.actions.push(makeAction('delete-files',[...selected].join(', '),groups.flatMap(s=>s.files),[...selected]));
    } else {
      for(const s of groups.filter(s=>!s.parentId||!selected.has(s.parentId))) {
        const ids=new Set([s.id]);let more=true;while(more){more=false;for(const c of groups)if(c.parentId&&ids.has(c.parentId)&&!ids.has(c.id)){ids.add(c.id);more=true;}}
        plan.actions.push(makeAction('codex-delete',s.id,groups.filter(c=>ids.has(c.id)).flatMap(c=>c.files),[...ids]));
      }
      if(new Set(plan.actions.flatMap(a=>a.sessionIds!)).size!==selected.size)throw new Error('Session relationships contain a cycle; deletion blocked');
      const index=await readCodexIndex(inv);
      if(!index.complete||!index.fingerprint||groups.some(s=>!index.threads.some(t=>t.id===s.id&&t.path&&s.files.some(f=>f.path===t.path))))throw new Error('Native session index is incomplete; deletion blocked');
      for(const action of plan.actions)await verifyCodexScope(action,index.threads,inv,groups);
      await verifyCodexDeleteCapabilities(inv.root);
      plan.codexIndexFingerprint=index.fingerprint;
    }
    return protectActiveContent(protectRecentContent(plan,now),options.checkActivity);
  }
  const selected=options.filePaths?new Set(options.filePaths):null;
  if(selected&&[...selected].some(p=>!inv.files.some(f=>f.path===p)))throw new Error('Selection contains unknown files');
  if(options.slim?.removeImages||options.slim?.compactTools||options.slim?.removeReasoning||options.slim?.removeRequestArchives||options.slim?.compactHooks||options.slim?.compactToolDefinitions||options.slim?.compactSkillListings||options.slim?.removeOldSnapshots) {
    let layoutValid=true,blocked=new Map<string,string>();
    if(inv.provider==='codex') {
      try {blocked=await verifyCodexRewriteLayout(inv);}catch(error){plan.warnings.push((error as Error).message);layoutValid=false;}
    }
    if(layoutValid)for(const f of inv.files) {
      if(f.category!=='sessions'||selected&&!selected.has(f.path))continue;
      if(blocked.has(f.path)){plan.warnings.push(`${f.relative}: ${blocked.get(f.path)}`);continue;}
      if(!eligible(f)||f.size>MAX_HISTORY_BYTES){plan.warnings.push(`${f.relative}: history is linked, referenced or exceeds 64 MiB; retained`);continue;}
      plan.actions.push({...makeAction('slim-history',f.relative,[f]),slimOptions:{...options.slim}});
    }
    if(!options.includeFileCleanup)return protectActiveContent(protectRecentContent(plan,now),options.checkActivity);
  }
  const stateValid=inv.provider==='codex'&&await validState(inv.root);
  if(inv.provider==='codex'&&!options.tempOnly) {
    const byPath=new Map(inv.files.map(f=>[f.path,f]));
    const pairs=inv.files.filter(f=>f.category==='sessions'&&f.path.endsWith('.jsonl')&&byPath.has(f.path+'.zst')&&(!selected||selected.has(f.path)));
    if(pairs.length)try {
      const blocked=await verifyCodexRewriteLayout(inv,undefined,true);
      for(const plain of pairs) {
        const files=[plain,byPath.get(plain.path+'.zst')!];
        const reason=files.map(f=>blocked.get(f.path)).find(Boolean);
        if(reason||files.some(f=>!eligible(f)||f.size>MAX_HISTORY_BYTES)) {
          plan.warnings.push(`${plain.relative}: duplicate retained: ${reason??'linked, referenced or exceeds 64 MiB'}`);continue;
        }
        plan.actions.push({...makeAction('deduplicate-history',plain.relative,files),estimatedSavingsBytes:null});
      }
    } catch(error) {plan.warnings.push(`Duplicate histories retained: ${(error as Error).message}`);}
  }
  for(const f of inv.files) {
    if(selected&&!selected.has(f.path))continue;
    if(!eligible(f))continue;
    if(/^generated_images\/.+\.png$/i.test(f.relative)&&inv.provider==='codex') {
      if(!options.tempOnly&&f.size<=MAX_PNG_BYTES)plan.actions.push(makeAction(options.deleteImages?'delete-files':'compress-png',f.relative,[f]));
    } else if(stateValid&&/^\.\.codex-global-state\.json\.tmp-[^/]+$/.test(f.relative)) {
      plan.actions.push(makeAction('delete-files',f.relative,[f]));
    }
  }
  protectRecentContent(plan,now);
  if(selected&&plan.actions.length===0)plan.warnings.push('Selected files have no eligible operations');
  return protectActiveContent(plan,options.checkActivity);
}
async function verifyFile(root:string,f:FileEntry,plan?:Plan) {
  if(plan?.systemTemp)await verifySystemTempParents(root,f.path,plan.provider,plan.systemTemp);
  if(!within(root,f.path)||await realpath(root)!==root)throw new Error('Source path changed');
  let cursor=root;
  for(const part of relative(root,dirname(f.path)).split('/').filter(Boolean)) {cursor=join(cursor,part);const s=await lstat(cursor);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Parent directory changed or contains a symlink');}
  if(!same(f,await lstat(f.path)))throw new Error('File changed or has hard links');
}
async function readVerified(root:string,f:FileEntry) {
  await verifyFile(root,f);const data=await readOrdinaryFile(f.path,MAX_PNG_BYTES);await verifyFile(root,f);return data;
}
async function readDuplicate(root:string,a:Action,signal?:AbortSignal,preview=false) {
  const compressed=await readVerified(root,a.files[1]);
  const decoded=await decodeDuplicateHistory(compressed,a.files[0].size,signal);
  if(!preview&&(hash(compressed)!==a.afterHash||hash(decoded)!==a.beforeHash))throw new Error('Duplicate history differs from its preview; retained');
  return {compressed,decoded};
}
export async function estimateSavings(plan:Plan,signal?:AbortSignal,onProgress?:(progress:ScanProgress)=>void) {
  signal?.throwIfAborted();
  await protectActiveContent(plan);
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
    } else if(action.kind==='deduplicate-history') {
      try {
        const input=await readVerified(plan.root,action.files[0]);
        const {compressed,decoded}=await readDuplicate(plan.root,action,signal,true);
        if(!input.equals(decoded))throw new Error('Plain and compressed histories are not byte-for-byte identical');
        action.codexProjection=await previewProjection(plan.root,input,input,unchangedHistory);
        action.beforeHash=hash(input);action.afterHash=hash(compressed);
        action.estimatedSavingsBytes=input.length;
      } catch(error) {
        action.estimatedSavingsBytes=0;
        plan.warnings.push(`${action.targetId}: duplicate retained: ${(error as Error).message}`);
      }
    } else if(action.kind==='slim-history') {
      try {
        const input=await readVerified(plan.root,action.files[0]);
        const {output,counts,savingsBytes}=slimHistory(input,plan.provider,action.slimOptions!);
        action.slimCounts=counts;action.slimSavingsBytes=savingsBytes;action.estimatedSavingsBytes=output?input.length-output.length:0;
        if(output){
          if(plan.provider==='codex')action.codexProjection=await previewProjection(plan.root,input,output,action.slimOptions!);
          action.beforeHash=hash(input);action.afterHash=hash(output);
        }
      } catch(error) {
        action.estimatedSavingsBytes=0;
        plan.warnings.push(`${action.targetId}: history retained: ${(error as Error).message}`);
      }
    }
    signal?.throwIfAborted();
  }
  plan.actions=plan.actions.filter(a=>!['slim-history','deduplicate-history'].includes(a.kind)||!!a.estimatedSavingsBytes);
  onProgress?.({phase:'estimating',completed:plan.actions.length,total:plan.actions.length});
}
async function verifyRoot(r:Plan) {
  const s=await lstat(r.root);
  if(!r.rootIdentity||!s.isDirectory()||s.isSymbolicLink()||await realpath(r.root)!==r.root||s.dev!==r.rootIdentity.dev||s.ino!==r.rootIdentity.ino)throw new Error('Source directory identity changed');
}
async function verifyParents(r:Plan,a:Action) {
  await verifyRoot(r);
  if(r.systemTemp?.session)await verifySessionTempEvidence(r.systemTemp.session,r.provider,true);
  for(const f of a.files)if(!within(r.root,f.path)||!await existingDir(dirname(f.path))||await realpath(dirname(f.path))!==dirname(f.path))throw new Error('Source parent directory changed');
  if(r.systemTemp)for(const f of a.files)await verifySystemTempParents(r.root,f.path,r.provider,r.systemTemp);
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
  if(a.kind==='deduplicate-history'&&index!==0)throw new Error('Compressed history must never be moved into transaction storage');
  if(!await existingDir(dir))throw new Error('Transaction directory is missing');
  const f=a.files[index],s=await lstat(join(dir,`${index}.original`));
  if(!s.isFile()||s.isSymbolicLink()||s.dev!==f.dev||s.ino!==f.ino||s.size!==f.size||s.mtimeMs!==f.mtimeMs||f.uid!==undefined&&(s.uid!==f.uid||s.mode!==f.mode)||s.nlink> (replacement(a.kind)?2:1))throw new Error('Original transaction file identity changed; retained for review');
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
async function verifyRetainedDuplicate(r:Plan,a:Action,check:ActivityCheck) {
  if(a.kind!=='deduplicate-history')return;
  if(await exists(a.files[0].path))throw new Error('Plain history reappeared; duplicate cleanup needs review');
  const age=ageProtectionReason(a);if(age)throw new Error(age);
  const activity=await actionActivity(r,a,check);if(activity)throw new Error(activity);
  await verifyFile(r.root,a.files[1]);
}
async function syncDirectory(path:string) {
  const dir=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {await dir.sync();}finally{await dir.close();}
}
async function currentHash(root:string,path:string):Promise<string> {
  if(!within(root,path)||await realpath(root)!==root||await realpath(dirname(path))!==dirname(path))throw new Error('Recovery path changed');
  return hash(await readOrdinaryFile(path,MAX_PNG_BYTES));
}
function updateTotal(r:Receipt) {r.confirmedReductionBytes=r.actions.reduce((n,a)=>n+(a.status==='completed'?a.beforeBytes-a.afterBytes:0),0);}
const scanPlanScope=(p:Plan)=>p.systemTemp?scanSystemTemp(p.root,p.provider,p.systemTemp):scanRoot(p.root,p.provider);
async function planActivity(p:Plan,check:ActivityCheck,actions=p.actions,openPaths?:string[]) {
  const reasons=new Map<Action,string>();
  for(const provider of p.systemTemp?.session?['claude','codex'] as const:[p.provider]) {
    const root=p.systemTemp?.session?.roots[provider]??p.root;
    const paths=openPaths??actions.flatMap(a=>a.files.map(f=>f.path));
    const codexRoot=provider==='codex'&&!p.systemTemp;
    let result=await check(provider,root,codexRoot?undefined:paths).catch(()=>'Cannot reliably check client activity');
    // Codex still protects the whole root, including index writers; transaction copies can be outside it.
    if(!result&&codexRoot&&openPaths?.length)result=await check(provider,root,openPaths).catch(()=>'Cannot reliably check client activity');
    for(const a of actions) {
      const ownedPaths=p.systemTemp?.session?[p.systemTemp.session.source]:a.files.map(f=>f.path);
      const reason=activityReason(result,root,openPaths??a.files.map(f=>f.path),a.sessionIds,ownedPaths);
      if(reason&&!reasons.has(a))reasons.set(a,reason);
    }
    if(reasons.size===actions.length)break;
  }
  return reasons;
}
async function actionActivity(p:Plan,a:Action,check:ActivityCheck,dir?:string) {
  try {
    const paths:string[]=[];
    for(const [i,f] of a.files.entries())for(const path of [f.path,...dir?[join(dir,`${i}.original`)]:[]])if(await exists(path))paths.push(path);
    if(dir&&await exists(join(dir,'output')))paths.push(join(dir,'output'));
    return (await planActivity(p,check,[a],paths)).get(a)??null;
  }catch{return 'Cannot reliably inspect candidate and transaction files';}
}
function stateOverlaps(p:Plan,stateDir:string) {
  return p.root===stateDir||within(stateDir,p.root)||within(p.root,stateDir)&&(!p.systemTemp||!tempExcluded(stateDir,p.systemTemp));
}
interface ExecuteOptions {stateDir:string;dryRun?:boolean;signal?:AbortSignal;checkActivity?:ActivityCheck;onProgress?:(message:string)=>void}
export async function executePlan(plan:Plan,options:ExecuteOptions):Promise<Receipt> {
  const r:Receipt=structuredClone({...plan,status:'completed',rootBeforeBytes:null,rootAfterBytes:null,confirmedReductionBytes:0,attributionComplete:true});
  validateReceipt(r);
  if(r.actions.some(a=>a.status!=='planned'||a.recoveryState!=='prepared'))throw new Error('Execution requires a fresh operation plan');
  if(options.dryRun){r.status='dry-run';return r;}
  const {stateDir}=options;const check=options.checkActivity??defaultActivity;
  if(stateOverlaps(plan,stateDir))throw new Error('Application and source directories overlap');
  const unlock=await acquireLock(stateDir);
  const save=()=>atomicJson(receiptPath(stateDir,r),r);
  const finish=async()=>{updateTotal(r);r.finishedAt=new Date().toISOString();await save();await recordCleanup(stateDir,r);return r;};
  let expectedIndexFingerprint=plan.codexIndexFingerprint;
  try {
    await recoverUnlocked(stateDir,check);
    const pending=(await jsonFiles(join(stateDir,'providers',r.provider,'operations'))).some(({data})=>(data as Receipt).status==='needs-review');
    if(pending)throw new Error('An operation needs review; new mutations blocked. Inspect stats for details');
    r.executionStartedAt=new Date().toISOString();
    const before=await scanPlanScope(r);r.rootBeforeBytes=before.complete?before.totalBytes:null;
    if(!before.complete){r.status='failed';r.warnings.push('Pre-execution scan is incomplete');r.actions.forEach(a=>{a.status='skipped';a.reason='Scan is incomplete';a.recoveryState='finalized';});return await finish();}
    if(!r.actions.length){r.status=plan.scanComplete?'completed':'failed';r.rootAfterBytes=r.rootBeforeBytes;return await finish();}
    const blocked=r.provider==='codex'&&r.actions.some(a=>a.kind==='slim-history')?await verifyCodexRewriteLayout(before,options.signal):new Map<string,string>();
    const duplicateBlocked=r.actions.some(a=>a.kind==='deduplicate-history')?await verifyCodexRewriteLayout(before,options.signal,true):new Map<string,string>();
    r.status='needs-review';await save();
    for(const a of r.actions) {
      if(options.signal?.aborted){r.status='interrupted';break;}
      options.onProgress?.(`${a.kind}: ${a.targetId}`);
      const dir=workPath(stateDir,r,a);
      const busy=await actionActivity(r,a,check,dir);
      if(busy){a.status='skipped';a.reason=busy;a.recoveryState='finalized';r.warnings.push(busy);await save();continue;}
      let projection:Awaited<ReturnType<typeof prepareProjection>>|undefined;
      try {
        if(a.kind==='slim-history'&&blocked.has(a.files[0].path))throw new Error(blocked.get(a.files[0].path));
        if(a.kind==='deduplicate-history')for(const f of a.files)if(duplicateBlocked.has(f.path))throw new Error(duplicateBlocked.get(f.path));
        await verifyRoot(r);
        if(a.files.some(f=>referenced(before,f.path)))throw new Error('References or scan state changed');
        for(const f of a.files)await verifyFile(r.root,f,r);
        const ageReason=ageProtectionReason(a,r.systemTemp?undefined:r.explicitTarget);if(ageReason)throw new Error(ageReason);
        if(a.kind==='codex-delete') {
          const pre=await scanRoot(r.root,r.provider);if(!pre.complete)throw new Error('Scan before native deletion is incomplete');
          const index=await readCodexIndex(pre);if(!index.complete||!expectedIndexFingerprint||index.fingerprint!==expectedIndexFingerprint)throw new Error('Session index or deletion scope changed; preview again');
          await verifyCodexScope(a,index.threads,pre);
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
        if(a.kind==='deduplicate-history') {
          const f=a.files[0],input=await readVerified(r.root,f);
          const {decoded}=await readDuplicate(r.root,a,options.signal);
          if(!input.equals(decoded))throw new Error('Plain and compressed histories differ; both retained');
          if(process.platform==='darwin'){const {stdout}=await exec('/usr/bin/xattr',[f.path],{timeout:5000});if(stdout.trim())throw new Error('File has extended attributes; original retained');}
          projection=await prepareProjection(r.root,a.codexProjection!,input,input,unchangedHistory);
          a.afterBytes=a.files[1].size;await save();
          for(const file of a.files)await verifyFile(r.root,file);
          const activity=await actionActivity(r,a,check,dir);if(activity)throw new Error(activity);
          const age=ageProtectionReason(a);if(age)throw new Error(age);
          await rename(f.path,join(dir,'0.original'));
          await syncDirectory(dirname(f.path));await syncDirectory(dir);
          await verifyBackup(dir,a,0);
          await readDuplicate(r.root,a,options.signal);
          await projection.commit();projection=undefined;
        } else if(replacement(a.kind)) {
          const f=a.files[0];
          if(process.platform==='darwin'){const {stdout}=await exec('/usr/bin/xattr',[f.path],{timeout:5000});if(stdout.trim())throw new Error('File has extended attributes; original retained');}
          const input=await readVerified(r.root,f);
          const slim=a.kind==='slim-history'?slimHistory(input,r.provider,a.slimOptions!):null;
          const output=slim?slim.output:await recompressPng(input);
          if(!output){a.status='skipped';a.reason='Transformation did not reduce file size';a.recoveryState='finalized';await save();continue;}
          if(slim) {
            if(a.beforeHash!==hash(input)||a.afterHash!==hash(output))throw new Error('History differs from its preview; original retained');
            a.slimCounts=slim.counts;a.slimSavingsBytes=slim.savingsBytes;
          }
          a.beforeHash=hash(input);a.afterHash=hash(output);a.afterBytes=output.length;
          const out=await open(join(dir,'output'),'wx',f.mode&0o777);
          try {await out.writeFile(output);await out.chmod(f.mode&0o777);await out.utimes(new Date(f.mtimeMs),new Date(f.mtimeMs));await out.sync();}finally{await out.close();}
          await save();await verifyFile(r.root,f);
          if(a.kind==='slim-history'&&r.provider==='codex') {
            if(!a.codexProjection)throw new Error('History index preview is missing; preview again');
            projection=await prepareProjection(r.root,a.codexProjection,input,output,a.slimOptions!);
          }
          const activity=await actionActivity(r,a,check,dir);if(activity)throw new Error(activity);
          // A hardlink preserves the original inode until the atomic replacement is journaled.
          await link(f.path,join(dir,'0.original'));
          await syncDirectory(dir);
          await verifyBackup(dir,a,0);
          const linked=await lstat(f.path);if(linked.ino!==f.ino||linked.dev!==f.dev||linked.nlink!==2||linked.size!==f.size||linked.mtimeMs!==f.mtimeMs)throw new Error('File changed before replacement');
          await rename(join(dir,'output'),f.path);
          await syncDirectory(dirname(f.path));
          await projection?.commit();projection=undefined;
        } else {
          a.afterBytes=0;await save();
          for(let i=0;i<a.files.length;i++){
            const activity=await actionActivity(r,a,check,dir);if(activity)throw new Error(activity);
            await verifyFile(r.root,a.files[i],r);await rename(a.files[i].path,join(dir,`${i}.original`));await verifyBackup(dir,a,i);
          }
        }
        a.recoveryState='applied';a.status='completed';updateTotal(r);await save();
        await verifyRetainedDuplicate(r,a,check);
        const activity=await actionActivity(r,a,check,dir);if(activity)throw new Error(activity);
        await cleanupWork(dir,a);a.recoveryState='finalized';await save();
      } catch(e) {
        projection?.rollback();
        a.reason=(e as Error).message;
        if(a.recoveryState==='applied'){r.attributionComplete=false;r.status='needs-review';await save();break;}
        if(a.kind==='codex-delete'&&a.nativeStarted){r.attributionComplete=false;a.status='failed';r.status='needs-review';await save();break;}
        const restored=await rollbackPrepared(r,a,dir,check);
        a.status=restored?'skipped':'failed';a.recoveryState=restored?'finalized':'prepared';
        if(!restored){r.attributionComplete=false;r.status='needs-review';await save();break;}
        await save();
      }
    }
    const after=await scanPlanScope(r);r.rootAfterBytes=after.complete?after.totalBytes:null;
    for(const a of r.actions)if(a.status==='planned'){a.status='skipped';a.reason='Operation stopped';a.recoveryState='finalized';}
    if(r.attributionComplete&&r.status!=='interrupted')r.status=r.actions.some(a=>a.status==='failed')?'partial':r.source==='analyze'&&r.actions.length>0&&!r.actions.some(a=>a.status==='completed')?'partial':'completed';
    return await finish();
  } finally {await unlock();}
}
async function rollbackPrepared(r:Plan,a:Action,dir:string,check:ActivityCheck):Promise<boolean> {
  try {
    await verifyParents(r,a);
    if(r.provider==='codex'&&(a.kind==='slim-history'||a.kind==='deduplicate-history'))await verifyProjectionBefore(r.root,a.codexProjection!);
    if(!await existingDir(dir)){for(const f of a.files)await verifyFile(r.root,f,r);return true;}
    if(await actionActivity(r,a,check,dir))return false;
    for(let i=0;i<a.files.length;i++) {
      const f=a.files[i],backup=join(dir,`${i}.original`);
      if(!await exists(backup)){await verifyFile(r.root,f,r);continue;}
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
      if(path!==receiptPath(stateDir,r)||stateOverlaps(r,stateDir))throw new Error('Invalid operation record path');
      if(r.actions.every(a=>a.recoveryState==='finalized')){
        if(r.executionStartedAt&&!r.finishedAt){r.status='interrupted';r.rootAfterBytes=null;r.finishedAt=new Date().toISOString();await atomicJson(path,r);}
        await recordCleanup(stateDir,r);continue;
      }
      let pending=false;
      for(const a of r.actions) {
        if(!uuid.test(a.id)||a.files.some(f=>!within(r.root,f.path)))throw new Error('Recovery target is outside the source directory');
        if(a.recoveryState==='finalized')continue;
        const dir=workPath(stateDir,r,a);
        const busy=await actionActivity(r,a,check,dir);
        if(busy){a.reason=busy;pending=true;continue;}
        if(a.kind==='codex-delete'){if(a.nativeStarted){pending=true;}else{a.status='skipped';a.reason='Previous operation did not start native deletion';a.recoveryState='finalized';}continue;}
        try {
          await verifyParents(r,a);
          if(replacement(a.kind)&&a.recoveryState==='prepared') {
            const f=a.files[0],s=await lstat(f.path).catch(()=>null);
            if(s?.ino===f.ino&&s.dev===f.dev&&s.size===f.size&&s.mtimeMs===f.mtimeMs) {
              if(await rollbackPrepared(r,a,dir,check)){a.status='skipped';a.reason='Previous operation was interrupted; original file was not replaced';a.afterBytes=a.beforeBytes;a.recoveryState='finalized';continue;}
            }
            if(a.afterHash&&s&&(await currentHash(r.root,f.path))===a.afterHash){a.status='completed';a.recoveryState='applied';}
          }
          if(a.recoveryState==='applied') {
            if(a.kind==='deduplicate-history') {
              if(await exists(a.files[0].path))throw new Error('Plain history reappeared; duplicate cleanup needs review');
              const age=ageProtectionReason(a);if(age)throw new Error(age);
              const inventory=await scanRoot(r.root,'codex'),blocked=await verifyCodexRewriteLayout(inventory,undefined,true);
              if(blocked.has(a.files[1].path)||referenced(inventory,a.files[1].path))throw new Error('Compressed history dependencies changed');
              const {decoded}=await readDuplicate(r.root,a);
              const backup=join(dir,'0.original');
              if(await exists(backup)) {
                await verifyBackup(dir,a,0);
                if(!(await readOrdinaryFile(backup,MAX_HISTORY_BYTES)).equals(decoded))throw new Error('Duplicate backup differs from compressed history');
              }
              const projection=await prepareProjection(r.root,a.codexProjection!,decoded,decoded,unchangedHistory,true);
              await projection.commit();
            }
            if(a.kind==='delete-files'&&(await Promise.all(a.files.map(f=>exists(f.path)))).some(Boolean)){pending=true;continue;}
            if(replacement(a.kind)&&(!a.afterHash||(await currentHash(r.root,a.files[0].path))!==a.afterHash)){pending=true;continue;}
            if(provider==='codex'&&a.kind==='slim-history') {
              const backup=join(dir,'0.original');let input:Buffer|null=null;
              if(await exists(backup)) {
                await verifyBackup(dir,a,0);input=await readOrdinaryFile(backup,MAX_HISTORY_BYTES);
                if(hash(input)!==a.beforeHash)throw new Error('Original history backup changed');
              }
              const output=await readOrdinaryFile(a.files[0].path,MAX_HISTORY_BYTES);
              if(hash(output)!==a.afterHash)throw new Error('Rewritten history changed');
              const projection=await prepareProjection(r.root,a.codexProjection!,input,output,a.slimOptions!,true);
              await projection.commit();
            }
            a.status='completed';updateTotal(r);await atomicJson(path,r);
            await verifyRetainedDuplicate(r,a,check);
            const activity=await actionActivity(r,a,check,dir);if(activity)throw new Error(activity);
            await cleanupWork(dir,a);a.recoveryState='finalized';
          } else if(await rollbackPrepared(r,a,dir,check)){a.status='skipped';a.reason='Previous operation was interrupted; original files restored';a.afterBytes=a.beforeBytes;a.recoveryState='finalized';} else pending=true;
        }catch{pending=true;}
      }
      r.attributionComplete=!pending;r.status=pending?'needs-review':'interrupted';
      // A later recovery scan cannot reconstruct the directory size when cleanup was interrupted.
      r.rootAfterBytes=null;r.finishedAt=new Date().toISOString();updateTotal(r);await atomicJson(path,r);await recordCleanup(stateDir,r);
    }
  }
}
export async function recoverOperations(stateDir:string,check:ActivityCheck=defaultActivity) {const unlock=await acquireLock(stateDir);try{await recoverUnlocked(stateDir,check);}finally{await unlock();}}
