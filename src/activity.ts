import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider } from './types.ts';
const exec=promisify(execFile);
export type ActivityCheck=(provider:Provider,root:string,files?:string[])=>Promise<string|null>;
export const checkActivity:ActivityCheck=async(provider,root,files)=>{
  if(process.platform!=='darwin') return 'Mutations are not verified on this platform; analysis only';
  try {
    const {stdout}=await exec('/bin/ps',['-axo','comm='],{timeout:5000,maxBuffer:4*1024*1024});
    const pattern=provider==='codex'?/(?:^|\/)codex(?:$|\s|[-_])|\/Codex\.app\//i:/(?:^|\/)claude(?:$|\s|[-_])|\/Claude\.app\//i;
    if(stdout.split('\n').some(line=>pattern.test(line.trim()))) return `${provider} client or service is running; close it and retry`;
    try {
      const {stdout:opened}=await exec('/usr/sbin/lsof',['-nP','-F','n',...(files && files.length<=500 ? ['--',...files] : ['+D',root])],{timeout:10000,maxBuffer:4*1024*1024});
      if(opened.trim()) return 'Source directory contains open files; close the writer first';
    } catch(e) { const error=e as {code?:number;stdout?:string;stderr?:string}; if(error.code!==1||error.stdout?.trim()||error.stderr?.trim()) return 'Cannot reliably check open files'; }
    return null;
  } catch {return 'Cannot reliably check client activity';}
};
