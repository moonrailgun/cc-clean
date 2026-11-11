// SPDX-License-Identifier: Apache-2.0
// Adapted from RTK 0.49.0 cmds/cloud/container.rs at
// 653efb6ed02bd287d686c50e830dd1009356904f. No child commands or tee files.
import { json, lines, object, string, uint, type Filter, type Obj } from './rtk-native-common.ts';
function ports(raw:string):string {if(!raw)return '-';const p=raw.split(',').map(s=>s.split('->')[0].split(':').at(-1)!);return p.length<=3?p.join(', '):`${p.slice(0,2).join(', ')}, … +${p.length-2}`;}
function container(parts:string[],withPorts:boolean):string {const p=ports(parts[4]??'');return `  ${parts[0].slice(0,12)} ${parts[1]} (${parts[3].split('/').at(-1)}) ${parts[2].trim()}${withPorts&&p!=='-'?` [${p}]`:''}\n`;}
function dockerPs(input:string,all:boolean):string {
  const rows=lines(input).filter(l=>l.trim()).map(l=>l.split('\t'));
  if(!rows.length||rows.some(p=>p.length!==(all?6:5)||!/^[a-f\d]{12,64}$/.test(p[all?1:0])||!p[all?2:1]||!p[all?4:3]))return input;
  if(all&&rows.some(p=>!['running','restarting','created','paused','removing','exited','dead'].includes(p[0])))return input;
  const section=(label:string,items:string[])=>`[docker] ${items.length} ${label}:\n${items.slice(0,20).join('')}${items.length>20?`  … +${items.length-20} more\n`:''}`;
  if(!all)return section('containers',rows.map(p=>container(p,true)));
  const running=rows.filter(p=>['running','restarting'].includes(p[0])).map(p=>container(p.slice(1),true));
  const stopped=rows.filter(p=>!['running','restarting'].includes(p[0])).map(p=>container(p.slice(1),false));
  return section('running',running)+(stopped.length?section('stopped/exited',stopped):'');
}
function dockerImages(input:string):string {
  const rows=lines(input).filter(l=>l.trim()).map(l=>l.split('\t'));
  if(!rows.length||rows.some(p=>p.length!==2||!p[0]||!/^\s*\d+(?:\.\d+)?\s*(?:GB|MB|kB|B)\s*$/.test(p[1])))return input;
  const mb=rows.reduce((n,p)=>n+(p[1].includes('GB')?parseFloat(p[1])*1024:p[1].includes('MB')?parseFloat(p[1]):0),0);
  return `[docker] ${rows.length} images (${mb>1024?`${(mb/1024).toFixed(1)}GB`:`${mb.toFixed(0)}MB`})\n${rows.slice(0,50).map(p=>`  ${p[0]} [${p[1]}]\n`).join('')}${rows.length>50?`  … +${rows.length-50} more\n`:''}`;
}
function composePs(input:string):string {
  const rows=lines(input).filter(l=>l.trim()).map(l=>l.split('\t'));
  if(!rows.length||rows.some(p=>p.length!==4||!p[0]||!p[1]||!p[2]))return input;
  const out=[`[compose] ${rows.length} services:`,...rows.slice(0,20).map(p=>{const port=ports(p[3].trim());return `  ${p[0]} (${p[1].split('/').at(-1)}) ${p[2]}${port!=='-'?` [${port}]`:''}`;})];
  if(rows.length>20)out.push(`  … +${rows.length-20} more`);return out.join('\n');
}
function composeBuild(input:string):string {
  const ls=lines(input),finished=ls.find(l=>/^\s*\[\+\] Building .* FINISHED/.test(l));
  if(!finished||ls.some(l=>/\b(?:ERROR|error|failed)\b/.test(l)))return input;
  const services=[...new Set(ls.flatMap(l=>{const b=l.match(/\[([^\]]+)\]/)?.[1].split(/\s+/)[0];return b&&b!=='+'?[b]:[];}))];
  const steps=ls.filter(l=>l.trimStart().startsWith('=> ')).length;
  return [`[compose] ${finished.trim()}`,...(services.length?[`  Services: ${services.join(', ')}`]:[]),...(steps?[`  Steps: ${steps}`]:[])].join('\n');
}
function kubeItems(input:string,kind:string):Obj[]|undefined {
  const value=json(input);if(!object(value)||!Array.isArray(value.items)||value.kind!==undefined&&!['List',kind].includes(value.kind as string))return;
  if(!value.items.every(i=>object(i)&&object(i.metadata)&&string(i.metadata.name)&&(i.metadata.namespace===undefined||string(i.metadata.namespace))))return;
  return value.items as Obj[];
}
function kubePods(input:string):string {
  const pods=kubeItems(input,'PodList');if(!pods)return input;
  let running=0,pending=0,failed=0,restarts=0;const issues:string[]=[];
  for(const p of pods){if(!object(p.status)||!string(p.status.phase)||p.status.containerStatuses!==undefined&&!Array.isArray(p.status.containerStatuses))return input;
    // Phase-only summaries hide Pod readiness failures and container waiting reasons.
    if (p.status.conditions !== undefined) {
      const conditions = p.status.conditions;
      if (!Array.isArray(conditions) || conditions.some(c =>
        !object(c) || !string(c.type) || !string(c.status) || c.type === 'Ready' && c.status !== 'True')) return input;
    }
    const meta=p.metadata as Obj,phase=p.status.phase,statuses=(p.status.containerStatuses??[]) as unknown[];
    for(const c of statuses){if(!object(c)||!uint(c.restartCount))return input;restarts+=c.restartCount;if(c.state!==undefined&&!object(c.state))return input;
      if(c.ready===false||object(c.state)&&c.state.waiting!==undefined)return input;
    }
    const name=`${meta.namespace??'-'}/${meta.name}`;
    if(phase==='Running')running++;else if(phase==='Pending'){pending++;issues.push(`${name} Pending`);}else if(['Failed','Error'].includes(phase)){failed++;issues.push(`${name} ${phase}`);}
  }
  if(!pods.length)return 'No pods found\n';
  const parts=[...(running?[`${running}`]:[]),...(pending?[`${pending} pending`]:[]),...(failed?[`${failed} [x]`]:[]),...(restarts?[`${restarts} restarts`]:[])];
  return `${pods.length} pods: ${parts.join(', ')}\n${issues.length?`[warn] Issues:\n${issues.slice(0,10).map(i=>`  ${i}\n`).join('')}${issues.length>10?`  … +${issues.length-10} more`:''}`:''}`;
}
function kubeServices(input:string):string {
  const svcs=kubeItems(input,'ServiceList');if(!svcs)return input;const out:string[]=[];
  for(const s of svcs){if(!object(s.spec)||!string(s.spec.type)||!Array.isArray(s.spec.ports))return input;const ports:string[]=[];
    for(const p of s.spec.ports){if(!object(p)||!uint(p.port)||p.targetPort!==undefined&&!uint(p.targetPort)&&!string(p.targetPort))return input;const target=p.targetPort??p.port;ports.push(target===p.port?`${p.port}`:`${p.port}→${target}`);}
    const meta=s.metadata as Obj;out.push(`  ${meta.namespace??'-'}/${meta.name} ${s.spec.type} [${ports.join(',')}]`);
  }
  return !svcs.length?'No services found\n':`${svcs.length} services:\n${out.slice(0,20).join('\n')}\n${out.length>20?`  … +${out.length-20} more\n`:''}`;
}
export const containerFilters:Record<string,Filter>={'docker-ps':s=>dockerPs(s,false),'docker-ps-all':s=>dockerPs(s,true),'docker-images':dockerImages,'compose-ps':composePs,'compose-build':composeBuild,'kube-pods':kubePods,'kube-services':kubeServices};
export function matchContainerFilter(argv:string[]):string|undefined {
  const [exe,sub,next]=argv;
  const value=(flag:string)=>{const i=argv.indexOf(flag);return i>=0?argv[i+1]:argv.find(a=>a.startsWith(`${flag}=`))?.slice(flag.length+1);};
  const format=value('--format')?.replace(/\\t/g,'\t');
  if(exe==='docker') {
    if(sub==='ps') {
      if(format==='{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}')return 'docker-ps';
      if(format==='{{.State}}\t{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}')return 'docker-ps-all';
    }
    if(sub==='images'&&format==='{{.Repository}}:{{.Tag}}\t{{.Size}}')return 'docker-images';
    if(sub==='compose'&&next==='ps'&&format==='{{.Name}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}')return 'compose-ps';
    if(sub==='compose'&&next==='build')return 'compose-build';
  }
  if(['kubectl','oc'].includes(exe)&&sub==='get'&&(value('-o')==='json'||value('--output')==='json'||argv.includes('-ojson'))){if(['pods','pod','po'].includes(next))return 'kube-pods';if(['services','service','svc'].includes(next))return 'kube-services';}
  return undefined;
}
