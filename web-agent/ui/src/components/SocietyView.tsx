import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { approvalsApi, subscribeEvents } from '../api';
import { activeRun, runLabels, runsApi, subscribeRun, type RunInfo, type RunSummary, type RunTool } from '../run-api';
import type { WorkOrderView } from '../workbench-api';
import { api } from '../api';
import type { Material } from '../material-api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import RunControls from './RunControls';
import RunDiagnostics from './RunDiagnostics';
import RunFiles from './RunFiles';
import MaterialViewer from './MaterialViewer';
import WorkbenchView from './WorkbenchView';

interface Props {
  onSession: (id: string) => void;
  onAutomations: () => void;
  onOpenWorkbench: () => void;
}

const groups = [
  { label: '正在执行', statuses: ['running', 'queued', 'stopping'] },
  { label: '等待处理', statuses: ['waiting_approval', 'interrupted'] },
  { label: '已交付', statuses: ['completed'] },
  { label: '异常与取消', statuses: ['failed', 'cancelled'] },
];

export default function SocietyView(props: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [detail, setDetail] = useState<RunInfo>();
  const [approval, setApproval] = useState<{ runId: string; id: string; name: string; summary: string; token?: string }>();
  const [responding, setResponding] = useState(false);
  const [order, setOrder] = useState<Pick<WorkOrderView, 'id' | 'contracts' | 'roles'>>();
  const [selected, setSelected] = useState<string>();
  const [teamCycles, setTeamCycles] = useState<{ id: string; assignments: string[]; status: string }[]>([]);
  const [tools, setTools] = useState<RunTool[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<Material>();
  const [secondary, setSecondary] = useState(false);
  const [trace, setTrace] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      setRuns(await runsApi.summaries());
      setError('');
    } catch (reason) {
      setError(String(reason));
    }
  }, []);
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeEvents(
      () => {
        if (!timer)
          timer = setTimeout(() => {
            timer = undefined;
            void refresh();
          }, 300);
      },
      (state) => {
        setConnected(state === 'open');
        if (state === 'open') void refresh();
      },
    );
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [refresh]);
  const selectedSummary = runs.find((item) => item.id === selected);
  const run = detail?.id === selected ? detail : undefined;
  const orderId = run?.workOrderId;
  useEffect(() => {
    if (!selected) return;
    let current = true;
    void runsApi
      .get(selected)
      .then((value) => {
        if (current) setDetail(value);
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [selected, selectedSummary?.updatedAt]);
  useEffect(() => {
    setTeamCycles([]);
    setOrder(undefined);
    if (!orderId) return;
    let current = true;
    void api<{
      workOrder: { id: string };
      contracts: WorkOrderView['contracts'];
      roles: WorkOrderView['roles'];
      teamCycles?: typeof teamCycles;
    }>(`/api/work-orders/${encodeURIComponent(orderId)}`)
      .then((value) => {
        if (current) {
          setOrder({ id: value.workOrder.id, contracts: value.contracts, roles: value.roles });
          setTeamCycles(value.teamCycles ?? []);
        }
      })
      .catch((reason) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [orderId, run?.updatedAt]);
  useEffect(() => {
    if (!selected || !run || !activeRun(run)) return;
    const controller = new AbortController();
    void subscribeRun(
      selected,
      {
        onRun: (value) => {
          setDetail(value);
          setRuns((previous) => previous.map((item) => (item.id === value.id ? value : item)));
        },
        onApprovalRequired: (id, name, summary, token) => setApproval({ runId: selected, id, name, summary, token }),
      },
      controller.signal,
      run.status === 'waiting_approval' ? 0 : (run.eventCursor ?? 0),
    );
    return () => controller.abort();
  }, [selected, !!run && activeRun(run)]);
  useEffect(() => {
    let disposed = false;
    if (!selected) {
      setTools([]);
      return;
    }
    void runsApi
      .tools(selected)
      .then((value) => {
        if (!disposed) setTools(value);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [selected, run?.updatedAt]);
  const change = async (action: () => Promise<unknown>) => {
    try {
      await action();
      await refresh();
    } catch (reason) {
      toast.error(String(reason));
    }
  };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-6xl flex-col gap-5 p-4 md:p-6" data-testid="society-home">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">AI 社会</h1>
            <p className="text-sm text-muted-foreground">角色、任务、协作与交付</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={connected ? 'secondary' : 'destructive'} role="status">
              {connected ? '实时连接' : '连接断开，正在重连'}
            </Badge>
            <Button variant="outline" onClick={() => void refresh()}>
              刷新
            </Button>
          </div>
        </header>
        {error && <p role="alert">{error}</p>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {groups.map((group) => {
            const entries = runs.filter((item) => group.statuses.includes(item.status));
            return (
              <Card key={group.label}>
                <CardHeader>
                  <CardTitle>
                    {group.label} · {entries.length}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex max-h-96 flex-col gap-2 overflow-auto">
                  {entries.map((item) => (
                    <Button
                      key={item.id}
                      variant={selected === item.id ? 'secondary' : 'ghost'}
                      className="h-auto justify-start whitespace-normal text-left"
                      onClick={() => setSelected(item.id)}
                    >
                      {item.objective}
                    </Button>
                  ))}
                  {!entries.length && <p className="text-sm text-muted-foreground">暂无任务</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
        {run && (
          <Card key={run.id} data-testid="society-task-detail">
            <CardHeader>
              <CardTitle>{run.objective}</CardTitle>
              <CardDescription>
                {runLabels[run.status]} ·{' '}
                {run.origin?.kind === 'automation' ? '自动化' : run.origin?.kind === 'society' ? '历史社会调度' : '对话 / 事项'} · {run.id}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => props.onSession(run.sessionId)}>
                  打开任务对话
                </Button>
                {activeRun(run) && (
                  <Button
                    variant="outline"
                    disabled={run.status === 'stopping'}
                    onClick={() =>
                      void change(() => (run.parentId || run.origin?.kind === 'society' ? runsApi.cancel(run.id) : runsApi.pause(run.id)))
                    }
                  >
                    停止任务
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setSelected(undefined)}>
                  关闭详情
                </Button>
              </div>
              <RunControls
                run={run}
                onChanged={() => void refresh()}
                onResume={() => void change(() => runsApi.resume(run.id))}
                onNew={async (message) => {
                  if (activeRun(run)) {
                    await runsApi.cancel(run.id);
                    for (let attempt = 0; attempt < 60; attempt++) {
                      if (!activeRun(await runsApi.get(run.id))) break;
                      if (attempt === 59) throw new Error('任务仍在停止');
                      await new Promise((resolve) => setTimeout(resolve, 500));
                    }
                  }
                  const result = await runsApi.create(
                    run.sessionId,
                    message,
                    run.model,
                    run.providerId,
                    undefined,
                    undefined,
                    activeRun(run) ? undefined : run.id,
                  );
                  await refresh();
                  setSelected(result.runId);
                }}
              />
              {run.status === 'waiting_approval' && approval?.runId === run.id && (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="font-medium">待审批 · {approval.name}</p>
                  <p className="break-words text-sm">{approval.summary}</p>
                  <div className="flex gap-2">
                    {[true, false].map((approved) => (
                      <Button
                        key={String(approved)}
                        size="sm"
                        variant={approved ? 'default' : 'outline'}
                        disabled={responding}
                        onClick={async () => {
                          setResponding(true);
                          try {
                            await approvalsApi.respond(approval.id, approved, approval.token);
                            setApproval(undefined);
                          } catch (reason) {
                            toast.error(String(reason));
                          } finally {
                            setResponding(false);
                          }
                        }}
                      >
                        {approved ? '批准' : '拒绝'}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {order && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">角色与分工 · {order.id}</p>
                  {teamCycles.map((cycle) => (
                    <div key={cycle.id} className="rounded-md border p-3">
                      <p className="text-sm font-medium">协作 · {cycle.status}</p>
                      <p className="text-xs text-muted-foreground">
                        {cycle.assignments.length} 个分支 · {cycle.id}
                      </p>
                    </div>
                  ))}
                  {order.contracts.map((contract) => (
                    <div key={contract.id} className="rounded-md border p-3 text-sm">
                      <p>
                        {order.roles.find((role) => role.id === contract.roleId)?.name ?? contract.roleId} · {contract.status}
                      </p>
                      <p>{contract.branchObjective}</p>
                      {contract.dependsOn.length > 0 && <p className="text-muted-foreground">依赖：{contract.dependsOn.join('、')}</p>}
                      {contract.runId && (
                        <Button size="sm" variant="link" onClick={() => setSelected(contract.runId)}>
                          查看执行
                        </Button>
                      )}
                      {contract.delivery && <p className="whitespace-pre-wrap">{contract.delivery.summary}</p>}
                    </div>
                  ))}
                </div>
              )}
              <div>
                <p className="text-sm font-medium">当前活动与工具操作</p>
                {tools.map((tool) => (
                  <p key={tool.id} className="break-words text-sm">
                    {tool.name} · {tool.status} · {tool.argsSummary}
                    {tool.failure ? ` · ${tool.failure.code} (${tool.failure.outcome})` : ''}
                  </p>
                ))}
                {!tools.length && <p className="text-sm text-muted-foreground">尚无工具操作</p>}
              </div>
              {run.answer && <div className="whitespace-pre-wrap break-words text-sm">{run.answer}</div>}
              <RunFiles runId={run.id} sessionId={run.sessionId} revision={run.updatedAt} onOpen={setViewing} />
              <details onToggle={(event) => setTrace(event.currentTarget.open ? run.id : undefined)}>
                <summary className="cursor-pointer text-sm">详细 Trace 与子任务</summary>
                {trace === run.id && (
                  <RunDiagnostics
                    key={`${run.id}:${run.updatedAt}`}
                    run={run}
                    onInspect={(child) => {
                      setRuns((current) => (current.some((item) => item.id === child.id) ? current : [...current, child]));
                      setSelected(child.id);
                    }}
                  />
                )}
              </details>
            </CardContent>
          </Card>
        )}
        <details onToggle={(event) => setSecondary(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm">制度、角色负载、费用账本与历史调度</summary>
          {secondary && <WorkbenchView {...props} societyOnly />}
        </details>
        <Dialog
          open={!!viewing}
          onOpenChange={(open) => {
            if (!open) setViewing(undefined);
          }}
        >
          <DialogContent className="flex h-[90dvh] max-w-5xl flex-col sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>{viewing?.name ?? '交付文件'}</DialogTitle>
            </DialogHeader>
            {viewing && <MaterialViewer material={viewing} />}
          </DialogContent>
        </Dialog>
      </main>
    </ScrollArea>
  );
}
