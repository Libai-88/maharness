import { useEffect, useState } from 'react';
import { cacheApi, statsApi } from '../api';
import { toast } from 'sonner';
import { money } from '../voice';
import type { StatsInfo } from '../types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const format = (value: number) => value.toLocaleString('zh-CN');
const percent = (value: number) => `${value.toFixed(1)}%`;

export default function StatsView() {
  const [stats, setStats] = useState<StatsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const result = await statsApi.get(); if (alive) { setStats(result); setError(null); } }
      catch (err) { if (alive) setError(err instanceof Error ? err.message : String(err)); }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const clearCache = async () => {
    if (clearing) return;
    if (!window.confirm('清理当前租户的 L1/L2 缓存？正在运行的任务可能重复计算一次。')) return;
    setClearing(true);
    try {
      const result = await cacheApi.clear('all');
      setStats(await statsApi.get());
      toast.success(`已清理 L1 ${format(result.removed.l1)} 条、L2 ${format(result.removed.l2)} 条`);
    } catch (err) {
      toast.error(`缓存清理失败：${err instanceof Error ? err.message : String(err)}`);
    } finally { setClearing(false); }
  };
  const overview = stats?.overview;
  const cache = stats?.cache;
  const quality = stats?.context?.quality;
  const ecosystem = stats?.ecosystem;
  const metrics = overview ? [
    { title: '会话', value: format(overview.sessions), description: '历史累计' },
    { title: '消息', value: format(overview.messages), description: '用户与助手' },
    { title: 'Tokens', value: format(overview.tokensIn + overview.tokensOut), description: `输入 ${format(overview.tokensIn)} · 输出 ${format(overview.tokensOut)}` },
    { title: '总成本', value: money(overview.cost), description: '已含缓存折扣' },
    { title: '截断次数', value: format(overview.truncations), description: '上下文超限自动截断' },
  ] : [];
  const layers = cache ? [
    { title: 'L1 语义问答', description: '字符 bigram · Dice 相似度', rate: cache.l1.rate, hits: cache.l1.hits, detail: `阈值 ≥ ${(cache.l1Threshold ?? 0.58).toFixed(2)} · ${cache.l1Enabled ? '已启用' : '已关闭'}` },
    { title: 'L2 工具结果', description: '工具与参数哈希 · 文件变更校验', rate: cache.l2.rate, hits: cache.l2.hits, detail: `有效期 ${cache.l2TtlMin ?? 30} 分钟 · 重复调用不重算` },
    { title: 'L3 prompt 前缀', description: 'Provider KV cache 复用', rate: cache.l3.realHits > 0 ? cache.l3.realRate : null, hits: cache.l3.realHits, detail: cache.l3.realHits > 0 ? `真实命中 ${format(cache.l3.realTokens)} tokens` : `暂无真实反馈 · 本地估算 ${format(cache.l3.tokens)} tokens` },
  ] : [];
  const processRows = stats ? [
    ['执行步骤', format(stats.process.steps), 'LLM 调用、工具调用与缓存命中'],
    ['LLM 调用', format(stats.process.llmCalls), '实际请求模型次数'],
    ['工具调用', format(stats.process.toolCalls), 'Agent 执行工具次数'],
    ['本次成本', money(stats.process.cost), '进程内累计，已含缓存折扣'],
  ] : [];
  const qualityRows = quality ? [
    ['上下文注入', format(quality.injections), '按需注入次数'],
    ['摘要压缩', format(quality.compactions), '早期历史摘要压缩'],
    ['截断', format(quality.truncations), '超预算时丢弃早期消息'],
    ['模型路由', format(quality.modelRoutes), '按任务复杂度切换模型'],
    ['思考预算降级', format(quality.reasoningHints), '超限时注入收敛提示'],
    ['工具面', format(quality.toolDefinitions), `描述与参数约 ${format(quality.toolDefBytes)} B`],
  ] : [];
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 p-4 md:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] tracking-[0.06em] text-muted-foreground">观测</p><h1>缓存与成本</h1><p>三层缓存、调用消耗与上下文质量。</p></div><div className="flex items-center gap-2"><Badge variant="outline">每 5 秒更新</Badge><Button variant="outline" size="sm" disabled={clearing} onClick={() => void clearCache()}>{clearing ? '清理中…' : '清理本租户缓存'}</Button></div></header>
        {error && <Alert variant="destructive"><AlertTitle>统计加载失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {!stats ? !error && <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-36" />)}</div> : <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{metrics.map((metric) => <Card key={metric.title} size="sm"><CardHeader><CardDescription>{metric.title}</CardDescription><CardTitle><span className="text-2xl font-semibold tracking-[-0.035em] tabular-nums">{metric.value}</span></CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{metric.description}</p></CardContent></Card>)}</div>
          {cache && <div className="grid gap-4 md:grid-cols-2"><Card><CardHeader><CardDescription>综合缓存命中率</CardDescription><CardTitle><span className="text-2xl font-semibold tracking-[-0.035em] tabular-nums">{percent(cache.overall?.rate ?? 0)}</span></CardTitle><CardAction><Badge variant="secondary">累计</Badge></CardAction></CardHeader><CardContent><Progress value={cache.overall?.rate ?? 0} aria-label="综合缓存命中率" /><p className="mt-3 text-sm text-muted-foreground">L1 {format(cache.l1.hits)} · L2 {format(cache.l2.hits)} · L3 本地估算 {format(cache.l3.hits)}</p></CardContent></Card><Card><CardHeader><CardDescription>累计节省调用</CardDescription><CardTitle><span className="text-2xl font-semibold tracking-[-0.035em] tabular-nums">{format(cache.overall?.served ?? 0)}</span></CardTitle></CardHeader><CardContent><p className="text-sm text-muted-foreground">折合节省 {money(cache.savedCost ?? 0)}</p></CardContent></Card></div>}
          <div className="grid gap-4 lg:grid-cols-3">{layers.map((layer) => <Card key={layer.title}><CardHeader><CardTitle>{layer.title}</CardTitle><CardDescription>{layer.description}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><span className="text-2xl font-semibold tracking-[-0.035em] tabular-nums">{layer.rate === null ? '—' : percent(layer.rate)}</span><Progress value={layer.rate ?? 0} aria-label={`${layer.title}命中率`} /><p className="text-sm">命中 {format(layer.hits)} 次</p><p className="text-xs text-muted-foreground">{layer.detail}</p></CardContent></Card>)}</div>
          {ecosystem && <Card><CardHeader><CardTitle>生态健康</CardTitle><CardDescription>插件、MCP server 与当前租户</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">插件 {ecosystem.plugins.started}/{ecosystem.plugins.total} 运行</Badge>
              <Badge variant={ecosystem.plugins.error > 0 ? 'destructive' : 'outline'}>错误 {ecosystem.plugins.error}</Badge>
              <Badge variant="outline">热重载 {ecosystem.plugins.watched}</Badge>
              <Badge variant="outline">租户 {ecosystem.tenant.id} · 会话 {format(ecosystem.tenant.sessions)}</Badge>
            </div>
            {ecosystem.mcp?.length ? <Table><TableHeader><TableRow><TableHead>MCP server</TableHead><TableHead>状态</TableHead><TableHead>工具</TableHead><TableHead className="text-right">健康</TableHead></TableRow></TableHeader><TableBody>{ecosystem.mcp.map((server) => <TableRow key={server.name}><TableCell className="font-medium">{server.name}</TableCell><TableCell><Badge variant={server.state === 'connected' ? 'secondary' : server.state === 'auth-required' ? 'outline' : 'destructive'}>{server.state}{server.auth?.state ? ` · ${server.auth.state}` : ''}</Badge></TableCell><TableCell>{format(server.tools)}</TableCell><TableCell className="text-right font-mono tabular-nums">{server.health?.state ?? '—'}{server.health?.failures ? ` · ${server.health.failures}` : ''}</TableCell></TableRow>)}</TableBody></Table> : null}
            {ecosystem.diagnostics.length > 0 && <Alert variant="destructive"><AlertTitle>插件诊断</AlertTitle><AlertDescription>{ecosystem.diagnostics.map((item) => item.message).join('；')}</AlertDescription></Alert>}
          </CardContent></Card>}
          {[{ title: '本次运行', description: '进程内累计', rows: processRows }, { title: '上下文质量', description: '上下文管理与工具面诊断', rows: qualityRows }].map((section) => <Card key={section.title}><CardHeader><CardTitle>{section.title}</CardTitle><CardDescription>{section.description}</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>指标</TableHead><TableHead>说明</TableHead><TableHead className="text-right">数值</TableHead></TableRow></TableHeader><TableBody>{section.rows.map(([label, value, description]) => <TableRow key={label}><TableCell className="font-medium">{label}</TableCell><TableCell className="whitespace-normal text-muted-foreground">{description}</TableCell><TableCell className="text-right font-mono tabular-nums">{value}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>)}
        </>}
      </div>
    </ScrollArea>
  );
}
