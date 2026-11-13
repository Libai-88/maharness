import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { activeRun, runLabels, runsApi, type RunInfo } from '../run-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import RunDiagnostics from './RunDiagnostics';

export default function RunsView({ onSession }: { onSession: (id: string) => void }) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [selected, setSelected] = useState<RunInfo | null>(null);
  const [error, setError] = useState('');
  const refresh = () => runsApi.list().then(setRuns).catch(error => setError(String(error)));
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, []);
  const inspect = (run: RunInfo) => setSelected(run);
  return <ScrollArea className="min-h-0 flex-1"><div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
    <div className="flex items-center justify-between gap-2"><h1 className="text-xl font-semibold">任务</h1><Button variant="outline" onClick={() => void refresh()}>刷新</Button></div>
    {error && <p role="alert">{error}</p>}
    {!runs.length && <Empty><EmptyHeader><EmptyTitle>暂无任务</EmptyTitle><EmptyDescription>会话发起的任务、子任务与运行结果将保存在这里。</EmptyDescription></EmptyHeader></Empty>}
    {runs.filter(run => !run.parentId).map(run => <Card key={run.id}>
      <CardHeader><CardTitle className="break-words">{run.objective}</CardTitle><CardDescription>{run.model} · ${run.cost.toFixed(4)} · {new Date(run.createdAt).toLocaleString()}</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{runLabels[run.status]}</Badge><Badge variant="outline">{run.verification ? '有验收记录' : '尚未验证'}</Badge><Button size="sm" variant="outline" onClick={() => onSession(run.sessionId)}>打开会话</Button><Button size="sm" variant="outline" onClick={() => void inspect(run)}>诊断与子任务</Button>{activeRun(run) && <Button size="sm" variant="outline" onClick={() => void runsApi.cancel(run.id).then(refresh).catch(error => toast.error(String(error)))}>停止</Button>}</CardContent>
    </Card>)}
    {selected && <Card><CardHeader><CardTitle>任务诊断</CardTitle><CardDescription>{selected.id}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><Button variant="outline" onClick={() => setSelected(null)}>关闭详情</Button><RunDiagnostics run={runs.find(run => run.id === selected.id) ?? selected} onInspect={setSelected} /></CardContent></Card>}
  </div></ScrollArea>;
}
