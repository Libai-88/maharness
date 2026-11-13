import type { ToolResult } from './types';

export interface ToolResultPage { id: string; content: string; length: number; offset: number; nextOffset?: number; truncated: boolean; }
export interface ToolExecutionJournal {
  start(id: string, name: string, argsSummary: string): void;
  finish(id: string, result: ToolResult): void;
  read(id: string, offset?: number, limit?: number): ToolResultPage | undefined;
}

export function resultPage(id: string, content: string, offset = 0, limit = 4000): ToolResultPage {
  const start = Math.min(content.length, Math.max(0, Math.floor(offset)));
  const size = Math.min(16000, Math.max(1, Math.floor(limit)));
  const end = Math.min(content.length, start + size);
  return { id, content: content.slice(start, end), length: content.length, offset: start, truncated: end < content.length, ...(end < content.length ? { nextOffset: end } : {}) };
}
