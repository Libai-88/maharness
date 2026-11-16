import { useEffect, useRef, useState } from 'react';
import { runsApi, type RunArtifact } from '../run-api';
import { latestRunFiles } from '../run-status';
import { materialApi, type Material } from '../material-api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Attachment, AttachmentContent, AttachmentTitle, AttachmentDescription } from '@/components/ui/attachment';
export default function RunFiles({ sessionId, revision, runId, onOpen }: { runId?: string; sessionId?: string; revision?: number; onOpen: (material: Material) => void }) {
  const [files, setFiles] = useState<RunArtifact[]>([]); const [error, setError] = useState('');
  const selectedSession = useRef(sessionId);
  useEffect(() => {
    let alive = true;
    if (selectedSession.current !== sessionId) { selectedSession.current = sessionId; setFiles([]); setError(''); }
    if (!sessionId) return;
    void (runId ? runsApi.artifacts(runId).then(files => [files]) : runsApi.list(sessionId).then(runs => Promise.all(runs.map(run => runsApi.artifacts(run.id)))))
      .then(rows => { if (alive) { setFiles(latestRunFiles(rows.flat())); setError(''); } })
      .catch(error => { if (alive) setError(String(error)); });
    return () => { alive = false; };
  }, [sessionId, revision, runId]);
  if (!files.length && !error) return null;
  return <div className="flex max-h-52 flex-col gap-2 overflow-auto px-4 py-2" aria-label="任务文件">
    {error && <p role="alert" className="text-sm text-destructive">文件列表读取失败：{error}</p>}
    {files.map(file => <Attachment key={file.id} className="w-full" data-testid="run-file">
      <AttachmentContent>
        <AttachmentTitle>{file.label}</AttachmentTitle>
        <AttachmentDescription>{file.ref}</AttachmentDescription>
        {file.metadata?.status && <div className="flex flex-wrap items-center gap-2">
          <Badge variant={file.metadata.status === 'draft' ? 'secondary' : 'outline'}>{file.metadata.status === 'draft' ? '草稿' : '最终文件'}</Badge>
          <span className="text-xs text-muted-foreground">{file.metadata.format?.toUpperCase()} · 已保存 {file.metadata.count ?? 0} 个内容块 · {new Date(file.createdAt).toLocaleString()}</span>
        </div>}
      </AttachmentContent>
      <Button variant="outline" size="sm" onClick={() => void materialApi.artifact(file.runId, file.id).then(onOpen).catch(error => toast.error(String(error)))}>预览 / 继续处理</Button>
      <Button variant="ghost" size="sm" onClick={() => void materialApi.artifact(file.runId, file.id).then(materialApi.download).catch(error => toast.error(String(error)))}>下载</Button>
    </Attachment>)}
  </div>;
}
