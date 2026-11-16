import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { materialApi, type Material, type DocumentContent } from '../material-api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
const PdfPreview = lazy(() => import('./PdfPreview'));
export default function MaterialViewer({ material, focusBlock, page, onUse }: { material: Material; focusBlock?: string; page?: number; onUse?: (material: Material, quote?: string) => void }) {
  const [content, setContent] = useState<DocumentContent>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const root = useRef<HTMLDivElement>(null);
  useEffect(() => { let alive = true; setContent(undefined); setError(''); void materialApi.preview(material, 0, focusBlock).then(value => { if (alive) setContent(value); }).catch(error => { if (alive) setError(String(error)); }); return () => { alive = false; }; }, [material.id, material.version, focusBlock]);
  useEffect(() => { if (content && focusBlock) root.current?.querySelector(`[data-block="${CSS.escape(focusBlock)}"]`)?.scrollIntoView({ block: 'center' }); }, [content, focusBlock]);
  const more = async () => { if (!content || content.nextOffset === undefined) return; setLoading(true); try { const next = await materialApi.preview(material, content.nextOffset); setContent({ ...next, blocks: [...content.blocks, ...next.blocks] }); } catch (error) { setError(String(error)); } finally { setLoading(false); } };
  const useSelection = () => { const selection = window.getSelection(); const selected = selection?.anchorNode && root.current?.contains(selection.anchorNode) ? selection.toString().slice(0, 8000) : ''; onUse?.(material, selected || undefined); };
  return <div ref={root} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4" data-testid="material-viewer"><div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{material.format === 'pdf' ? 'PDF 原页' : '内容预览'}</Badge><span className="min-w-0 flex-1 break-all text-sm">{material.path}</span><Button type="button" variant="outline" size="sm" onClick={() => void materialApi.download(material).catch(error => toast.error(String(error)))}>下载文件</Button>{onUse && <Button type="button" size="sm" onClick={useSelection}>用此文件提问 / 引用选中文字</Button>}</div>
    {error && <Alert variant="destructive"><AlertTitle>文件预览失败</AlertTitle><AlertDescription>{error}。可重新选择当前版本，或在本地应用中打开文件。</AlertDescription></Alert>}
    {material.format === 'pdf' && <Suspense fallback={<Spinner />}><PdfPreview key={`${material.id}:${page}`} material={material} initialPage={page} /></Suspense>}
    {!content && !error && <Spinner />}{content?.warnings.map(warning => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
    {content?.blocks.map(block => <section key={block.id} data-block={block.id} className="flex flex-col gap-2 rounded border p-3"><div className="flex flex-wrap gap-2 text-xs text-muted-foreground">{block.anchor.page && <span>第 {block.anchor.page} 页</span>}{block.anchor.slide && <span>幻灯片 {block.anchor.slide}</span>}{block.anchor.sheet && <span>{block.anchor.sheet} · {block.anchor.cell}</span>}{block.type === 'listItem' && <span>列表项</span>}{!block.anchor.page && !block.anchor.slide && !block.anchor.sheet && block.type !== 'listItem' && <span>{block.type === 'table' ? '表格' : '文档内容'}</span>}</div>{block.type === 'heading' ? <h3>{block.text}</h3> : block.text && <p className="whitespace-pre-wrap break-words text-sm">{block.text}</p>}{block.formula && <p className="text-xs text-muted-foreground">公式：{block.formula} · 显示缓存值</p>}{block.rows && <Table><TableBody>{block.rows.map((row, i) => <TableRow key={i}>{row.map((cell, j) => <TableCell key={j}>{cell}</TableCell>)}</TableRow>)}</TableBody></Table>}{block.image && <img src={block.image} alt={`幻灯片 ${block.anchor.slide} 中的图片`} className="max-h-96 max-w-full object-contain" />}</section>)}
    {content?.nextOffset !== undefined && <Button type="button" variant="outline" disabled={loading} onClick={() => void more()}>{loading ? '读取中…' : `继续读取（已显示 ${content.blocks.length} / ${content.total} 块）`}</Button>}
  </div>;
}
