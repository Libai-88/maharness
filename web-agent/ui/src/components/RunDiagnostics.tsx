import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { runsApi, runLabels, type ModelInput, type RunArtifact, type RunInfo, type RunTool } from '../run-api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Detail { children: RunInfo[]; tools: RunTool[]; inputs: ModelInput[]; artifacts: RunArtifact[] }
export default function RunDiagnostics({ run, onInspect }: { run: RunInfo; onInspect?: (run: RunInfo) => void }) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ id: string; content: string; nextOffset?: number }>();
  const [reading, setReading] = useState(false);
  const [moreInputs, setMoreInputs] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setDetail(undefined); setResult(undefined); setError(''); setReading(false); setMoreInputs(false);
    void Promise.all([runsApi.children(run.id), runsApi.tools(run.id), runsApi.inputs(run.id), runsApi.artifacts(run.id)])
      .then(([children, tools, inputs, artifacts]) => { if (generation.current === current) { setDetail({ children, tools, inputs, artifacts }); setMoreInputs(inputs.length === 10); } })
      .catch(error => { if (generation.current === current) setError(String(error)); });
    return () => { generation.current++; };
  }, [run.id]);
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
  return <div className="flex min-w-0 flex-col gap-4" data-testid="run-diagnostics">
    <p className="break-words text-sm">{runLabels[run.status]} · {run.model} · ${run.cost.toFixed(4)}{run.usageStatus === 'unknown' ? '（用量不完整）' : run.usageStatus === 'estimated' ? '（估算）' : ''} · 费用上限：{run.budgetUsd === undefined ? '未设置' : `$${run.budgetUsd}`} · 截止时间：{run.deadlineAt === undefined ? '未设置' : new Date(run.deadlineAt).toLocaleString()}</p>
    <p className="text-sm text-muted-foreground">费用上限与截止时间来自显式任务配置；子任务费用计入同一父任务。</p>
    {error && <p role="alert">{error}</p>}
    {!detail && !error && <p role="status">正在读取…</p>}
    {run.error && <p role="alert" className="break-words">{run.error}</p>}
    <details><summary className="cursor-pointer font-medium">机器验收 · {run.verification ? '有验收记录' : '尚未验证'}</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(run.verification ?? '尚未验证', null, 2)}</pre></details>
    {detail && <>
      <section aria-label="任务产物" className="flex flex-col gap-2"><h3 className="font-medium">产物</h3>{!detail.artifacts.length && <p className="text-sm text-muted-foreground">暂无工具登记的产物</p>}{detail.artifacts.map(artifact => <div key={artifact.id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-all text-sm">{artifact.ref}</span><Button variant="outline" size="sm" disabled={reading} onClick={() => void readResult(artifact.callId)}>查看生成记录</Button></div>)}</section>
      <section aria-label="子任务" className="flex flex-col gap-2"><h3 className="font-medium">子任务</h3>{!detail.children.length && <p className="text-sm text-muted-foreground">暂无子任务</p>}{detail.children.map(child => <div key={child.id} className="flex flex-wrap items-center gap-2"><Badge variant="outline">{runLabels[child.status]}</Badge><span className="min-w-0 break-words text-sm">{child.objective}</span>{onInspect && <Button size="sm" variant="ghost" onClick={() => onInspect(child)}>查看子任务</Button>}</div>)}</section>
      <section aria-label="工具执行记录" className="flex flex-col gap-2"><h3 className="font-medium">工具执行</h3>{detail.tools.map(tool => <div key={tool.id} className="flex flex-wrap items-center gap-2"><Badge variant="outline">{tool.status}</Badge><span className="text-sm">{tool.name}</span><Button size="sm" variant="ghost" disabled={reading || tool.status === 'started'} onClick={() => void readResult(tool.id)}>读取完整结果</Button><p className="w-full break-all text-xs text-muted-foreground">{tool.argsSummary}</p></div>)}</section>
      {result && <section aria-label="完整工具结果" className="flex flex-col gap-2"><pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{result.content}</pre>{result.nextOffset !== undefined && <Button size="sm" variant="outline" disabled={reading} onClick={() => void readResult(result.id, result.nextOffset)}>读取下一页</Button>}</section>}
      <section aria-label="模型输入" className="flex flex-col gap-2"><h3 className="font-medium">模型输入与提示词组成</h3>{detail.inputs.map(input => <details key={input.id} className="min-w-0"><summary className="cursor-pointer text-sm">第 {input.turn + 1} 轮 · {input.providerId} / {input.model}{input.usage && ` · 输入约 ${input.usage.inputTokens} / 窗口 ${input.usage.window} · 输出预留 ${input.usage.outputReserve}`}</summary><div className="mt-2 flex flex-col gap-2">{input.diagnostics ? <><p className="break-words text-xs text-muted-foreground">本地估算：消息 {input.diagnostics.messageTokens} tokens · 工具 schema {input.diagnostics.toolTokens} tokens；{input.diagnostics.sources.map(item => `${item.source}: ${item.tokens}`).join('、')}</p><p className="break-all text-xs text-muted-foreground">执行尝试：{input.diagnostics.attemptId ?? '未记录'} · 恢复断点：{input.diagnostics.resumedFromTurn === undefined ? '未记录' : input.diagnostics.resumedFromTurn < 0 ? '首次执行' : `第 ${input.diagnostics.resumedFromTurn + 1} 轮`} · 输入指纹：{input.diagnostics.fingerprint}</p></> : <p className="text-xs text-muted-foreground">输入分项：未记录</p>}{input.messages.map((message, index) => <details key={index}><summary className="cursor-pointer text-xs">{message.role} · {message.context?.source ?? 'history'} · {message.context?.trust ?? 'reference'} · {message.context?.retention ?? 'summarize'}</summary><pre tabIndex={0} className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{message.content}</pre></details>)}<p className="break-words text-xs text-muted-foreground">工具：{input.tools.map(tool => tool.name).join('、')}</p></div></details>)}</section>
      {moreInputs && <Button variant="outline" size="sm" disabled={reading} onClick={() => void readInputs()}>读取更早模型输入</Button>}
    </>}
  </div>;
}
