import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertCircle, ArrowRight, Bot, Building2, CheckCircle2, CircleDollarSign, Clock3, ExternalLink, FileText, FolderKanban, Gauge, ListTodo, Play, Plus, RefreshCw, ShieldAlert, Sparkles, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { runLabels } from '../run-api';
import { automationApi } from '../automation-api';
import { workbenchApi, type WorkbenchItem, type WorkbenchProject, type WorkbenchSummary } from '../workbench-api';
import { materialApi } from '../material-api';
import { experienceApi, type ExperienceFinding, type FindingStatus } from '../experience-api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Skeleton } from './ui/skeleton';
import { OrganizationDialog } from './OrganizationDialog';

interface Props {
  onSession: (id: string) => void;
  onAutomations: () => void;
  onOpenWorkbench: () => void;
}

const roleStateLabels = {
  ready: '可调度',
  busy: '工作中',
  waiting: '等待授权',
  resting: '休整中',
} as const;

const contextPressureLabels = {
  unknown: '未知',
  normal: '正常',
  high: '偏高',
} as const;

function ratio(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function societyTime(value?: number): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
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
  const [organizationProject, setOrganizationProject] = useState<WorkbenchProject | null>(null);
  const [societyObjective, setSocietyObjective] = useState('');
  const [societyValueUsd, setSocietyValueUsd] = useState('5');
  const [societyBudgetUsd, setSocietyBudgetUsd] = useState('0.10');
  const [societyDepartmentId, setSocietyDepartmentId] = useState('');
  const [institutionBudget, setInstitutionBudget] = useState('');
  const [welfareLimit, setWelfareLimit] = useState('');
  const [evaluationLow, setEvaluationLow] = useState('');
  const [evaluationMedium, setEvaluationMedium] = useState('');
  const [evaluationHigh, setEvaluationHigh] = useState('');
  const [departmentQuotas, setDepartmentQuotas] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setSummary(await workbenchApi.summary());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!summary?.society) return;
    setInstitutionBudget(String(summary.society.institution.policies.societyBudgetUsd));
    setWelfareLimit(String(summary.society.institution.policies.welfareMaxActiveAssignments));
    setEvaluationLow(String(summary.society.evaluation.record.lowConfidenceSamples));
    setEvaluationMedium(String(summary.society.evaluation.record.mediumConfidenceSamples));
    setEvaluationHigh(String(summary.society.evaluation.record.highConfidenceSamples));
    setDepartmentQuotas(Object.fromEntries(summary.society.departments.map(item => [item.id, String(item.quotaUsd)])));
    setSocietyDepartmentId(current => current || summary.society?.departments.find(item => item.enabled)?.id || '');
  }, [summary?.society]);

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

  const createSocietyTask = async () => {
    const objective = societyObjective.trim();
    const valueUsd = Number(societyValueUsd);
    const maxBudgetUsd = Number(societyBudgetUsd);
    if (!objective || !Number.isFinite(valueUsd) || valueUsd <= 0 || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      toast.error('填写目标、任务价值与正数预算');
      return;
    }
    setBusy('society:create');
    try {
      await workbenchApi.societyTask({
        objective, valueUsd, maxBudgetUsd,
        departmentId: societyDepartmentId || undefined,
      });
      setSocietyObjective('');
      await load();
      toast.success('社会任务已登记');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const tickSociety = async () => {
    setBusy('society:tick');
    try {
      const result = await workbenchApi.tickSociety();
      await load();
      toast.success(`制度调度完成：${result.decisions.length} 项进入执行，${result.queued} 项排队`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const updateInstitution = async () => {
    const society = summary?.society;
    if (!society) return;
    const budget = Number(institutionBudget);
    const welfare = Number(welfareLimit);
    const departments = society.departments.map(department => {
      const quotaUsd = Number(departmentQuotas[department.id]);
      return { ...department, quotaUsd };
    });
    if (!Number.isFinite(budget) || budget < 0 || !Number.isSafeInteger(welfare) || welfare < 1
      || departments.some(department => !Number.isFinite(department.quotaUsd) || department.quotaUsd < 0)) {
      toast.error('检查社会预算、福利并发和部门配额');
      return;
    }
    setBusy('society:institution');
    try {
      await workbenchApi.updateInstitution(
        { societyBudgetUsd: budget, welfareMaxActiveAssignments: welfare, departments },
        '人类在工作台调整社会预算、部门配额与角色福利负载',
      );
      await load();
      toast.success('制度新版本已生效并写入审计');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const rollbackInstitution = async () => {
    const society = summary?.society;
    if (!society || society.institution.version <= 1) return;
    if (!window.confirm(`回滚到制度 v${society.institution.version - 1}？当前版本会保留在审计记录中。`)) return;
    setBusy('society:rollback');
    try {
      await workbenchApi.rollbackInstitution(society.institution.version - 1, '人类在工作台回滚制度');
      await load();
      toast.success('制度已回滚并生成新版本');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const updateEvaluation = async () => {
    const low = Number(evaluationLow);
    const medium = Number(evaluationMedium);
    const high = Number(evaluationHigh);
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(medium) || !Number.isSafeInteger(high)
      || low < 2 || medium <= low || high <= medium) {
      toast.error('评价样本门槛必须为递增整数：低 < 中 < 高');
      return;
    }
    setBusy('society:evaluation');
    try {
      await workbenchApi.updateEvaluation(
        { lowConfidenceSamples: low, mediumConfidenceSamples: medium, highConfidenceSamples: high },
        '人类在工作台调整角色履历置信门槛',
      );
      await load();
      toast.success('评价标准新版本已生效并写入审计');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const rollbackEvaluation = async () => {
    const evaluation = summary?.society?.evaluation;
    if (!evaluation || evaluation.version <= 1) return;
    if (!window.confirm(`回滚到评价标准 v${evaluation.version - 1}？当前版本会保留在审计记录中。`)) return;
    setBusy('society:evaluation-rollback');
    try {
      await workbenchApi.rollbackEvaluation(evaluation.version - 1, '人类在工作台回滚评价标准');
      await load();
      toast.success('评价标准已回滚并生成新版本');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const approveSocietyTask = async (id: string, approved: boolean) => {
    setBusy(`society:approve:${id}`);
    try {
      await workbenchApi.approveSocietyTask(id, approved);
      await load();
      toast.success(approved ? '高额任务已批准，等待制度调度' : '高额任务已拒绝');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const releaseSocietyTask = async (taskId: string) => {
    setBusy(`society:release:${taskId}`);
    try {
      await workbenchApi.releaseSocietyTask(taskId, 'completed', '人类确认交付完成，释放短周期角色');
      await load();
      toast.success('任务已释放，角色履历与关系已更新');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  if (!summary && !error) {
    return <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6"><Skeleton className="h-28" /><Skeleton className="h-60" /><Skeleton className="h-44" /></div>;
  }

  if (error) {
    return <Empty className="flex-1"><EmptyHeader><AlertCircle /><EmptyTitle>工作台暂时不可用</EmptyTitle><EmptyDescription>{error}</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => void load()}><RefreshCw data-icon="inline-start" />重试</Button></Empty>;
  }

  const allItems = [...summary!.overdue, ...summary!.todayItems, ...summary!.upcoming, ...summary!.unscheduled];
  const activeSocietySchedules = summary!.society?.schedules.filter(item => item.status === 'active') ?? [];
  const awaitingSocietyAcceptance = summary!.society?.schedules.filter(schedule => {
    const task = summary!.society?.tasks.find(item => item.id === schedule.taskId);
    return schedule.status === 'completed' && task?.status === 'awaiting_acceptance';
  }) ?? [];
  const recentSocietySchedules = summary!.society?.schedules.filter(schedule => {
    const task = summary!.society?.tasks.find(item => item.id === schedule.taskId);
    return schedule.status === 'completed' && task?.status !== 'awaiting_acceptance';
  }) ?? [];
  const organization = summary!.organization ?? {
    workOrders: [],
    roles: [],
    receipts: [],
    exceptions: [],
    proposals: [],
  };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 md:p-6" data-testid="workbench-home">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs font-medium text-muted-foreground">{summary!.today}</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">今天从这里继续</h1><p className="mt-1 text-sm text-muted-foreground">事项、自动化、最近结果和可继续处理的任务集中在这里。</p></div>
          <div className="flex gap-2"><Button variant="outline" onClick={() => void load()}><RefreshCw data-icon="inline-start" />刷新</Button><Button variant="outline" onClick={onOpenWorkbench}><ExternalLink data-icon="inline-start" />完整工作台</Button></div>
        </header>

        {summary!.society ? <Card data-testid="society-console">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><CardTitle className="flex items-center gap-2"><Building2 />maharness 社会运行</CardTitle><CardDescription>人类确定目标、价值、预算和制度；角色组织按制度调度，主 Agent 参与受理，但不驱动这一轮社会运行。</CardDescription></div>
              <div className="flex items-center gap-2"><Badge variant={summary!.society.bottlenecks.length ? 'destructive' : 'secondary'}>{summary!.society.bottlenecks.length ? `${summary!.society.bottlenecks.length} 个瓶颈` : '运行平稳'}</Badge><Button disabled={busy === 'society:tick'} onClick={() => void tickSociety()}>{busy === 'society:tick' ? <RefreshCw className="animate-spin" /> : <Play />}运行制度调度</Button></div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border p-3"><p className="flex items-center gap-1 text-xs text-muted-foreground"><Activity className="size-3.5" />社会健康</p><p className="mt-1 font-medium">{summary!.society.health.score === null ? '暂无数据' : `${summary!.society.health.score}/100`}</p></div>
              <div className="rounded-lg border p-3"><p className="flex items-center gap-1 text-xs text-muted-foreground"><Gauge className="size-3.5" />福利负载</p><p className="mt-1 font-medium">{summary!.society.health.welfare === null ? '未知' : `${Math.round(summary!.society.health.welfare * 100)}% 可用`}</p></div>
              <div className="rounded-lg border p-3"><p className="flex items-center gap-1 text-xs text-muted-foreground"><CircleDollarSign className="size-3.5" />社会预算</p><p className="mt-1 font-medium">${summary!.society.economics.societyReservedUsd.toFixed(2)} 预留 · ${summary!.society.economics.societySpentUsd.toFixed(2)} 已结算 / ${summary!.society.economics.societyBudgetUsd.toFixed(2)}</p></div>
              <div className="rounded-lg border p-3"><p className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3.5" />处置队列</p><p className="mt-1 font-medium">{summary!.society.scheduling.queue.length} 排队 · {summary!.society.scheduling.waitingApproval.length} 待批 · {summary!.society.schedules.filter(item => item.status === 'active').length} 执行中</p></div>
            </div>

            <form className="grid gap-2 rounded-lg border bg-muted/20 p-3 lg:grid-cols-[1fr_110px_110px_150px_auto]" onSubmit={event => { event.preventDefault(); void createSocietyTask(); }}>
              <Input aria-label="社会任务目标" placeholder="交给社会运行层，例如：对比三份资料并标出来源差异" value={societyObjective} onChange={event => setSocietyObjective(event.target.value)} />
              <Input aria-label="任务价值" type="number" min="0.01" step="0.01" value={societyValueUsd} onChange={event => setSocietyValueUsd(event.target.value)} title="预期业务价值（USD）" />
              <Input aria-label="任务预算" type="number" min="0.01" step="0.01" value={societyBudgetUsd} onChange={event => setSocietyBudgetUsd(event.target.value)} title="任务最高预算（USD）" />
              <select aria-label="承接部门" className="rounded-md border bg-background px-2 text-sm" value={societyDepartmentId} onChange={event => setSocietyDepartmentId(event.target.value)}>
                {summary!.society.departments.filter(item => item.enabled).map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
              </select>
              <Button disabled={!societyObjective.trim() || busy === 'society:create'}>{busy === 'society:create' ? <RefreshCw className="animate-spin" /> : <Plus />}登记任务</Button>
            </form>

            <div className="grid gap-3 lg:grid-cols-3">
              {summary!.society.departments.map(department => <div key={department.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{department.name}</span><Badge variant="outline">{department.enabled ? '运行中' : '停用'}</Badge></div>
                <p className="mt-1 text-xs text-muted-foreground">{department.charter}</p>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs"><span>{department.queued} 排队</span><span>{department.active}/{department.maxConcurrent} 并发</span><span>${department.quotaRemainingUsd.toFixed(2)} 可用</span></div>
              </div>)}
            </div>

            <details className="rounded-lg border p-3" data-testid="society-role-wellbeing">
              <summary className="cursor-pointer text-sm font-medium">角色福利与调度状态</summary>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {summary!.society.roleLife.map(life => {
                  const role = summary!.society!.roles.find(item => item.id === life.roleId);
                  const wellbeing = life.wellbeing;
                  if (!wellbeing) return null;
                  return <div key={life.roleId} className="rounded-md border p-2 text-xs" data-testid={`wellbeing-${life.roleId}`}>
                    <div className="flex items-center justify-between gap-2"><span className="font-medium">{role?.name ?? life.roleId}</span><Badge variant={wellbeing.state === 'resting' || wellbeing.state === 'waiting' ? 'destructive' : 'outline'}>{roleStateLabels[wellbeing.state]}</Badge></div>
                    <p className="mt-1 text-muted-foreground">负载 {wellbeing.activeAssignments} · 连续失败 {wellbeing.consecutiveFailures} · 审批等待 {wellbeing.waitingApproval} · 返工 {wellbeing.reworkAssignments}</p>
                    <p className="mt-1 text-muted-foreground">上下文压力 {contextPressureLabels[wellbeing.contextPressure]}{wellbeing.lastFailureAt ? ` · 最近失败 ${societyTime(wellbeing.lastFailureAt)}` : ''}{wellbeing.failureBackoffUntil ? ` · 退避至 ${societyTime(wellbeing.failureBackoffUntil)}` : ''}</p>
                  </div>;
                })}
              </div>
            </details>

            {summary!.society.bottlenecks.length > 0 && <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p className="flex items-center gap-2 text-sm font-medium"><TriangleAlert className="size-4 text-destructive" />社会瓶颈</p>
              <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">{summary!.society.bottlenecks.map((item, index) => <p key={`${item.departmentId}:${item.kind}:${index}`}>{item.detail}</p>)}</div>
            </div>}

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">需要人类处置</p>
                {summary!.society.scheduling.waitingApproval.map(task => <div key={task.id} className="rounded-md border border-amber-500/30 p-3">
                  <p className="text-sm font-medium">{task.objective}</p>
                  <p className="mt-1 text-xs text-muted-foreground">预算 ${task.maxBudgetUsd.toFixed(2)} · 价值 ${task.valueUsd.toFixed(2)} · {task.lastSchedulingReason}</p>
                  <div className="mt-2 flex gap-2"><Button size="sm" disabled={busy === `society:approve:${task.id}`} onClick={() => void approveSocietyTask(task.id, true)}>批准</Button><Button size="sm" variant="outline" disabled={busy === `society:approve:${task.id}`} onClick={() => void approveSocietyTask(task.id, false)}>拒绝</Button></div>
                </div>)}
                {summary!.society.scheduling.queue.map(task => <div key={task.id} className="rounded-md border p-3">
                  <p className="text-sm font-medium">{task.objective}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{task.lastSchedulingReason ?? '等待制度调度'} · ${task.maxBudgetUsd.toFixed(2)}</p>
                </div>)}
                {!summary!.society.scheduling.waitingApproval.length && !summary!.society.scheduling.queue.length && <p className="text-sm text-muted-foreground">当前没有排队或待批任务。</p>}
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">执行进度与人工验收</p>
                {activeSocietySchedules.map(schedule => {
                  const task = summary!.society!.tasks.find(item => item.id === schedule.taskId);
                  const roleNames = schedule.roleIds.map(roleId => summary!.society!.roles.find(role => role.id === roleId)?.name ?? roleId);
                  return <div key={schedule.id} className="rounded-md border p-3">
                    <div className="flex items-center gap-2"><span className="min-w-0 flex-1 text-sm font-medium">{task?.objective ?? schedule.taskId}</span><Badge variant={schedule.mode === 'team' ? 'secondary' : 'outline'}>{schedule.mode === 'team' ? `团队 ${schedule.roleIds.length}` : '单角色'}</Badge></div>
                    <p className="mt-1 text-xs text-muted-foreground">{roleNames.join(' · ')} · 估算 ${schedule.estimates.teamCostUsd.toFixed(3)} · 净收益 ${schedule.estimates.teamNetBenefitUsd.toFixed(3)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{schedule.reason} · {schedule.runIds.length} 个真实 Run 正在推进</p>
                    {schedule.selection && <details className="mt-2 rounded-md bg-muted/30 p-2 text-xs" data-testid={`society-selection-${schedule.id}`}>
                      <summary className="cursor-pointer font-medium">角色选择依据 · 制度 v{schedule.selection.policyVersion}</summary>
                      <p className="mt-1 text-muted-foreground">所需能力：{schedule.selection.requiredCapabilities.join(' · ') || '未识别'} · 权重：能力 {ratio(schedule.selection.weights.capability)} / 记忆 {ratio(schedule.selection.weights.memory)} / 工具 {ratio(schedule.selection.weights.tools)} / 协作 {ratio(schedule.selection.weights.collaboration)} / 履历 {ratio(schedule.selection.weights.history)} / 负载 {ratio(schedule.selection.weights.load)}</p>
                      <div className="mt-2 flex flex-col gap-1">
                        {schedule.selection.candidates.map(candidate => {
                          const role = summary!.society!.roles.find(item => item.id === candidate.roleId);
                          return <div key={candidate.roleId} className="rounded border bg-background/70 p-2">
                            <div className="flex items-center gap-2"><span className="min-w-0 flex-1 font-medium">{role?.name ?? candidate.roleId}</span>{schedule.selection?.chosenRoleIds.includes(candidate.roleId) && <Badge>已选择</Badge>}{!candidate.eligible && <Badge variant="destructive">已阻断</Badge>}</div>
                            <p className="mt-1 text-muted-foreground">能力 {ratio(candidate.capabilityFit)} · 记忆 {ratio(candidate.memoryRelevance)} · 工具 {ratio(candidate.toolReadiness)} · 协作 {ratio(candidate.collaborationHealth)} · 履历 {ratio(candidate.historyReliability)} · 负载 {ratio(candidate.loadBalance)}</p>
                            {candidate.blockedReason && <p className="mt-1 text-destructive">{candidate.blockedReason}</p>}
                          </div>;
                        })}
                      </div>
                    </details>}
                  </div>;
                })}
                {awaitingSocietyAcceptance.map(schedule => {
                  const task = summary!.society!.tasks.find(item => item.id === schedule.taskId);
                  const roleNames = schedule.roleIds.map(roleId => summary!.society!.roles.find(role => role.id === roleId)?.name ?? roleId);
                  return <div key={`accept:${schedule.id}`} className="rounded-md border border-emerald-600/30 bg-emerald-500/5 p-3">
                    <div className="flex items-center gap-2"><span className="min-w-0 flex-1 text-sm font-medium">{task?.objective ?? schedule.taskId}</span><Badge>待你验收</Badge></div>
                    <p className="mt-1 text-xs text-muted-foreground">{roleNames.join(' · ')} · 真实分工已全部交付 · {schedule.runIds.length} 个 Run</p>
                    <Button className="mt-2" size="sm" disabled={busy === `society:release:${schedule.taskId}`} onClick={() => void releaseSocietyTask(schedule.taskId)}>确认交付</Button>
                  </div>;
                })}
                {!activeSocietySchedules.length && !awaitingSocietyAcceptance.length && <p className="text-sm text-muted-foreground">当前没有执行中或待验收的任务。</p>}
                {recentSocietySchedules.slice(0, 3).map(schedule => {
                  const task = summary!.society!.tasks.find(item => item.id === schedule.taskId);
                  return <div key={`completed:${schedule.id}`} className="rounded-md border bg-muted/20 p-2 text-xs">
                    <p className="font-medium">{task?.objective ?? schedule.taskId}</p>
                    <p className="mt-1 text-muted-foreground">{task?.lastSchedulingReason ?? '短周期团队已释放'}</p>
                  </div>;
                })}
              </div>
            </div>

            <details className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">制度版本、配额与审计</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2" data-testid="institution-versions">
                <div className="flex flex-col gap-2">
                  <label className="text-xs text-muted-foreground">社会总预算<input aria-label="制度社会总预算" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground" type="number" min="0" step="0.01" value={institutionBudget} onChange={event => setInstitutionBudget(event.target.value)} /></label>
                  <label className="text-xs text-muted-foreground">单角色并发上限<input aria-label="制度福利并发上限" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground" type="number" min="1" step="1" value={welfareLimit} onChange={event => setWelfareLimit(event.target.value)} /></label>
                  {summary!.society.departments.map(department => <label key={department.id} className="text-xs text-muted-foreground">{department.name}配额<input aria-label={`${department.name}制度配额`} className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground" type="number" min="0" step="0.01" value={departmentQuotas[department.id] ?? ''} onChange={event => setDepartmentQuotas(values => ({ ...values, [department.id]: event.target.value }))} /></label>)}
                  <div className="flex gap-2"><Button size="sm" disabled={busy === 'society:institution'} onClick={() => void updateInstitution()}>发布制度 v{summary!.society.institution.version + 1}</Button><Button size="sm" variant="outline" disabled={summary!.society.institution.version <= 1 || busy === 'society:rollback'} onClick={() => void rollbackInstitution()}>回滚上一版</Button></div>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="rounded-md border p-2"><p className="text-sm font-medium">当前 v{summary!.society.institution.version}</p><p className="mt-1 text-xs text-muted-foreground">{summary!.society.institution.reason} · {summary!.society.institution.createdBy}</p></div>
                  {summary!.society.institutionAudits.slice(0, 6).map(audit => <div key={audit.id} className="rounded-md border p-2 text-xs"><p className="font-medium">v{audit.toVersion} · {audit.action === 'rollback' ? `回滚自 v${audit.fromVersion}` : audit.action === 'update' ? `升级自 v${audit.fromVersion}` : '初始化'}</p><p className="mt-1 text-muted-foreground">{audit.reason} · {audit.actor}</p></div>)}
                  <div className="grid grid-cols-3 gap-2 text-xs"><span>{summary!.society.network.nodes.length} 成员</span><span>{summary!.society.network.edges.length} 协作关系</span><span>{summary!.society.economics.compression.reusedRefs} 条共享资料复用</span></div>
                  <p className="text-xs text-muted-foreground">缓存命中率：{summary!.society.economics.cacheUsageStatus === 'known' && summary!.society.economics.cacheHitRate !== null ? `${Math.round(summary!.society.economics.cacheHitRate * 100)}%` : '未知'} · 命中 {summary!.society.economics.cachedInputTokens ?? 0} / 未命中 {summary!.society.economics.cacheMissInputTokens ?? 0} · 写入 {summary!.society.economics.cacheWriteUsageStatus === 'known' ? summary!.society.economics.cacheWriteTokens ?? 0 : '未知'} · 缓存节省：{summary!.society.economics.cacheSavingsUsd === null ? '未知' : `$${summary!.society.economics.cacheSavingsUsd.toFixed(4)}`}</p>
                </div>
              </div>
              <div className="mt-4 grid gap-3 rounded-lg border p-3 md:grid-cols-2" data-testid="evaluation-versions">
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">评价标准与置信门槛</p>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="text-xs text-muted-foreground">低置信样本<input aria-label="评价标准低置信样本" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground" type="number" min="2" step="1" value={evaluationLow} onChange={event => setEvaluationLow(event.target.value)} /></label>
                    <label className="text-xs text-muted-foreground">中置信样本<input aria-label="评价标准中置信样本" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground" type="number" min="3" step="1" value={evaluationMedium} onChange={event => setEvaluationMedium(event.target.value)} /></label>
                    <label className="text-xs text-muted-foreground">高置信样本<input aria-label="评价标准高置信样本" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground" type="number" min="4" step="1" value={evaluationHigh} onChange={event => setEvaluationHigh(event.target.value)} /></label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy === 'society:evaluation'} onClick={() => void updateEvaluation()}>发布评价 v{summary!.society.evaluation.version + 1}</Button>
                    <Button size="sm" variant="outline" disabled={summary!.society.evaluation.version <= 1 || busy === 'society:evaluation-rollback'} onClick={() => void rollbackEvaluation()}>回滚上一版</Button>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="rounded-md border p-2"><p className="text-sm font-medium">当前评价 v{summary!.society.evaluation.version}</p><p className="mt-1 break-all text-xs text-muted-foreground">{summary!.society.evaluation.reason} · {summary!.society.evaluation.hash.slice(0, 16)}</p></div>
                  {summary!.society.evaluationAudits.slice(0, 4).map(audit => <div key={audit.id} className="rounded-md border p-2 text-xs"><p className="font-medium">v{audit.toVersion} · {audit.action === 'rollback' ? `回滚自 v${audit.fromVersion}` : audit.action === 'update' ? `升级自 v${audit.fromVersion}` : '初始化'}</p><p className="mt-1 text-muted-foreground">{audit.reason} · {audit.actor}</p></div>)}
                </div>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">角色 token 账本</p>
                  {summary!.society.economics.roleBudgets.map(row => {
                    const role = summary!.society!.roles.find(item => item.id === row.roleId);
                    return <div key={row.roleId} className="rounded-md border p-2 text-xs">
                      <p className="font-medium">{role?.name ?? row.roleId}</p>
                      <p className="mt-1 text-muted-foreground">{row.tokens}{row.budgetLimitTokens === undefined ? ' token' : ` / ${row.budgetLimitTokens} token`} · {row.activeAssignments} 个分工 · ${row.costUsd.toFixed(4)} USD</p>
                    </div>;
                  })}
                </div>
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">任务 token 账本与估算 ROI</p>
                  {summary!.society.economics.taskLedger.map(row => {
                    const task = summary!.society!.tasks.find(item => item.id === row.taskId);
                    const schedule = summary!.society!.schedules.find(item => item.taskId === row.taskId);
                    return <div key={row.taskId} className="rounded-md border p-2 text-xs">
                      <p className="font-medium">{task?.objective ?? row.taskId}</p>
                      <p className="mt-1 text-muted-foreground">{row.actualTokens} / {row.maxBudgetTokens} token · ${row.actualCostUsd.toFixed(4)} / ${row.maxBudgetUsd.toFixed(2)} · {row.status}</p>
                      <p className="mt-1 text-muted-foreground">缓存命中 {row.cacheUsageStatus === 'known' ? row.cachedInputTokens ?? 0 : '未知'} / 未命中 {row.cacheUsageStatus === 'known' ? row.cacheMissInputTokens ?? 0 : '未知'} · 写入 {row.cacheWriteUsageStatus === 'known' ? row.cacheWriteTokens ?? 0 : '未知'} · 声明估算 ROI {schedule?.estimates.roi === null || schedule?.estimates.roi === undefined ? '未知' : schedule.estimates.roi}</p>
                    </div>;
                  })}
                </div>
              </div>
            </details>
          </CardContent>
        </Card> : <Card><CardHeader><CardTitle>社会运行层暂不可用</CardTitle><CardDescription>事项、文件、自动化和既有组织交付仍可继续使用。</CardDescription></CardHeader></Card>}

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
            <CardContent className="flex flex-col gap-2">{summary!.projects.slice(0, 6).map(project => <button key={project.id} type="button" className="flex items-center gap-2 rounded-md p-2 text-left hover:bg-muted" onClick={() => setOrganizationProject(project)}><FolderKanban className="size-4 text-muted-foreground" /><span className="truncate text-sm">{project.name}</span><ArrowRight className="ml-auto size-4 text-muted-foreground" /></button>)}{!summary!.projects.length && <p className="text-sm text-muted-foreground">暂无项目，可在完整工作台中创建。</p>}</CardContent>
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
        {organization.receipts.length > 0 || organization.exceptions.length > 0 ? <Card>
          <CardHeader><CardTitle>组织交付</CardTitle><CardDescription>最近工作回执与需要你裁决的异常。</CardDescription></CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">最近工作回执</p>
              {organization.receipts.slice(0, 5).map(receipt => {
                const order = organization.workOrders.find(item => item.id === receipt.workOrderId);
                return <button key={receipt.id} type="button" className="rounded-md border p-2 text-left hover:bg-muted" onClick={() => order && onSession(order.sessionId)}>
                  <span className="block truncate text-sm">{receipt.answer || '产物已交付'}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{receipt.status} · ${receipt.costUsd.toFixed(4)} · {receipt.artifacts.length} 个产物{receipt.unfinished.length ? ` · ${receipt.unfinished.length} 项未完成` : ''}</span>
                </button>;
              })}
              {!organization.receipts.length && <p className="text-sm text-muted-foreground">完成任务后会生成责任链与费用回执。</p>}
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">待裁决异常</p>
              {organization.exceptions.filter(item => !['resolved', 'dismissed'].includes(item.status)).slice(0, 5).map(item => <div key={item.id} className="rounded-md border border-destructive/30 p-2"><span className="block text-sm">{item.summary}</span><span className="mt-1 block text-xs text-muted-foreground">{item.kind} · {item.status}</span></div>)}
              {!organization.exceptions.some(item => !['resolved', 'dismissed'].includes(item.status)) && <p className="text-sm text-muted-foreground">没有待裁决异常。</p>}
            </div>
          </CardContent>
        </Card> : null}
      </main>
      {organizationProject && <OrganizationDialog
        project={organizationProject}
        workOrders={organization.workOrders}
        roleDirectory={organization.roles}
        proposals={organization.proposals}
        onClose={() => setOrganizationProject(null)}
        onSession={onSession}
        reload={load}
      />}
    </ScrollArea>
  );
}
