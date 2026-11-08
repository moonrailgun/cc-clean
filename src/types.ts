export type Provider = 'claude' | 'codex';
export interface FileEntry {
  path: string; relative: string; size: number; allocatedBytes: number;
  mtimeMs: number; ctimeMs: number; dev: number; ino: number; nlink: number; mode: number;
  category: string;
}
export interface Inventory {
  provider: Provider; root: string; exists: boolean; complete: boolean;
  files: FileEntry[]; links: {path: string; target: string}[];
  totalBytes: number; allocatedBytes: number; errors: string[];
}
export interface ScanProgress {
  phase: 'discovering' | 'sessions' | 'index' | 'finalizing' | 'estimating';
  completed: number; total: number | null;
  processedBytes?: number; totalBytes?: number; currentFile?: string;
}
export interface Usage {
  userMessages: number | null; toolCalls: number | null; inputTokens: number | null;
  outputTokens: number | null; cachedTokens: number | null; reasoningTokens: number | null;
  verified: boolean;
}
export interface Session {
  id: string; provider: Provider; project: string | null; parentId?: string;
  files: FileEntry[]; bytes: number; updatedAt: string; createdAt?: string;
  model?: string; version?: string; archived: boolean; complete: boolean;
  observedProjects?: string[]; indexOnly?: boolean;
  usage: Usage; warnings: string[];
}
export interface Analysis {
  schemaVersion: 1; provider: Provider; root: string; totalBytes: number;
  scanComplete: boolean; scannedAt: string; fileCount: number;
  categories: {name: string; bytes: number; files: number}[];
  directories: {name: string; bytes: number; files: number}[];
  projects: {path: string; bytes: number; sessions: number; updatedAt: string; usage: Usage}[];
  sessions: Session[]; sharedBytes: number; unattributedBytes: number;
  usage: Usage & {parsedFiles: number; totalFiles: number; byDate: Record<string, Usage>; byModel: Record<string, Usage>};
  opportunities: {pngBytes: number; pngCount: number; embeddedImageBytes: number; duplicateImageBytes: number; fields: {path: string; bytes: number; count: number}[]; recordTypes: {type: string; bytes: number; count: number}[]};
  warnings: string[];
}
