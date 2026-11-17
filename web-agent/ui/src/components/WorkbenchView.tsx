import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Bot, CheckCircle2, Clock3, ExternalLink, FileText, FolderKanban, ListTodo, Play, Plus, RefreshCw, ShieldAlert, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { runLabels } from '../run-api';
import { automationApi } from '../automation-api';
import { workbenchApi, type WorkbenchItem, type WorkbenchSummary } from '../workbench-api';
import { materialApi } from '../material-api';
import { experienceApi, type ExperienceFinding, type FindingStatus } from '../experience-api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';

interface Props {
  onSession: (id: string) => void;
  onAutomations: () => void;
  onOpenWorkbench: () => void;
}

function ItemRow({ item, busy, onExecute }: { item: WorkbenchItem; busy: boolean; onExecute: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <ListTodo className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {item.due ? `${item.due}${item.dueTime ? ` ${item.dueTime}` : ''}` : '未排期'}{item.note ? ` · ${item.note}` : ''}
        </p>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={onExecute}>
        <Play data-icon="inline-start" />现在执行
      </Button>
    </div>
  );
}

export default function WorkbenchView({ onSession, onAutomations, onOpenWorkbench }: Props) {
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null);
  const [error, setError] = useState('');
  const [quick, setQuick] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [findingBusy, setFindingBusy] = useState<string | null>(null);
  const [verification, setVerification] = useState<Record<string, { runId: string; summary: string; outcome: 'passed' | 'failed' }>>({});

  const load = useCallback(async () => {
    try {
      setSummary(await workbenchApi.summary());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const addItem = async () => {
    const title = quick.trim();
    if (!title || busy) return;
    setBusy('add');
    try {
      await api('/api/items', {
        method: 'POST',
        body: JSON.stringify({ title, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, operationId: crypto.randomUUID() }),
      });
      setQuick('');
      await load();
      toast.success('已加入工作台');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const execute = async (item: WorkbenchItem) => {
    setBusy(item.id);
    try {
      const { sessionId } = await workbenchApi.execute(item);
      onSession(sessionId);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (id: string, revision: number) => {
    setBusy(id);
    try {
      await automationApi.confirm(id, revision);
      await load();
      toast.success('自动化已确认');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const advanceFinding = async (finding: ExperienceFinding, status: FindingStatus) => {
    setFindingBusy(finding.id);
    try {
      if (status === 'reproduced') await experienceApi.reproduceFinding(finding.id);
      else await experienceApi.updateFinding(
        finding.id,
        status,
        status === 'closed' ? '人工例外：人类在回归结果未标记通过的情况下确认关闭。' : undefined,
      );
      await load();
      toast.success('体验问题状态已更新');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFindingBusy(null);
    }
  };

  const findingAction = (status: FindingStatus): { status: FindingStatus; label: string } | null => {
    if (status === 'new' || status === 'reopened') return { status: 'triaged', label: '分诊' };
    if (status === 'triaged') return { status: 'reproduced', label: '建立复现' };
    if (status === 'reproduced') return { status: 'fixing', label: '开始修复' };
    if (status === 'fixing') return { status: 'verifying', label: '进入验证' };
    return null;
  };

  const verifyFinding = async (finding: ExperienceFinding) => {
    const input = verification[finding.id];
    if (!input?.runId.trim() || !input.summary.trim()) {
      toast.error('填写验证运行 ID 和人工结论后再登记回归结果');
      return;
    }
    setFindingBusy(finding.id);
    try {
      await experienceApi.verifyFinding(finding.id, {
        outcome: input.outcome,
        runId: input.runId.trim(),
        summary: input.summary.trim(),
      });
      await load();
      toast.success(input.outcome === 'passed' ? '回归通过，问题已关闭' : '回归失败，问题已重开');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFindingBusy(null);
    }
  };

  const evolveFinding = async (finding: ExperienceFinding) => {
    setFindingBusy(finding.id);
    try {
      await experienceApi.evolveFinding(finding.id);
      await load();
      toast.success('已验证模式已提交到自进化提案');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setFindingBusy(null);
    }
  };

  if (!summary && !error) {
    return <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6"><Skeleton className="h-28" /><Skeleton className="h-60" /><Skeleton className="h-44" /></div>;
  }

  if (error) {
    return <Empty className="flex-1"><EmptyHeader><AlertCircle /><EmptyTitle>工作台暂时不可用</EmptyTitle><EmptyDescription>{error}</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => void load()}><RefreshCw data-icon="inline-start" />重试</Button></Empty>;
  }

  const allItems = [...summary!.overdue, ...summary!.todayItems, ...summary!.upcoming, ...summary!.unscheduled];
  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 md:p-6" data-testid="workbench-home">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs font-medium text-muted-foreground">{summary!.today}</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">今天从这里继续</h1><p className="mt-1 text-sm text-muted-foreground">事项、自动化、最近结果和可继续处理的任务集中在这里。</p></div>
          <div className="flex gap-2"><Button variant="outline" onClick={() => void load()}><RefreshCw data-icon="inline-start" />刷新</Button><Button variant="outline" onClick={onOpenWorkbench}><ExternalLink data-icon="inline-start" />完整工作台</Button></div>
        </header>

        <div className="grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
          <Card>
            <CardHeader><CardTitle>今日与待办</CardTitle><CardDescription>逾期 {summary!.overdue.length} 项 · 今日 {summary!.todayItems.length} 项 · 未排期 {summary!.unscheduled.length} 项</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-3">
              <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void addItem(); }}>
                <Input aria-label="新增事项" placeholder="记一件事，例如：整理明天会议资料" value={quick} onChange={(event) => setQuick(event.target.value)} />
                <Button disabled={!quick.trim() || busy !== null}>{busy === 'add' ? <RefreshCw className="animate-spin" /> : <Plus />}添加</Button>
              </form>
              {summary!.overdue.map(item => <div key={item.id} className="rounded-lg border border-destructive/30 bg-destructive/5 p-2"><Badge variant="destructive" className="mb-2">逾期</Badge><ItemRow item={item} busy={busy === item.id} onExecute={() => void execute(item)} /></div>)}
              {summary!.todayItems.map(item => <ItemRow key={item.id} item={item} busy={busy === item.id} onExecute={() => void execute(item)} />)}
              {allItems.length === 0 && <Empty className="py-8"><EmptyHeader><CheckCircle2 /><EmptyTitle>今天没有待办</EmptyTitle><EmptyDescription>可以直接记下一件事，或在会话里让模型整理计划。</EmptyDescription></EmptyHeader></Empty>}
              {summary!.upcoming.length > 0 && <Button variant="ghost" className="justify-between" onClick={onOpenWorkbench}>查看后续 {summary!.upcoming.length} 项<ArrowRight /></Button>}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader><CardTitle>待确认自动化</CardTitle><CardDescription>{summary!.pendingAutomations.length ? '周期或监控任务需要你确认后才会执行。' : '没有等待确认的自动化。'}</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-2">
                {summary!.pendingAutomations.slice(0, 4).map(item => <div key={item.id} className="flex items-center gap-2 rounded-md border p-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.name}</p><p className="truncate text-xs text-muted-foreground">{item.prompt}</p></div><Button size="sm" disabled={busy === item.id} onClick={() => void confirm(item.id, item.revision)}>确认</Button></div>)}
                <Button variant="outline" onClick={onAutomations}>打开自动化<ArrowRight data-icon="inline-end" /></Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>最近运行</CardTitle><CardDescription>点击继续查看对应会话。</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-2">
                {summary!.recentRuns.slice(0, 5).map(run => <button key={run.id} type="button" className="flex items-center gap-2 rounded-md p-2 text-left hover:bg-muted" onClick={() => onSession(run.sessionId)}><Clock3 className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm">{run.objective}</span><Badge variant={run.status === 'completed' ? 'secondary' : run.status === 'failed' ? 'destructive' : 'outline'}>{runLabels[run.status]}</Badge></button>)}
                {summary!.recentRuns.length === 0 && <p className="text-sm text-muted-foreground">还没有运行记录。</p>}
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader><CardTitle>最近产物</CardTitle><CardDescription>直接下载生成结果。</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-2">
              {summary!.artifacts.slice(0, 6).map(artifact => <div key={artifact.id} className="flex items-center gap-2"><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm">{artifact.label}</span><Button size="sm" variant="ghost" onClick={() => void workbenchApi.artifact(artifact.runId, artifact).then(materialApi.download).catch(error => toast.error(String(error)))}>下载</Button></div>)}
              {summary!.artifacts.length === 0 && <p className="text-sm text-muted-foreground">还没有生成文件。</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>项目</CardTitle><CardDescription>当前工作区中的项目。</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-2">{summary!.projects.slice(0, 6).map(project => <div key={project.id} className="flex items-center gap-2"><FolderKanban className="size-4 text-muted-foreground" /><span className="truncate text-sm">{project.name}</span></div>)}{!summary!.projects.length && <p className="text-sm text-muted-foreground">暂无项目，可在完整工作台中创建。</p>}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>笔记</CardTitle><CardDescription>最近记录的想法与资料。</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-2">{summary!.notes.slice(0, 6).map(note => <div key={note.id} className="flex items-start gap-2"><Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="line-clamp-2 text-sm">{note.text || '未命名笔记'}</span></div>)}{!summary!.notes.length && <p className="text-sm text-muted-foreground">暂无笔记，可在完整工作台中记录。</p>}</CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle>AI 用户整体体验</CardTitle><CardDescription>只来自你主动触发的本机复盘；事实、AI 评分和人工校准分开保存。</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">平均体验分</p><p className="mt-1 font-medium">{summary!.experience.averageScore === null ? '暂无数据' : `${summary!.experience.averageScore}/5`}</p></div>
              <div><p className="text-xs text-muted-foreground">负向复盘</p><p className="mt-1 font-medium">{summary!.experience.negativeReviews} / {summary!.experience.reviewCount}</p></div>
              <div><p className="text-xs text-muted-foreground">待分诊问题</p><p className="mt-1 font-medium">{summary!.experience.undecidedFindings}</p></div>
              <div><p className="text-xs text-muted-foreground">开放问题</p><p className="mt-1 font-medium">{summary!.experience.openFindings}</p></div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">最近复盘</p>
                {summary!.experience.recentReviews.map(review => {
                  return <div key={review.id} className="flex items-center gap-2 rounded-md border p-2">
                    <Bot className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{review.originalProviderId} / {review.originalModel} · {review.path === 'fast' ? '快速' : '聚焦'} · {review.suggestionCount} 条建议</span>
                    <Button size="sm" variant="ghost" disabled={!review.sessionId} onClick={() => review.sessionId && onSession(review.sessionId)}>打开会话</Button>
                    <Badge variant={review.verdict === 'negative' ? 'destructive' : review.verdict === 'positive' ? 'secondary' : 'outline'}>{review.verdict}</Badge>
                  </div>;
                })}
                {summary!.experience.recentReviews.length === 0 && <p className="text-sm text-muted-foreground">进入运行诊断，主动触发第一次 AI 使用复盘。</p>}
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">体验问题池</p>
                {summary!.experience.findings.slice(0, 4).map(finding => {
                  const action = findingAction(finding.status);
                  const occurrences = finding.occurrences ?? finding.reviewIds?.length ?? 1;
                  const verificationInput = verification[finding.id] ?? { runId: '', summary: '', outcome: 'passed' as const };
                  return <div key={finding.id} className="rounded-md border p-2">
                    <div className="flex items-center gap-2"><ShieldAlert className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{finding.title}</span><span className="text-xs text-muted-foreground">{finding.severity} · {finding.status} · 出现 {occurrences} 次</span></span>{action && <Button size="sm" variant="outline" disabled={findingBusy === finding.id} onClick={() => void advanceFinding(finding, action.status)}>{action.label}</Button>}</div>
                    {finding.status === 'verifying' && <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                      <Input aria-label={`验证运行 ID ${finding.id}`} placeholder="绑定一个已结束的验证 Run ID" value={verificationInput.runId} onChange={event => setVerification(values => ({ ...values, [finding.id]: { ...verificationInput, runId: event.target.value } }))} />
                      <Input aria-label={`回归结论 ${finding.id}`} placeholder="人工核对结论" value={verificationInput.summary} onChange={event => setVerification(values => ({ ...values, [finding.id]: { ...verificationInput, summary: event.target.value } }))} />
                      <div className="flex gap-1"><select aria-label={`回归结果 ${finding.id}`} className="rounded-md border bg-background px-2 text-xs" value={verificationInput.outcome} onChange={event => setVerification(values => ({ ...values, [finding.id]: { ...verificationInput, outcome: event.target.value as 'passed' | 'failed' } }))}><option value="passed">通过</option><option value="failed">失败</option></select><Button size="sm" disabled={findingBusy === finding.id} onClick={() => void verifyFinding(finding)}>登记</Button></div>
                    </div>}
                    {finding.status === 'closed' && !finding.evolutionProposalId && (occurrences >= 2 || finding.severity === 'P0' || finding.severity === 'P1') && <div className="mt-2 flex justify-end"><Button size="sm" variant="outline" disabled={findingBusy === finding.id} onClick={() => void evolveFinding(finding)}>提交自进化</Button></div>}
                    {finding.evolutionProposalId && <p className="mt-2 text-xs text-muted-foreground">自进化提案：{finding.evolutionProposalId}</p>}
                  </div>;
                })}
                {summary!.experience.findings.length === 0 && <p className="text-sm text-muted-foreground">采纳复盘建议后，问题会出现在这里。</p>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>本地体验指标</CardTitle><CardDescription>指标只来自当前租户的本地运行记录，不上传。</CardDescription></CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><p className="text-xs text-muted-foreground">首任务成功率</p><p className="mt-1 font-medium">{summary!.metrics.firstTaskSuccessRate === null ? '暂无数据' : `${summary!.metrics.firstTaskSuccessRate}%`}</p></div>
            <div><p className="text-xs text-muted-foreground">失败后恢复</p><p className="mt-1 font-medium">{summary!.metrics.recoveredAfterFailureRate === null ? '暂无数据' : `${summary!.metrics.recoveredAfterFailureRate}%`}</p></div>
            <div><p className="text-xs text-muted-foreground">无效与重复调用</p><p className="mt-1 font-medium">{summary!.metrics.invalidToolCalls} / {summary!.metrics.duplicateToolCalls}</p></div>
            <div><p className="text-xs text-muted-foreground">累计耗时、模型调用与费用</p><p className="mt-1 font-medium">{Math.round(summary!.metrics.durationMs / 1000)} 秒 · {summary!.metrics.modelCalls} 次 · ${summary!.metrics.costUsd.toFixed(4)}</p></div>
          </CardContent>
        </Card>
      </main>
    </ScrollArea>
  );
}
