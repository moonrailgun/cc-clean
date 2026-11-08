import type { FileEntry, Provider } from './types.ts';
export interface Action {
  id:string;kind:'delete-files'|'compress-png'|'codex-delete';targetId:string;files:FileEntry[];
  sessionIds?:string[];status:'planned'|'completed'|'skipped'|'failed';reason?:string;
  beforeBytes:number;afterBytes:number;recoveryState:'prepared'|'applied'|'finalized';
  estimatedSavingsBytes?:number|null;
  beforeHash?:string;afterHash?:string;nativeStarted?:boolean;
}
export interface Plan {
  schemaVersion:1;operationId:string;provider:Provider;root:string;version:string;
  source:'clean'|'analyze';startedAt:string;actions:Action[];warnings:string[];scanComplete:boolean;
  rootIdentity?:{dev:number;ino:number};codexIndexFingerprint?:string;
}
export interface Receipt extends Plan {
  status:'completed'|'partial'|'failed'|'interrupted'|'needs-review'|'dry-run';
  rootBeforeBytes:number|null;rootAfterBytes:number|null;confirmedReductionBytes:number;
  attributionComplete:boolean;executionStartedAt?:string;finishedAt?:string;
}
