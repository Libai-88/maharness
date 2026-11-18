import { verificationLabel, toolStatusLabel } from '../run-status';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { runsApi, runLabels, type ModelCall, type ModelInput, type RunArtifact, type RunInfo, type RunTool, type TaskPluginInfo } from '../run-api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import DOMPurify from 'dompurify';
import { api } from '../api';
import ExperienceReviewPanel from './ExperienceReviewPanel';

const purposeLabels: Record<string, string> = { agent: '主循环', compaction: '历史摘要', vision: '视觉分析', mcp_sampling: 'MCP 模型请求', embedding: '向量检索', connection_check: '连接检测', experience_review: 'AI 使用复盘', experience_audit: '复盘独立复核' };
const sourceLabels: Record<string, string> = { runtime: '运行时', user: '用户', project: '项目', skill: '技能', plugin: '插件', example: '示例' };
const trustLabels: Record<string, string> = { core: '核心', user: '用户确认', reference: '参考' };
interface Detail { children: RunInfo[]; tools: RunTool[]; inputs: ModelInput[]; artifacts: RunArtifact[] }
export default function RunDiagnostics({ run, onInspect }: { run: RunInfo; onInspect?: (run: RunInfo) => void }) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState('');
  const [calls, setCalls] = useState<ModelCall[]>([]);
  const [plugins, setPlugins] = useState<TaskPluginInfo[]>([]);
  const [panel, setPanel] = useState<{ title: string; html: string }>();
  const [result, setResult] = useState<{ id: string; content: string; nextOffset?: number }>();
  const [reading, setReading] = useState(false);
  const [moreInputs, setMoreInputs] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setDetail(undefined); setResult(undefined); setPanel(undefined); setError(''); setReading(false); setMoreInputs(false);
    void Promise.all([runsApi.children(run.id), runsApi.tools(run.id), runsApi.inputs(run.id), runsApi.artifacts(run.id)])
      .then(([children, tools, inputs, artifacts]) => { if (generation.current === current) { setDetail({ children, tools, inputs, artifacts }); setMoreInputs(inputs.length === 10); } })
      .catch(error => { if (generation.current === current) setError(String(error)); });
    return () => { generation.current++; };
  }, [run.id, run.updatedAt]);
  const readResult = async (id: string, offset = 0) => {
    const current = generation.current;
    setReading(true);
    try {
      const page = await runsApi.result(run.id, id, offset);
      if (generation.current === current) setResult(previous => ({ id, content: (offset && previous?.id === id ? previous.content : '') + page.content, nextOffset: page.nextOffset }));
    } catch (error) { toast.error(String(error)); }
    finally { if (generation.current === current) setReading(false); }
  };
  const readInputs = async () => {
    const current = generation.current;
    const before = detail?.inputs.at(-1)?.id;
    if (!before) return;
    setReading(true);
    try {
      const page = await runsApi.inputs(run.id, before);
      if (generation.current === current) { setDetail(previous => previous && { ...previous, inputs: [...previous.inputs, ...page] }); setMoreInputs(page.length === 10); }
    } catch (error) { toast.error(String(error)); }
    finally { if (generation.current === current) setReading(false); }
  };
  const readPanel = async (pluginId: string) => {
    const current = generation.current;
    try {
      const value = await api<{ title: string; html: string }>(`/api/v2/runs/${run.id}/plugins/${encodeURIComponent(pluginId)}/api/panel`);
      if (typeof value.title !== 'string' || typeof value.html !== 'string') throw new Error('插件面板格式无效');
      if (generation.current === current) setPanel(value);
    } catch (error) { if (generation.current === current) toast.error(String(error)); }
  };
  useEffect(() => { let live = true; void runsApi.calls(run.id).then(rows => { if (live) setCalls(rows); }).catch(reason => { if (live) setError(String(reason)); }); return () => { live = false; }; }, [run.id, run.updatedAt]);
  useEffect(() => { let live = true; setPlugins([]); void runsApi.plugins(run.id).then(result => { if (live) setPlugins(Array.isArray(result.plugins) ? result.plugins : []); }).catch(reason => { if (live) setError(String(reason)); }); return () => { live = false; }; }, [run.id, run.updatedAt]);
  return <div className="flex min-w-0 flex-col gap-4" data-testid="run-diagnostics">
    <p className="break-words text-sm">{runLabels[run.status]} · {run.model} · ${run.cost.toFixed(4)}{run.usageStatus === 'unknown' ? '（用量不完整）' : run.usageStatus === 'estimated' ? '（估算）' : ''} · 费用{run.budgetPolicy === 'enforce' ? '硬限制' : '提醒额度'}：{run.budgetUsd === undefined ? '未设置' : `$${run.budgetUsd}`} · 截止时间：{run.deadlineAt === undefined ? '未设置' : new Date(run.deadlineAt).toLocaleString()}</p>
    <p className="text-sm text-muted-foreground">费用上限与截止时间来自显式任务配置；子任务费用计入同一父任务。</p>
    {run.origin?.kind === 'automation' && <p className="break-all text-sm">来源：自动化 {run.origin.automationId} · 本次运行 {run.origin.occurrenceId}</p>}
    {run.origin?.kind === 'society' && <p className="break-all text-sm">来源：AI 社会任务 {run.origin.societyTaskId} · 调度 {run.origin.scheduleId} · 分工 {run.origin.assignmentContractId}</p>}
    <section aria-label="能力选择" className="flex flex-col gap-2"><h3 className="font-medium">能力选择</h3>{!run.capabilityResolution ? <p className="text-sm text-muted-foreground">尚未按能力加载工具</p> : <><p className="break-words text-sm">已选择：{run.capabilityResolution.selected.join('、') || '无'} · 原因：{run.capabilityResolution.reason}</p><p className="break-words text-xs text-muted-foreground">工具：{run.capabilityResolution.tools.join('、') || '无'}</p>{run.capabilityResolution.conflicts.length > 0 && <details><summary className="cursor-pointer text-sm">能力冲突 · {run.capabilityResolution.conflicts.length}</summary>{run.capabilityResolution.conflicts.map(conflict => <p key={`${conflict.capabilityId}:${conflict.shadowedBy}`} className="break-all text-xs text-muted-foreground">{conflict.capabilityId} 由 {conflict.shadowedBy} 取代</p>)}</details>}</>}</section>
    <section aria-label="规则裁决" className="flex flex-col gap-2"><h3 className="font-medium">规则裁决</h3>{!run.ruleResolution ? <p className="text-sm text-muted-foreground">历史任务未记录规则裁决</p> : <><p className="text-sm">生效 {run.ruleResolution.applied.length} 条 · 未生效 {run.ruleResolution.ignored.length} 条 · 冲突 {run.ruleResolution.conflicts.length} 条</p><details><summary className="cursor-pointer text-sm">生效来源</summary>{run.ruleResolution.applied.map(rule => <p key={rule.id} className="break-all text-xs text-muted-foreground">{sourceLabels[rule.source] ?? rule.source} · {rule.label} · 优先级 {rule.priority} · {trustLabels[rule.trust] ?? rule.trust}</p>)}</details>{run.ruleResolution.ignored.length > 0 && <details><summary className="cursor-pointer text-sm">未生效来源</summary>{run.ruleResolution.ignored.map(rule => <p key={rule.id} className="break-all text-xs text-muted-foreground">{sourceLabels[rule.source] ?? rule.source} · {rule.label} · {rule.active ? '优先级或去重' : '已停用'}</p>)}</details>}{run.ruleResolution.conflicts.length > 0 && <details><summary className="cursor-pointer text-sm">冲突裁决</summary>{run.ruleResolution.conflicts.map(conflict => <p key={`${conflict.left}:${conflict.right}`} className="break-all text-xs text-muted-foreground">{conflict.left} / {conflict.right} · {conflict.reason} · 采用 {conflict.winner}</p>)}</details>}</>}</section>
    {error && <p role="alert">{error}</p>}
    <section aria-label="任务插件" className="flex flex-col gap-2"><h3 className="font-medium">任务插件</h3>{plugins.length === 0 && <p className="text-sm text-muted-foreground">暂无任务插件</p>}{plugins.map(plugin => <div key={plugin.hash} className="flex flex-col gap-2"><p className="break-all text-sm">{plugin.manifest.name} · {plugin.version} · {plugin.scope === 'run' ? '任务' : '工作区'} · {plugin.state} · {plugin.hash.slice(0, 12)}</p><p className="break-words text-xs text-muted-foreground">能力：{Object.entries(plugin.manifest.permissions.capabilities).map(([kind, names]) => `${kind}: ${names.join('、')}`).join('；')} · 依赖：{plugin.manifest.requires?.join('、') || '无'}</p>{plugin.error && <p role="alert" className="break-words text-xs">{plugin.error}</p>}<Button variant="outline" size="sm" disabled={reading || !['validated', 'active', 'stopped'].includes(plugin.state)} onClick={() => { setReading(true); void runsApi.savePlugin(run.id, plugin).then(() => toast.success('已保存为工作区插件')).catch(error => toast.error(String(error))).finally(() => setReading(false)); }}>保存到工作区</Button>{plugin.state === 'active' && plugin.manifest.permissions.capabilities.api?.includes('panel') && <Button size="sm" variant="ghost" onClick={() => void readPanel(plugin.id)}>查看面板</Button>}</div>)}</section>
    {panel && <section aria-label="任务插件面板"><h3 className="font-medium">{panel.title}</h3><div className="break-words" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(panel.html) }} /></section>}
    {!detail && !error && <p role="status">正在读取…</p>}
    {run.billingNotice && <p role="status" className="text-sm">{run.billingNotice}</p>}
    <section aria-label="模型调用账本" className="flex flex-col gap-2"><h3 className="font-medium">模型调用与费用来源</h3>{calls.length === 0 && <p className="text-sm text-muted-foreground">尚无调用记录；历史任务可能未记录</p>}{calls.map(call => <p key={call.id} className="break-all text-xs">{purposeLabels[call.purpose] ?? call.purpose} · {call.providerId}/{call.actualModel ?? call.model} · {call.status}{call.finishReason ? ` · ${call.finishReason}` : ''}{call.errorCode ? ` · ${call.errorCode}` : ''} · 输入 {call.input ?? '未知'} / 输出 {call.output ?? '未知'} · {call.cost === undefined ? '费用待核对' : `$${call.cost.toFixed(6)}`} · 用量 {({ reported: '已报告', estimated: '估算', unknown: '未知' } as Record<string, string>)[call.usageStatus] ?? call.usageStatus} · 价格 {({ configured: '用户配置', catalog: '模型目录', unknown: '未知' } as Record<string, string>)[call.priceSource] ?? call.priceSource}</p>)}{calls.length > 0 && calls.length % 100 === 0 && <Button size="sm" variant="outline" onClick={() => void runsApi.calls(run.id, calls.length).then(rows => setCalls(previous => [...previous, ...rows]))}>读取更多调用</Button>}</section>
    <ExperienceReviewPanel runIds={[run.id]} />
    {run.error && <p role="alert" className="break-words">{run.error}</p>}
    <details><summary className="cursor-pointer font-medium">机器验收 · {verificationLabel(run.verification)}</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(run.verification ?? '尚未验证', null, 2)}</pre></details>
    {detail && <>
      <section aria-label="任务产物" className="flex flex-col gap-2"><h3 className="font-medium">产物</h3>{!detail.artifacts.length && <p className="text-sm text-muted-foreground">暂无工具登记的产物</p>}{detail.artifacts.map(artifact => <div key={artifact.id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-all text-sm">{artifact.ref}</span><Button variant="outline" size="sm" disabled={reading} onClick={() => void readResult(artifact.callId)}>查看生成记录</Button></div>)}</section>
      <section aria-label="子任务" className="flex flex-col gap-2"><h3 className="font-medium">子任务</h3>{!detail.children.length && <p className="text-sm text-muted-foreground">暂无子任务</p>}{detail.children.map(child => <div key={child.id} className="flex flex-wrap items-center gap-2"><Badge variant="outline">{runLabels[child.status]}</Badge><span className="min-w-0 break-words text-sm">{child.objective}</span>{onInspect && <Button size="sm" variant="ghost" onClick={() => onInspect(child)}>查看子任务</Button>}</div>)}</section>
      <section aria-label="工具执行记录" className="flex flex-col gap-2"><h3 className="font-medium">工具执行</h3>{detail.tools.map(tool => <div key={tool.id} className="flex flex-wrap items-center gap-2"><Badge variant="outline">{toolStatusLabel(tool.status)}</Badge><span className="text-sm">{tool.name}{tool.version ? ` · v${tool.version}` : ''}</span><Button size="sm" variant="ghost" disabled={reading || tool.status === 'started'} onClick={() => void readResult(tool.id)}>读取完整结果</Button><p className="w-full break-all text-xs text-muted-foreground">{tool.argsSummary}</p>{tool.sideEffect && <p className="w-full break-all text-xs text-muted-foreground">声明副作用：{tool.sideEffect} · 结果：{tool.sideEffectOutcome ?? '未记录'}</p>}{tool.failure && <p className="w-full break-all text-xs text-muted-foreground">错误码：{tool.failure.code} · 副作用：{({ not_started: '未开始', applied: '已发生', unknown: '未知' })[tool.failure.outcome]} · {tool.failure.retryable ? '可按策略重试' : '不可自动重试'}</p>}</div>)}</section>
      {result && <section aria-label="完整工具结果" className="flex flex-col gap-2"><pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{result.content}</pre>{result.nextOffset !== undefined && <Button size="sm" variant="outline" disabled={reading} onClick={() => void readResult(result.id, result.nextOffset)}>读取下一页</Button>}</section>}
      <section aria-label="模型输入" className="flex flex-col gap-2"><h3 className="font-medium">模型输入与提示词组成</h3>{detail.inputs.map(input => <details key={input.id} className="min-w-0"><summary className="cursor-pointer text-sm">第 {input.turn + 1} 轮 · {input.providerId} / {input.model}{input.usage && ` · 输入约 ${input.usage.inputTokens} / 窗口 ${input.usage.window} · 输出预留 ${input.usage.outputReserve} (${input.usage.outputLimitSource === 'default' ? '默认能力' : input.usage.outputLimitSource === 'model' ? '模型能力' : '来源未记录'})`}</summary><div className="mt-2 flex flex-col gap-2">{input.diagnostics ? <><p className="break-words text-xs text-muted-foreground">{input.diagnostics.measurement === 'tokenizer' ? '分词器计量' : '本地估算'}：消息 {input.diagnostics.messageTokens} tokens · 工具 schema {input.diagnostics.toolTokens} tokens；{input.diagnostics.sources.map(item => `${item.source}: ${item.tokens}`).join('、')}</p><p className="break-all text-xs text-muted-foreground">能力版本：{input.diagnostics.capabilityRevision ?? '未记录'} · 执行尝试：{input.diagnostics.attemptId ?? '未记录'} · 恢复断点：{input.diagnostics.resumedFromTurn === undefined ? '未记录' : input.diagnostics.resumedFromTurn < 0 ? '首次执行' : `第 ${input.diagnostics.resumedFromTurn + 1} 轮`} · 输入指纹：{input.diagnostics.fingerprint}</p>{input.diagnostics.toolSources && <details><summary className="cursor-pointer text-xs">逐工具 schema 用量（估算）</summary>{input.diagnostics.toolSources.map(tool => <p key={tool.name} className="break-all text-xs text-muted-foreground">{tool.name} · {tool.tokens} tokens</p>)}</details>}</> : <p className="text-xs text-muted-foreground">输入分项：未记录</p>}{input.messages.map((message, index) => <details key={index}><summary className="cursor-pointer text-xs">{message.role} · {message.context?.source ?? 'history'} · {message.context?.trust ?? 'reference'} · {message.context?.retention ?? 'summarize'}</summary><pre tabIndex={0} className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{message.content}</pre></details>)}<p className="break-words text-xs text-muted-foreground">工具：{input.tools.map(tool => tool.name).join('、')}</p></div></details>)}</section>
      {moreInputs && <Button variant="outline" size="sm" disabled={reading} onClick={() => void readInputs()}>读取更早模型输入</Button>}
    </>}
  </div>;
}
