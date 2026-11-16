/** Generic versioned file references shared by runs and capability providers. */
export interface MaterialRef { id: string; version: string }
export interface Material extends MaterialRef {
  tenantId: string; workspace: string; path: string; name: string;
  format: string; size: number; createdAt: number;
}
export interface SourceAnchor {
  version: string; blockId: string; page?: number; sheet?: string; cell?: string; slide?: number;
}
export interface DocumentBlock {
  id: string; type: 'paragraph' | 'heading' | 'listItem' | 'table' | 'cell' | 'image' | 'page';
  text: string; anchor: SourceAnchor; rows?: string[][]; image?: string; formula?: string;
}
export interface DocumentContent {
  format: string; version: string; blocks: DocumentBlock[]; total: number;
  nextOffset?: number; warnings: string[]; editable: boolean;
}
