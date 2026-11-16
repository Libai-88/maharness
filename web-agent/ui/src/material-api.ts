import { api, authHeaders } from './api';
export interface MaterialRef { id: string; version: string }
export interface Material extends MaterialRef { name: string; path: string; format: string; size: number; workspace: string; createdAt: number }
export interface DocumentBlock { id: string; type: string; text: string; anchor: { version: string; blockId: string; page?: number; sheet?: string; cell?: string; slide?: number }; rows?: string[][]; image?: string; formula?: string }
export interface DocumentContent { version: string; format: string; blocks: DocumentBlock[]; total: number; nextOffset?: number; warnings: string[]; editable: boolean }
export interface MaterialCapabilities { document: boolean; search: boolean; maxBytes: number; maxAttachments: number; ocr: { image: boolean; pdf: boolean; status: string; config: { command?: string; args?: string[]; pdfCommand?: string; pdfArgs?: string[] } } }
async function checked(response: Response) { if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error ?? `文件请求失败（${response.status}）`); } return response; }
export const materialApi = {
  capabilities: () => api<MaterialCapabilities>('/api/materials/capabilities'),
  configureOcr: (config: MaterialCapabilities['ocr']['config']) => api('/api/document/ocr', { method: 'PUT', body: JSON.stringify(config) }),
  register: (path: string) => api<Material>('/api/materials/register', { method: 'POST', body: JSON.stringify({ path }) }),
  artifact: (runId: string, artifactId: string) => api<Material>('/api/materials/artifact', { method: 'POST', body: JSON.stringify({ runId, artifactId }) }),
  get: (id: string) => api<Material>(`/api/materials/${encodeURIComponent(id)}`),
  async upload(file: File) { if (file.size > 20 * 1024 * 1024) throw new Error('单文件不能超过 20 MB'); const response = await checked(await fetch(`/api/materials/import?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { ...authHeaders('POST'), 'Content-Type': 'application/octet-stream' }, body: file })); return response.json() as Promise<Material>; },
  preview: (material: MaterialRef, offset = 0, block?: string) => api<DocumentContent>(`/api/materials/${encodeURIComponent(material.id)}/preview?version=${encodeURIComponent(material.version)}&offset=${offset}${block ? `&block=${encodeURIComponent(block)}` : ''}`),
  async blob(material: MaterialRef) { return (await checked(await fetch(`/api/materials/${encodeURIComponent(material.id)}/content?version=${encodeURIComponent(material.version)}`, { headers: authHeaders() }))).blob(); },
  async download(material: Material) { const blob = await materialApi.blob(material); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = material.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); },
};
