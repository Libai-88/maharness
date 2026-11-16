import { memo, useEffect, useMemo, useState } from 'react';
import RunDiagnostics from './RunDiagnostics';
import type { RunInfo } from '../run-api';
import type { TraceStep } from '../types';
import { toolDisplayName } from '../voice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';
import { Check as IconCheck, Download as IconDownload, RefreshCw as IconRefresh } from 'lucide-react';

interface Props {
  run?: RunInfo | null;
  steps: TraceStep[];
  stats: { trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean } | null;
  onRefresh: () => void;
}

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  llm_call: { label: 'LLM', cls: 'llm' },
  tool_call: { label: 'TOOL', cls: 'tool' },
  cache_hit: { label: 'CACHE', cls: 'cache' },
  user_msg: { label: 'USER', cls: 'sys' },
  system: { label: 'SYS', cls: 'sys' },
};

const STEP_NAMES: Record<string, string> = {
  'model-route': '挑了条更合适的线路',
  failover: '换备用线路',
  'thinking-strip': '剥掉混进正文的思考',
  'narration-fix': '纠正“把调用写成了文字”',
  'cost-breaker': '成本熔断',
  '上下文截断': '上下文截断',
  '上下文压缩': '上下文压缩',
  'policy-allow': '规则放行',
  approval: '等你点头',
};

function stepTitle(step: TraceStep): string {
  if (step.type === 'tool_call' && step.name) return toolDisplayName(step.name);
  if (step.name && STEP_NAMES[step.name]) return STEP_NAMES[step.name];
  return step.name ?? '步骤';
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function exportJsonl(steps: TraceStep[]) {
  if (!steps.length) return;
  const blob = new Blob([steps.map((step) => JSON.stringify(step)).join('\n')], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `maharness-trace-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function StepRow({
  step,
  depth,
  collapsed,
  hasChildren,
  onToggle,
  now,
}: {
  step: TraceStep;
  depth: number;
  collapsed: boolean;
  hasChildren: boolean;
  onToggle: () => void;
  now: number;
}) {
  const badge = TYPE_BADGE[step.type] ?? { label: step.type.toUpperCase(), cls: 'sys' };
  const running = step.status === 'running';
  const failed = step.status === 'error';
  const hasDetails = Boolean(step.tokensIn || step.tokensOut || step.cost || step.inputSummary || step.outputSummary || step.error || step.toolVersion || step.sideEffect);
  const expandable = hasChildren || hasDetails;
  const line = (
    <TraceLine
      status={running ? 'running' : failed ? 'error' : undefined}
      className="w-full"
    >
      <Badge variant="secondary">
        {badge.label}
      </Badge>
      <TraceTitle title={step.name}>{stepTitle(step)}</TraceTitle>
      {step.traceId && depth > 0 && (
        <Badge variant="outline">子任务</Badge>
      )}
      {running && <Spinner className="size-3" />}
      {step.cacheLayer && (
        <Badge variant="outline">
          L{step.cacheLayer}<IconCheck size={9} />
        </Badge>
      )}
      <TraceDescription className="ml-auto">
        {running ? fmtMs(Math.max(0, now - step.ts)) : fmtMs(step.durationMs)}
      </TraceDescription>
    </TraceLine>
  );

  const details = (
    <TraceCollapsibleContent className="flex flex-col gap-1">
      {(step.tokensIn || step.tokensOut || step.cost) && (
        <span>↑{step.tokensIn ?? 0} ↓{step.tokensOut ?? 0}{step.cost ? ` · $${step.cost.toFixed(4)}` : ''}</span>
      )}
      {step.inputSummary && <span>来源：{step.inputSummary}</span>}
      {step.toolVersion && <span>工具版本：{step.toolVersion}{step.sideEffect ? ` · 声明副作用：${step.sideEffect}` : ''}{step.sideEffectOutcome ? ` · 执行结果：${step.sideEffectOutcome}` : ''}</span>}
      {step.outputSummary && <span>{step.outputSummary}</span>}
      {step.error && <span className="text-destructive">{step.error}</span>}
    </TraceCollapsibleContent>
  );

  return (
    <Trace
      data-testid="trace-step"
      data-status={step.status}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {expandable ? (
        <TraceCollapsible open={!collapsed} onOpenChange={(open) => { if (open === collapsed) onToggle(); }}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          {details}
        </TraceCollapsible>
      ) : line}
    </Trace>
  );
}

export default memo(function TracePanel({ steps, stats, onRefresh, run }: Props) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const runningCount = useMemo(() => steps.filter((step) => step.status === 'running').length, [steps]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!runningCount) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runningCount]);

  const tree = useMemo(() => {
    const filtered = typeFilter ? steps.filter((step) => step.type === typeFilter) : steps;
    if (typeFilter) return { roots: filtered, byParent: new Map<string, TraceStep[]>() };
    const byParent = new Map<string, TraceStep[]>();
    for (const step of filtered) {
      if (!step.parentId) continue;
      const children = byParent.get(step.parentId) ?? [];
      children.push(step);
      byParent.set(step.parentId, children);
    }
    return { roots: filtered.filter((step) => !step.parentId), byParent };
  }, [steps, typeFilter]);

  const visibleSteps = useMemo(
    () => typeFilter ? steps.filter((step) => step.type === typeFilter) : steps,
    [steps, typeFilter],
  );

  const { roots, byParent } = tree;
  const cache = stats?.cache ?? {};
  const realTotal = (cache.l3RealTokens ?? 0) + (cache.l3RealMissTokens ?? 0);
  const cacheRate = realTotal > 0
    ? Math.round(((cache.l3RealTokens ?? 0) / realTotal) * 100)
    : stats?.trace?.cacheHits
      ? Math.min(100, Math.round((stats.trace.cacheHits / Math.max(1, stats.trace.llmCalls + stats.trace.cacheHits)) * 100))
      : 0;
  const cacheRateIsReal = realTotal > 0;

  const renderTree = (): React.ReactNode[] => {
    const output: React.ReactNode[] = [];
    const visit = (step: TraceStep, depth: number) => {
      const children = byParent.get(step.id) ?? [];
      const isCollapsed = !!collapsed[step.id];
      output.push(
        <StepRow
          key={step.id}
          step={step}
          depth={depth}
          collapsed={isCollapsed}
          hasChildren={children.length > 0}
          now={now}
          onToggle={() => setCollapsed((current) => ({ ...current, [step.id]: !current[step.id] }))}
        />,
      );
      if (!isCollapsed) {
        for (const child of [...children].reverse()) visit(child, depth + 1);
      }
    };

    const rendered = new Set<string>();
    for (const step of [...roots].reverse()) {
      rendered.add(step.id);
      visit(step, 0);
    }
    const known = new Set(visibleSteps.map((step) => step.id));
    for (const step of [...visibleSteps].reverse()) {
      if (!rendered.has(step.id) && step.parentId && !known.has(step.parentId)) {
        output.push(
          <StepRow
            key={`orphan-${step.id}`}
            step={step}
            depth={1}
            collapsed={!!collapsed[step.id]}
            hasChildren={false}
            now={now}
            onToggle={() => setCollapsed((current) => ({ ...current, [step.id]: !current[step.id] }))}
          />,
        );
      }
    }
    return output;
  };

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">运行轨迹</span>
          {stats && <Badge variant="secondary">{steps.length} 条</Badge>}
          {runningCount > 0 && (
            <Badge variant="outline">
              <Spinner />{runningCount} 步在做
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-xs" title="刷新" aria-label="刷新" onClick={onRefresh}>
            <IconRefresh size={13} />
          </Button>
          <Button variant="ghost" size="icon-xs" title="导出 JSONL" aria-label="导出 JSONL" onClick={() => exportJsonl(visibleSteps)} disabled={!visibleSteps.length}>
            <IconDownload size={13} />
          </Button>
        </div>
      </div>

      {stats && (
        <div className="flex shrink-0 flex-col gap-3 p-4">
          <div className="grid grid-cols-2 gap-2">
            <Card size="sm">
              <CardHeader><CardDescription>缓存命中率{cacheRateIsReal ? '' : '（估算）'}</CardDescription><CardTitle>{cacheRate}%</CardTitle></CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {cacheRateIsReal
                  ? `L3 真实命中 ${(cache.l3RealTokens ?? 0).toLocaleString()} tok · L1 ${cache.l1Hits ?? 0} · L2 ${cache.l2Hits ?? 0}`
                  : `无 provider 命中反馈 · L1 ${cache.l1Hits ?? 0} · L2 ${cache.l2Hits ?? 0}`}
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader><CardDescription>本次成本</CardDescription><CardTitle>${(stats.trace.totalCost ?? 0).toFixed(3)}</CardTitle></CardHeader>
              <CardContent className="text-xs text-muted-foreground">输入 {stats.trace.totalTokensIn ?? 0} · 输出 {stats.trace.totalTokensOut ?? 0}</CardContent>
            </Card>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">步骤 {stats.trace.steps ?? 0}</Badge>
            <Badge variant="secondary">LLM {stats.trace.llmCalls ?? 0}</Badge>
            <Badge variant="secondary">工具 {stats.trace.toolCalls ?? 0}</Badge>
          </div>
        </div>
      )}

      <div className="shrink-0 px-4 pb-3">
        <Select value={typeFilter || 'all'} onValueChange={(value) => setTypeFilter(value === 'all' ? '' : value)}>
          <SelectTrigger aria-label="步骤类型筛选" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>
            <SelectItem value="all">全部步骤</SelectItem>
            {Object.entries(TYPE_BADGE).map(([value, badge]) => <SelectItem key={value} value={value}>{badge.label}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
      </div>
      <ScrollArea data-testid="trace-scroll" className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-3 pb-4">
        {run && <details onToggle={event => setDiagnosticsOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">任务输入、权限与执行结果</summary>{diagnosticsOpen && <div className="py-3"><RunDiagnostics run={run} /></div>}</details>}
        {steps.length === 0 && (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyTitle>暂无运行记录</EmptyTitle>
              <EmptyDescription>发送消息后，每一步动作都会实时出现在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {renderTree()}
        <div className="flex justify-center px-0 py-2.5">
          <Button variant="outline" size="xs" onClick={() => exportJsonl(visibleSteps)} disabled={!visibleSteps.length} title="导出当前筛选结果为 JSONL 审计文件">
            导出 JSONL 审计
          </Button>
        </div>
        </div>
      </ScrollArea>
    </>
  );
});
