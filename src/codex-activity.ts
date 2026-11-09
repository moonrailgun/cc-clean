import { lstat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { readActivityProcesses, type ActivityCommand } from './claude-activity.ts';
import { readCodexHeader } from './providers/codex-history.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const native=/(?:^|\/)codex(?:$|\s|[-_])|\/(?:Codex|CodexCLI)\.app\//i;
const npm=/^(?:"[^"]*\/(?:node|bun)"|(?:[^\s]*\/)?(?:node|bun))\s+(?:--[^\s]+\s+)*(?:"[^"]*\/@openai\/codex\/bin\/codex\.js"|[^\s]*\/@openai\/codex\/bin\/codex\.js)(?:\s|$)/i;
const options={timeout:5000,maxBuffer:4*1024*1024};
function fail():never {throw new Error('Unverified Codex session ownership');}

// This gates the running writer-lock protocol, never the version of a history file.
function supportsWriterLocks(version:string) {
  const m=/^codex-cli (\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+)(?:\.\d+)?)?\s*$/.exec(version);
  return !!m&&(Number(m[1])>0||Number(m[2])>164||Number(m[2])===164&&(Number(m[3])>0||m[4]===undefined||Number(m[4])>=11));
}

interface Descriptor {pid:number;fd:string;path:string;dev:string;ino:string}
function descriptors(stdout:string):Descriptor[] {
  const result:Descriptor[]=[];let pid=0,entry:Descriptor|undefined;
  for(const line of stdout.split('\n')) {
    if(!line)continue;
    if(line[0]==='p') {pid=Number(line.slice(1));entry=undefined;if(!Number.isSafeInteger(pid)||pid<=0)fail();}
    else if(line[0]==='f') {if(!pid)fail();entry={pid,fd:line.slice(1),path:'',dev:'',ino:''};result.push(entry);}
    else if(entry&&line[0]==='n')entry.path=line.slice(1);
    else if(entry&&line[0]==='D')entry.dev=String(BigInt(line.slice(1)));
    else if(entry&&line[0]==='i')entry.ino=line.slice(1);
    else fail();
  }
  return result;
}

export async function codexActiveSessions(run:ActivityCommand,root:string):Promise<string[]> {
  const versions=new Map<string,string>();
  const snapshot=async()=>{
    const rows=await readActivityProcesses(run,native,npm),ids=new Set<string>(),proof:unknown[]=[];
    if(rows.some(p=>p.uid!==process.getuid?.()))fail();
    if(!rows.length)return {sessionIds:[],identity:'[]'};
    const {stdout,stderr}=await run('/usr/sbin/lsof',['-nP','-a','-p',rows.map(p=>p.pid).join(','),'-F','pfnDi'],{...options,timeout:10000});
    if(stderr?.trim())fail();
    const opened=descriptors(stdout),writers=new Set<number>();
    for(const p of rows) {
      if(basename(p.comm)!=='codex')continue;
      if(!isAbsolute(p.comm)||resolve(p.comm)!==p.comm)fail();
      // npm upgrades can rename the still-running executable; inspect that loaded file, not its replacement.
      const executables=opened.filter(f=>f.pid===p.pid&&f.fd==='txt'&&basename(f.path)==='codex');
      if(executables.length!==1)fail();
      const executable=executables[0];
      if(!executable?.ino||!executable.dev)fail();
      if(!isAbsolute(executable.path)||resolve(executable.path)!==executable.path)fail();
      const identity=`${executable.dev}:${executable.ino}`;
      const held=opened.filter(f=>f.pid===p.pid&&/^\d/.test(f.fd)&&/\/thread-writer-locks\//.test(f.path));
      for(const f of held)if(!f.path.endsWith('/.coordination.lock')&&(!f.path.endsWith('.lock')||!uuid.test(basename(f.path).slice(0,-5))))fail();
      // Held session locks prove the lifetime protocol even if an npm upgrade unlinked this binary.
      if(held.some(f=>uuid.test(basename(f.path).slice(0,-5)))) {
        writers.add(p.pid);proof.push([p.pid,identity,held.map(f=>[f.path,f.dev,f.ino])]);continue;
      }
      const stat=async()=>{if((await run('/usr/bin/stat',['-f','%d:%i',executable.path],options)).stdout.trim()!==identity)fail();};
      await stat();
      const key=executable.path+':'+identity;
      if(!versions.has(key)) {
        const {stdout:version}=await run(executable.path,['--version'],options);
        if(!supportsWriterLocks(version))fail();
        await stat();versions.set(key,version.trim());
      }
      writers.add(p.pid);proof.push([p.pid,identity,versions.get(key)]);
    }
    for(const p of rows) {
      if(writers.has(p.pid))continue;
      if(basename(p.comm)==='codex-code-mode-host'&&writers.has(p.ppid))continue;
      if(npm.test(p.args)&&rows.some(child=>child.ppid===p.pid&&writers.has(child.pid)))continue;
      fail();
    }
    for(const f of opened) {
      if(!f.path.startsWith(root+'/thread-writer-locks/'))continue;
      const name=f.path.slice((root+'/thread-writer-locks/').length);
      if(!writers.has(f.pid)||!/^\d/.test(f.fd)||!name.endsWith('.lock')||!uuid.test(name.slice(0,-5)))fail();
      ids.add(name.slice(0,-5).toLowerCase());proof.push([f.pid,name,f.dev,f.ino]);
    }
    return {sessionIds:[...ids].sort(),identity:JSON.stringify([rows,proof])};
  };
  const before=await snapshot(),after=await snapshot();
  if(before.identity!==after.identity)fail();
  return after.sessionIds;
}

export async function codexSessionOwners(files:string[]):Promise<Record<string,string[]>> {
  const owners:Record<string,string[]>={};
  for(const path of new Set(files)) {
    owners[path]=[];
    try {
      const stat=await lstat(path);
      const {payload}=await readCodexHeader({...stat,path},undefined,{allowAppend:true,detectCompression:true});
      const ids=[...new Set([payload.id,...payload.session_id===undefined?[]:[payload.session_id]])];
      if(ids.every(id=>typeof id==='string'&&uuid.test(id)))owners[path]=ids.map(id=>id.toLowerCase());
    } catch { /* Unknown ownership remains protected while sessions are open. */ }
  }
  return owners;
}
