import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { providersApi, workspacesApi } from '../api';
import { runsApi, type WorkspacePermission } from '../run-api';
import type { ProviderInfo, WorkspaceInfo } from '../types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';

export default function GettingStarted({ providers, onModels, onChanged, onStart }: { providers: ProviderInfo[]; onModels: () => void; onChanged: () => void; onStart?: () => void }) {
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState('');
  const [connection, setConnection] = useState<string>();
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [permission, setPermission] = useState<WorkspacePermission>();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const provider = providers.find(item => item.id === selected) ?? providers.find(item => item.enabled);
  useEffect(() => { setConnection(undefined); }, [provider?.id, provider?.updatedAt]);
  const refreshWorkspace = async () => {
    const [items, current] = await Promise.all([workspacesApi.list(), runsApi.permission()]);
    setWorkspaces(items); setPermission(current);
  };
  useEffect(() => { void refreshWorkspace().catch(error => toast.error(String(error))); }, []);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (error) { toast.error(String(error)); } finally { setBusy(false); }
  };
  return <Card data-testid="getting-started"><CardHeader><CardTitle>开始使用</CardTitle><CardDescription>{['1 · 配置模型', '2 · 检测连接与工具调用', '3 · 选择工作区', '4 · 确认权限'][step]}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
    {step === 0 && <><p className="text-sm">添加模型提供商、协议、地址与凭据。</p><Button variant="outline" className="self-start" onClick={onModels}>配置模型</Button>{provider && <p className="text-sm">已配置：{provider.label} · {provider.model}</p>}</>}
    {step === 1 && <>
      <Field><FieldLabel htmlFor="onboarding-provider">检测线路</FieldLabel><Select value={provider?.id ?? ''} onValueChange={setSelected}><SelectTrigger id="onboarding-provider"><SelectValue placeholder="选择 Provider" /></SelectTrigger><SelectContent>{providers.filter(item => item.enabled).map(item => <SelectItem key={item.id} value={item.id}>{item.label} · {item.model}</SelectItem>)}</SelectContent></Select></Field>
      <Button variant="outline" className="self-start" disabled={!provider || busy} onClick={() => void perform(async () => {
        const result = await providersApi.test({ providerId: provider!.id, baseUrl: provider!.baseUrl, apiKey: '', model: provider!.model, protocol: provider!.protocol });
        if (!result.ok) throw new Error(result.error ?? '连接失败');
        const check = await providersApi.checkTools(provider!.id);
        setConnection(provider!.id);
        if (check.status !== 'confirmed') toast.warning(check.reason ?? '工具能力未知，可继续配置；执行前请确认模型支持原生工具调用');
        onChanged();
      })}>检测连接与工具调用（模型请求可能计费）</Button>
      <p className="text-sm">{connection === provider?.id ? '连接成功' : '尚未检测'} · 工具能力：{provider?.toolCheck?.status === 'confirmed' ? '已确认' : provider?.toolCheck?.status === 'not_confirmed' ? '本次未确认' : '未知'}</p>
    </>}
    {step === 2 && <>
      <Field><FieldLabel htmlFor="onboarding-workspace">工作区</FieldLabel><Select value={workspaces.find(item => item.current)?.path ?? ''} onValueChange={value => void perform(async () => { await workspacesApi.switchTo(value); await refreshWorkspace(); })}><SelectTrigger id="onboarding-workspace"><SelectValue placeholder="选择项目目录" /></SelectTrigger><SelectContent>{workspaces.map(item => <SelectItem key={item.id} value={item.path}>{item.path}</SelectItem>)}</SelectContent></Select></Field>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void perform(async () => { await workspacesApi.add(path.trim()); await workspacesApi.switchTo(path.trim()); setPath(''); await refreshWorkspace(); }); }}><Field className="min-w-0 flex-1"><FieldLabel htmlFor="onboarding-path">项目绝对路径</FieldLabel><Input id="onboarding-path" value={path} onChange={event => setPath(event.target.value)} /><FieldDescription>文件工具和命令以此目录为工作区。</FieldDescription></Field><Button variant="outline" disabled={busy || !path.trim()}>添加并选择</Button></form>
    </>}
    {step === 3 && <><Badge variant="secondary" className="self-start">{permission?.profile === 'developer' ? '开发者权限' : '常规权限'}</Badge><p className="break-all text-sm">{permission?.workspace}</p><p className="text-sm">常规权限允许工作区普通读写；敏感或高风险操作需要审批，框架源码受保护。开发者权限在工作区权限设置中明确开启。</p></>}
    <div className="flex flex-wrap gap-2">{step > 0 && <Button variant="ghost" disabled={busy} onClick={() => setStep(value => value - 1)}>上一步</Button>}{step < 3 ? <Button disabled={busy || !provider || step === 1 && connection !== provider.id || step === 2 && !permission} onClick={() => setStep(value => value + 1)}>下一步</Button> : <Button disabled={busy || !permission} onClick={onStart}>开始任务</Button>}</div>
  </CardContent></Card>;
}
