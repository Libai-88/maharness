import RunFiles from './RunFiles';
import MaterialViewer from './MaterialViewer';
import type { Material } from '../material-api';
import { api } from '../api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { verificationLabel } from '../run-status';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { activeRun, runLabels, runsApi, type RunInfo } from '../run-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import RunDiagnostics from './RunDiagnostics';
import ExperienceReviewPanel from './ExperienceReviewPanel';

export default function RunsView({ onSession }: { onSession: (id: string) => void }) {
  const [viewing, setViewing] = useState<Material>();
  const [items, setItems] = useState<{ id: string; title: string; executionSessionId?: string }[]>([]);
  useEffect(() => {
    void api<{ items: typeof items }>('/api/items')
      .then((value) => setItems(value.items))
      .catch(() => {});
  }, []);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [selected, setSelected] = useState<RunInfo | null>(null);
  const [reviewIds, setReviewIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const refresh = () =>
    runsApi
      .list()
      .then(setRuns)
      .catch((error) => setError(String(error)));
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);
  const inspect = (run: RunInfo) => setSelected(run);
  const reviewable = runs.filter((run) => !run.parentId && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status));
  const selectedReviewRuns = reviewable.filter((run) => reviewIds.includes(run.id));
  const reviewModel = selectedReviewRuns[0] ? `${selectedReviewRuns[0].providerId}\u0000${selectedReviewRuns[0].model}` : undefined;
  const toggleReview = (run: RunInfo) => {
    setReviewIds((current) => {
      if (current.includes(run.id)) return current.filter((id) => id !== run.id);
      if (
        current.length >= 10 ||
        current.some((id) => {
          const selectedRun = reviewable.find((item) => item.id === id);
          return selectedRun && (selectedRun.providerId !== run.providerId || selectedRun.model !== run.model);
        })
      )
        return current;
      return [...current, run.id];
    });
  };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">运行记录</h1>
          <Button variant="outline" onClick={() => void refresh()}>
            刷新
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!runs.length && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>暂无任务</EmptyTitle>
              <EmptyDescription>会话发起的任务、子任务与运行结果将保存在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {reviewable.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>AI 用户复盘</CardTitle>
              <CardDescription>
                选择 1 至 10 条同一原始模型的已结束运行，由原模型在新上下文中复盘自己的使用历程。右侧“诊断与子任务”提供单次快捷入口。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid max-h-52 gap-2 overflow-auto rounded-md border p-2 sm:grid-cols-2">
                {reviewable.map((run) => {
                  const compatible =
                    !!reviewModel && run.providerId === selectedReviewRuns[0]?.providerId && run.model === selectedReviewRuns[0]?.model;
                  const checked = reviewIds.includes(run.id);
                  return (
                    <label key={run.id} className={`flex items-start gap-2 rounded-md p-2 text-sm ${checked ? 'bg-muted' : ''}`}>
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={checked}
                        disabled={!checked && ((!compatible && reviewIds.length > 0) || reviewIds.length >= 10)}
                        onChange={() => toggleReview(run)}
                      />
                      <span className="min-w-0">
                        <span className="block truncate">{run.objective}</span>
                        <span className="text-xs text-muted-foreground">
                          {run.providerId} / {run.model} · {runLabels[run.status]}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {reviewIds.length > 0 && <ExperienceReviewPanel runIds={reviewIds} />}
            </CardContent>
          </Card>
        )}
        {runs
          .filter((run) => !run.parentId)
          .map((run) => (
            <Card key={run.id}>
              <CardHeader>
                <CardTitle className="break-words">{run.objective}</CardTitle>
                <CardDescription>{new Date(run.createdAt).toLocaleString()}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {items.find((item) => item.executionSessionId === run.sessionId) && (
                  <p className="text-sm">
                    关联事项：
                    <a
                      className="underline"
                      href={`/todo.html?item=${encodeURIComponent(items.find((item) => item.executionSessionId === run.sessionId)!.id)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {items.find((item) => item.executionSessionId === run.sessionId)!.title}
                    </a>
                  </p>
                )}
                {run.answer && <p className="whitespace-pre-wrap text-sm">{run.answer.slice(0, 1000)}</p>}
                {run.error && (
                  <p role="alert" className="text-sm">
                    {run.error}
                  </p>
                )}
                <RunFiles runId={run.id} sessionId={run.sessionId} revision={run.updatedAt} onOpen={setViewing} />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{runLabels[run.status]}</Badge>
                  <Badge variant="outline">{verificationLabel(run.verification)}</Badge>
                  <Button size="sm" variant="outline" onClick={() => onSession(run.sessionId)}>
                    打开会话
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void inspect(run)}>
                    诊断与子任务
                  </Button>
                  {activeRun(run) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void runsApi
                          .cancel(run.id)
                          .then(refresh)
                          .catch((error) => toast.error(String(error)))
                      }
                    >
                      停止
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        <Dialog
          open={!!viewing}
          onOpenChange={(open) => {
            if (!open) setViewing(undefined);
          }}
        >
          <DialogContent className="flex h-[90dvh] max-w-5xl flex-col sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>{viewing?.name}</DialogTitle>
            </DialogHeader>
            {viewing && <MaterialViewer material={viewing} />}
          </DialogContent>
        </Dialog>
        {selected && (
          <Card>
            <CardHeader>
              <CardTitle>任务诊断</CardTitle>
              <CardDescription>{selected.id}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Button variant="outline" onClick={() => setSelected(null)}>
                关闭详情
              </Button>
              <RunDiagnostics run={runs.find((run) => run.id === selected.id) ?? selected} onInspect={setSelected} />
            </CardContent>
          </Card>
        )}
      </div>
    </ScrollArea>
  );
}
