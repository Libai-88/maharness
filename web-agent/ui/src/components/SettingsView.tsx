import WorkspacePermissions from './WorkspacePermissions';
import GettingStarted from './GettingStarted';
import DocumentSettings from './DocumentSettings';
// ui/src/components/SettingsView.tsx —— 设置面板（Screen 7/8/6）：导航 + Provider 配置 + 上下文管理 + 技能系统
import { useCallback, useEffect, useState } from 'react';
import { configApi, getMutationToken, getTenantId, metaApi, providersApi, rulesApi, securityApi, setMutationToken, setTenantId, statsApi, type SecurityPosture } from '../api';
import type { PolicyDryRunView, RulesView, RuntimeConfig } from '../api';
import type { PluginNavItem, ProviderDiagnostic, ProviderForm, ProviderInfo, PulledModel, StatsInfo } from '../types';
import type { Brand, Theme } from '../App';
import { toast } from 'sonner';
import { Check, ChevronsUpDown, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import SkillsView from './SkillsView';
import PersonaPanel from './PersonaPanel';
import { Switch } from '@/components/ui/switch';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useIsMobile } from '@/hooks/use-mobile';

interface Props {
  onStartTask?: () => void;
  onOpenPlugins?: () => void;
  onOpenRuns?: () => void;
  onOpenStats?: () => void;
  pluginNav?: PluginNavItem[];
  onOpenPluginNav?: (key: string) => void;
  providers: ProviderInfo[];
  onChanged: () => void;
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  brand: Brand;
  onBrandChange: (b: Brand) => void;
}

type SettingTab = 'general' | 'providers' | 'context' | 'routing' | 'personas' | 'rules' | 'skills' | 'advanced';

const EMPTY: ProviderForm = { label: '', baseUrl: '', apiKey: '', model: '', protocol: 'openai', priceIn: '', priceOut: '' };
const PROVIDER_PRESETS: { label: string; baseUrl: string; model: string; protocol: string }[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', protocol: 'openai' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', protocol: 'openai' },
  { label: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', protocol: 'anthropic' },
  { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', protocol: 'ollama' },
];

function SettingsHeading({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return <header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h1>{title}</h1><p>{description}</p></div>{children}</header>;
}

function Notice({ ok = true, children }: { ok?: boolean; children: React.ReactNode }) {
  return <Alert variant={ok ? 'default' : 'destructive'} role="status">{ok ? <Check /> : <ShieldAlert />}<AlertDescription>{children}</AlertDescription></Alert>;
}

function ProvidersSection({ providers, onChanged }: { providers: ProviderInfo[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY);
  const [busy, setBusy] = useState<'save' | 'test' | 'pull' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; ms: number; pending?: boolean }>>({});
  const [diagnostics, setDiagnostics] = useState<Record<string, ProviderDiagnostic | null>>({});
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const checkTools = async (p: ProviderInfo) => {
    setCheckingId(p.id);
    try { const result = await providersApi.checkTools(p.id); if (result.status === 'confirmed') toast.success('已确认原生工具调用能力'); else toast.error(result.reason ?? '本次检测未确认工具调用能力'); onChanged(); }
    catch (error) { toast.error(String(error)); }
    finally { setCheckingId(null); }
  };
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // 拉取到的模型列表（datalist 供「模型」输入框下拉选择；切换新建/编辑时重置）
  const [models, setModels] = useState<PulledModel[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; onOk: () => void } | null>(null);
  // 本地网关（Ollama 等）无需 API Key——校验与占位提示随协议切换
  const isLocal = (form.protocol ?? 'openai') === 'ollama';

  const refresh = async (ok: boolean, text: string) => {
    setMsg({ ok, text });
    setTimeout(() => setMsg(null), 4000);
    if (ok) { setCreating(false); setEditing(null); onChanged(); }
  };

  const startCreate = () => { setCreating(true); setEditing(null); setForm(EMPTY); setMsg(null); setModels([]); };
  const startEdit = (p: ProviderInfo) => {
    setEditing(p); setCreating(false); setMsg(null); setModels([]);
    setForm({ label: p.label, baseUrl: p.baseUrl, apiKey: '', model: p.model, protocol: p.protocol ?? 'openai', priceIn: p.priceIn ? String(p.priceIn) : '', priceOut: p.priceOut ? String(p.priceOut) : '' });
  };

  const save = async () => {
    if (!form.label.trim() || !form.baseUrl.trim() || !form.model.trim() || (!isLocal && creating && !form.apiKey.trim())) {
      return refresh(false, isLocal ? '名称 / 地址 / 模型必填（本地网关无需 Key）' : '名称 / 地址 / 模型必填，新建时 Key 必填');
    }
    setBusy('save');
    let savedId: string | null = null;
    try {
      if (creating) { const p = await providersApi.create(form); savedId = p.id; await refresh(true, '已添加'); }
      else if (editing) { await providersApi.update(editing.id, { ...form, expectedUpdatedAt: editing.updatedAt }); savedId = editing.id; await refresh(true, '已保存'); }
      else { return; }
    } catch (err) {
      await refresh(false, err instanceof Error ? err.message : String(err));
      setBusy(null);
      return;
    }
    setBusy(null);
    // 保存（尤其是换 key）后立即验证：一次测试请求确认恢复，不等下一条真实消息
    if (savedId) await verifyKey(savedId, form.baseUrl.trim(), form.model.trim(), form.protocol);
  };

  const test = async () => {
    if (!form.baseUrl.trim() || !form.model.trim() || (!isLocal && !creating && !form.apiKey.trim() && !editing?.hasKey)) {
      return refresh(false, isLocal ? '请先填写地址 / 模型再测试' : '请先填写地址 / 模型 / Key 再测试');
    }
    setBusy('test');
    try {
      const r = await providersApi.test({
        baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), model: form.model.trim(),
        protocol: form.protocol, ...(editing ? { providerId: editing.id } : {}),
      });
      if (r.ok) await refresh(true, r.message ?? `连接成功（${r.latencyMs ?? 0}ms）`);
      else await refresh(false, r.error ?? '连接失败');
    } catch (err) { await refresh(false, err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const pullModels = async () => {
    if (!form.baseUrl.trim() || (!isLocal && !form.apiKey.trim() && !editing?.hasKey)) {
      return refresh(false, isLocal ? '请先填写 Base URL' : '请先填写 Base URL 与 Key（编辑已保存 Provider 时 Key 可留空）');
    }
    setBusy('pull');
    try {
      // 编辑时传 providerId：后端用已存储的 Key 拉取（前端拿不到明文 Key）
      const r = await providersApi.fetchModels({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        protocol: form.protocol,
        ...(editing ? { providerId: editing.id } : {}),
      });
      const list = r.models ?? [];
      setModels(list);
      // 选中即免手填：模型名 + 价格一并带入表单
      setForm((f) => {
        const pick = list.find(m => m.id === f.model.trim()) ?? list[0];
        if (!pick) return f;
        return {
          ...f,
          model: pick.id,
          priceIn: f.priceIn?.trim() ? f.priceIn : String(pick.priceIn ?? ''),
          priceOut: f.priceOut?.trim() ? f.priceOut : String(pick.priceOut ?? ''),
        };
      });
      const vision = list.filter(m => m.vision).length;
      setMsg({ ok: true, text: `已拉取 ${list.length} 个模型（其中 ${vision} 个支持视觉）——选择模型即自动带入能力与价格` });
      setTimeout(() => setMsg(null), 6000);
    } catch (err) {
      await refresh(false, err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const toggle = async (p: ProviderInfo) => {
    if (togglingId) return;
    setTogglingId(p.id);
    try {
      await providersApi.update(p.id, { enabled: !p.enabled, expectedUpdatedAt: p.updatedAt });
      onChanged();
      toast.success(`「${p.label}」已${p.enabled ? '先歇着' : '开始干活'}`);
    } catch (err) {
      toast.error(`「${p.label}」没切换成功：${err instanceof Error ? err.message : String(err)}`);
    } finally { setTogglingId(null); }
  };

  const remove = (p: ProviderInfo) => {
    setConfirm({
      text: `删除 Provider「${p.label}」？这把钥匙的配置会一起删掉。`,
      onOk: () => {
        void (async () => {
          try {
            await providersApi.remove(p.id, p.updatedAt);
            onChanged();
            toast.success(`「${p.label}」已经删掉了`);
          } catch (err) {
            toast.error(`没删掉：${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      },
    });
  };

  /** 验证密钥（用已存储的 Key 发一次测试请求）：结果联动 provider 健康——
   *  成功清除 authFailed 红标与会话横幅；失败标记失效。 */
  const verifyKey = async (id: string, base: string, model: string, protocol?: string) => {
    setTestResult((r) => ({ ...r, [id]: { ok: false, ms: 0, pending: true } }));
    try {
      const r = await providersApi.test({ baseUrl: base, apiKey: '', model, protocol, providerId: id });
      setTestResult((prev) => ({ ...prev, [id]: { ok: r.ok, ms: r.latencyMs ?? 0 } }));
      if (r.ok) setMsg({ ok: true, text: `钥匙可用（往返 ${r.latencyMs ?? 0}ms）——这条线路已恢复` });
      else setMsg({ ok: false, text: `钥匙没通过：${r.error ?? '连不上'}${r.authFailed ? '（密钥无效，检查后重新保存）' : ''}` });
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [id]: { ok: false, ms: 0 } }));
      setMsg({ ok: false, text: `验证没做成：${err instanceof Error ? err.message : String(err)}` });
    }
    setTimeout(() => setMsg(null), 6000);
    // 健康状态已变（清除/标记）——刷新列表让红标即时生效
    onChanged();
  };

  const runTest = async (p: ProviderInfo) => {
    if (testResult[p.id]?.pending) return;
    setTestResult((r) => ({ ...r, [p.id]: { ok: false, ms: 0, pending: true } }));
    try {
      // 传 providerId：后端用已存储的 Key 发起测试（前端拿不到明文 Key），
      // 结果联动健康状态（成功恢复红标消失 / 失败标记失效）
      const r = await providersApi.test({ baseUrl: p.baseUrl, apiKey: '', model: p.model, protocol: p.protocol, providerId: p.id });
      setTestResult((prev) => ({ ...prev, [p.id]: { ok: r.ok, ms: r.latencyMs ?? 0 } }));
      if (!r.ok) toast.error(`「${p.label}」没连上：${r.error ?? '说不清原因'}${r.authFailed ? '（这把钥匙无效）' : ''}`);
      else toast.success(`「${p.label}」钥匙可用（往返 ${r.latencyMs ?? 0}ms）`);
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [p.id]: { ok: false, ms: 0 } }));
      toast.error(`验证没做成：${err instanceof Error ? err.message : String(err)}`);
    }
    // 红标即时更新（后端已联动健康状态）
    onChanged();
  };

  const runDiagnostic = async (p: ProviderInfo) => {
    try {
      const result = await providersApi.diagnose(p.id);
      setDiagnostics((prev) => ({ ...prev, [p.id]: result }));
    } catch (err) {
      toast.error(`诊断失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      <SettingsHeading title="模型与 Provider" description="管理模型、连接凭据与调用价格。"><Button onClick={startCreate}><Plus data-icon="inline-start" />新增 Provider</Button></SettingsHeading>
      {msg && <Notice ok={msg.ok}>{msg.text}</Notice>}

      {(creating || editing) && (
        <Card>
          <CardHeader><CardTitle>{creating ? '新增 Provider' : `编辑 · ${editing!.label}`}</CardTitle><CardDescription>保存后即可在对话中切换模型。</CardDescription></CardHeader>
          <CardContent>{creating && <div className="mb-4 flex flex-wrap gap-2">{PROVIDER_PRESETS.map(preset => <Button key={preset.label} type="button" size="sm" variant="outline" onClick={() => setForm({ ...EMPTY, ...preset, apiKey: form.apiKey })}>{preset.label}</Button>)}</div>}<FieldGroup className="grid grid-cols-1 md:grid-cols-2">
            <Field><FieldLabel htmlFor="provider-label">Provider 名称</FieldLabel><Input id="provider-label" placeholder="如 DeepSeek" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
            <Field><FieldLabel htmlFor="provider-base">Base URL</FieldLabel><Input id="provider-base" placeholder={isLocal ? 'http://localhost:11434/v1' : 'https://api.deepseek.com'} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></Field>
            <Field><FieldLabel htmlFor="provider-key">API Key</FieldLabel><Input id="provider-key" placeholder={isLocal ? '本地网关可留空' : editing ? '留空保留已保存的密钥' : '输入 API Key'} type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></Field>
            <Field><FieldLabel htmlFor="provider-protocol">协议类型</FieldLabel>
            <Select value={form.protocol ?? 'openai'} onValueChange={(value) => setForm({ ...form, protocol: value })}>
              <SelectTrigger id="provider-protocol" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="openai">OpenAI 兼容（多数网关/国产）</SelectItem>
                  <SelectItem value="anthropic">Anthropic 原生</SelectItem>
                  <SelectItem value="ollama">Ollama 本地</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select></Field>
            <Field className="md:col-span-2"><FieldLabel htmlFor="provider-model">模型名</FieldLabel><Input id="provider-model" placeholder="输入模型 ID，或拉取后选择" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field>
            <Field><FieldLabel htmlFor="provider-price-in">输入价格（USD / 1M tokens）</FieldLabel><Input id="provider-price-in" inputMode="decimal" value={form.priceIn ?? ''} onChange={(e) => setForm({ ...form, priceIn: e.target.value })} /></Field>
            <Field><FieldLabel htmlFor="provider-price-out">输出价格（USD / 1M tokens）</FieldLabel><Input id="provider-price-out" inputMode="decimal" value={form.priceOut ?? ''} onChange={(e) => setForm({ ...form, priceOut: e.target.value })} /></Field>
          </FieldGroup>
          {msg && !msg.ok && <p className="mt-4 text-sm text-muted-foreground">检查 Base URL 与 API Key，再点击“测试连接”。失败时可用“拉取模型列表”确认服务端返回的模型 ID。凭据只保存在本机配置中。</p>}
          {models.length > 0 && (
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild><Button variant="outline" className="mt-4 w-full justify-between" role="combobox" aria-label={`选择已拉取的模型（${models.length}）`} aria-expanded={modelOpen}>选择已拉取的模型（{models.length}）<ChevronsUpDown data-icon="inline-end" /></Button></PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start" aria-label="选择已拉取的模型"><Command><CommandInput placeholder="搜索模型…" aria-label="搜索已拉取的模型" /><CommandList><CommandEmpty>无匹配模型</CommandEmpty><CommandGroup heading="可用模型">
              {models.map((m) => (
                <CommandItem key={m.id} value={m.id} onSelect={() => { setForm({
                    ...form, model: m.id,
                    priceIn: form.priceIn?.trim() ? form.priceIn : String(m.priceIn ?? ''),
                    priceOut: form.priceOut?.trim() ? form.priceOut : String(m.priceOut ?? ''),
                  }); setModelOpen(false); }} title={`上下文 ${m.contextWindow} · 最大输出 ${m.maxOutput} · $${m.priceIn}/$${m.priceOut} per 1M`}>
                  <span className="min-w-0 flex-1 truncate">{m.id}</span>
                  {m.vision && <Badge variant="secondary">视觉</Badge>}{m.tools && <Badge variant="secondary">工具</Badge>}{m.reasoning && <Badge variant="secondary">推理</Badge>}
                  {form.model === m.id && <Check />}
                </CommandItem>
              ))}
              </CommandGroup></CommandList></Command></PopoverContent>
            </Popover>
          )}
          {isLocal && (
            <p className="mt-4 text-sm text-muted-foreground">
              本地网关提示：本机模式直接连接即可；Key 留空，地址填 http://localhost:11434/v1（Ollama 默认端口）。
            </p>
          )}
          </CardContent><CardFooter className="flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={busy !== null}>{busy === 'save' && <Spinner data-icon="inline-start" />}保存</Button>
            <Button variant="outline" onClick={() => void pullModels()} disabled={busy !== null}>{busy === 'pull' && <Spinner data-icon="inline-start" />}拉取模型列表</Button>
            <Button variant="outline" onClick={() => void test()} disabled={busy !== null}>{busy === 'test' && <Spinner data-icon="inline-start" />}测试连接</Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => { setCreating(false); setEditing(null); }}>取消</Button>
          </CardFooter>
        </Card>
      )}

      {providers.map((p) => {
        const connected = p.enabled && (p.hasKey || p.protocol === 'ollama');
        const tr = testResult[p.id];
        const diagnostic = diagnostics[p.id];
        return (
          <Card key={p.id}>
            <CardHeader><CardTitle>{p.label}</CardTitle><CardDescription className="break-all">{p.baseUrl}</CardDescription>
              <CardAction><div className="flex items-center gap-3">
                {p.health?.authFailed && (
                  <Badge variant="destructive" title={p.health.lastError}>密钥失效</Badge>
                )}
                <Switch
                  checked={p.enabled}
                  aria-label={`${p.enabled ? '停用' : '启用'} Provider ${p.label}`}
                  disabled={togglingId === p.id}
                  onCheckedChange={() => void toggle(p)}
                  title={p.enabled ? '停用' : '启用'}
                />
              </div></CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4"><div className="flex flex-wrap gap-2"><Badge variant={connected ? 'secondary' : 'outline'}>{connected ? (providers[0]?.id === p.id ? '已配置 · 默认' : '已配置') : !p.enabled ? '已停用' : '未配置密钥'}</Badge><Badge variant="outline">{p.protocol ?? 'openai'}</Badge>{(p.models?.length ?? 0) > 0 && <Badge variant="outline">{p.models!.length} 模型</Badge>}{(p.models ?? []).some((m) => !!m.vision) && <Badge variant="outline">视觉资料</Badge>}<Badge variant="outline">协议支持工具调用</Badge><Badge variant={p.toolCheck?.status === 'confirmed' ? 'secondary' : 'outline'}>模型工具能力：{p.toolCheck?.status === 'confirmed' ? '已确认' : p.toolCheck?.status === 'not_confirmed' ? '检测未确认' : '未知'}</Badge></div>
              {p.toolCheck?.reason && <p className="text-sm text-muted-foreground">{p.toolCheck.reason}</p>}
              <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">{[['API Key', p.apiKeyMasked || '—'], ['模型', p.model], ['输入价格 / 1M tokens', `$${p.priceIn ?? '?'}`], ['输出价格 / 1M tokens', `$${p.priceOut ?? '?'}`]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all font-mono">{value}</dd></div>)}</dl>
            {diagnostic && (
              <Notice ok={diagnostic.issues.length === 0}>配置：{diagnostic.configured.baseUrl && diagnostic.configured.apiKey && diagnostic.configured.defaultModel ? '完整' : '不完整'} · 模型 {diagnostic.models.length} 个 · {diagnostic.issues.length ? diagnostic.issues.join('；') : '未发现问题'}</Notice>
            )}
            </CardContent><CardFooter className="flex-wrap gap-2"><Button variant="outline" size="sm" disabled={tr?.pending} onClick={() => void runTest(p)}>{tr?.pending && <Spinner data-icon="inline-start" />}验证密钥</Button><Button variant="outline" size="sm" disabled={checkingId === p.id} onClick={() => void checkTools(p)}>{checkingId === p.id && <Spinner data-icon="inline-start" />}检测工具调用（一次模型请求）</Button><Button variant="ghost" size="sm" onClick={() => void runDiagnostic(p)}>诊断</Button>{tr && !tr.pending && <Badge variant={tr.ok ? 'secondary' : 'destructive'}>{tr.ok ? <Check /> : <X />}{tr.ms ? `${tr.ms}ms` : tr.ok ? '成功' : '失败'}</Badge>}<div className="ml-auto flex gap-2"><Button variant="outline" size="sm" onClick={() => startEdit(p)}>编辑</Button><Button variant="destructive" size="icon-sm" aria-label={`删除 Provider ${p.label}`} onClick={() => void remove(p)}><Trash2 /></Button></div></CardFooter>
          </Card>
        );
      })}
      {providers.length === 0 && !creating && <Empty><EmptyHeader><EmptyTitle>尚未配置 Provider</EmptyTitle><EmptyDescription>添加模型提供商后即可开始对话。</EmptyDescription></EmptyHeader><Button variant="outline" onClick={startCreate}><Plus data-icon="inline-start" />新增 Provider</Button></Empty>}
      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>请确认</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">{confirm?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { confirm?.onOk(); setConfirm(null); }}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ContextSection() {
  const [stats, setStats] = useState<StatsInfo | null>(null);
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [savedTip, setSavedTip] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const loadStats = async () => { try { const s = await statsApi.get(); if (alive) setStats(s); } catch { /* 忽略 */ } };
    const loadCfg = async () => { try { const c = await configApi.get(); if (alive) { setCfg(c); setError(null); } } catch (err) { if (alive) setError(err instanceof Error ? err.message : String(err)); } };
    void loadStats(); void loadCfg();
    const t = setInterval(loadStats, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const patch = async (p: Parameters<typeof configApi.patch>[0], tip: string) => {
    if (saving) return;
    setSaving(true);
    try {
      await configApi.patch(p);
      const c = await configApi.get();
      setCfg(c);
      setSavedTip(tip);
      setTimeout(() => setSavedTip(null), 2500);
    } catch (err) {
      toast.error(`这项设置没保存上：${err instanceof Error ? err.message : String(err)}`);
    } finally { setSaving(false); }
  };

  // E3：后端各消费点的默认值统一是 60000（agent.ts / chat.ts / config.ts / stats.ts），
  // 此前这里的 30000 兜底与代码与 README 旧文案互相矛盾，三处对齐到 60000。
  const maxTokens = cfg?.context.maxTokens ?? stats?.context.maxTokens ?? 60000;
  const truncations = stats?.overview.truncations ?? 0;
  // E1：兜底优先用后端真实生效阈值（statsApi 已带出），其次 0.58（代码默认）——
  // 此前兜底 0.85 恰是缓存体系设计文档实测否决的值（中文同义改写 0.85 永不命中）。
  const l2TtlMin = cfg?.cache.l2TtlMin ?? stats?.cache.l2TtlMin ?? 30;
  const l3Enabled = cfg?.cache.l3Enabled ?? true;

  return (
    <>
      <SettingsHeading title="上下文管理" description="管理模型输入容量、历史压缩和缓存。" />
      {savedTip && <Notice>{savedTip}</Notice>}
      {error && <Notice ok={false}>{error}</Notice>}
      {!cfg && !error && <Skeleton className="h-32" />}
      <Card>
        <CardHeader><CardTitle>输入容量</CardTitle><CardDescription>控制每轮对话可使用的历史消息量。</CardDescription></CardHeader>
        <CardContent><FieldGroup>
        <Field orientation="responsive">
          <FieldContent><FieldLabel htmlFor="context-max-tokens">context.maxTokens</FieldLabel><FieldDescription>按模型窗口与输出预留计算可用容量；压缩保留明确约束，原始材料仍可检索。</FieldDescription></FieldContent>
          <Input
            id="context-max-tokens" className="@md/field-group:w-36" type="number" min={1} key={maxTokens} defaultValue={maxTokens} disabled={!cfg || saving}
            onBlur={(e) => { const v = Number(e.target.value); if (v && v !== maxTokens) void patch({ context: { maxTokens: v } }, `maxTokens → ${v}`); }}
          />
        </Field>
        <Field orientation="horizontal">
          <FieldContent><FieldLabel htmlFor="truncate-inject">截断注入说明</FieldLabel><FieldDescription>截断时注入说明，可在轨迹面板查看。</FieldDescription></FieldContent>
          <Switch
            id="truncate-inject" disabled={!cfg || saving}
            checked={cfg?.context.truncateInject ?? true}
            onCheckedChange={() => void patch({ context: { truncateInject: !(cfg?.context.truncateInject ?? true) } }, '截断注入已切换')}
            aria-label="截断注入说明"
          />
        </Field>
        <Field orientation="horizontal"><FieldContent><FieldTitle>累计截断次数</FieldTitle><FieldDescription>所有会话因超限被截断的总次数。</FieldDescription></FieldContent><Badge variant="secondary">{truncations}</Badge></Field>
      </FieldGroup></CardContent></Card>
      <Card><CardHeader><CardTitle>三层缓存</CardTitle><CardDescription>工具缓存保留状态范围；Provider 可复用稳定前缀。</CardDescription></CardHeader><CardContent><FieldGroup>
        <Field orientation="horizontal"><FieldContent><FieldTitle>L1 · 相似答案缓存</FieldTitle><FieldDescription>默认关闭。每次任务均交由当前模型处理。</FieldDescription></FieldContent><Badge variant="outline">{cfg?.cache.l1Enabled ? '已显式开启' : '关闭'}</Badge></Field>
        <Field orientation="responsive">
          <FieldContent><FieldLabel htmlFor="l2-ttl">L2 · 工具结果 TTL</FieldLabel><FieldDescription>缓存有效期（分钟），文件变更立即失效。</FieldDescription></FieldContent>
          <Input
            id="l2-ttl" className="@md/field-group:w-36" type="number" min={1} key={l2TtlMin} defaultValue={l2TtlMin} disabled={!cfg || saving}
            onBlur={(e) => {
              const m = Number(e.target.value.replace(/[^\d.]/g, ''));
              if (m && m !== l2TtlMin) void patch({ cache: { l2TtlMin: m } }, `L2 TTL → ${m} min`);
            }}
          />
        </Field>
        <Field orientation="horizontal">
          <FieldContent><FieldLabel htmlFor="l3-enabled">L3 · prompt 前缀复用</FieldLabel><FieldDescription>复用稳定前缀，由 Provider 报告命中；临时上下文按当前任务重新组装。</FieldDescription></FieldContent>
          <Switch
            id="l3-enabled" disabled={!cfg || saving}
            checked={l3Enabled}
            onCheckedChange={() => void patch({ cache: { l3Enabled: !l3Enabled } }, 'L3 已切换')}
            aria-label="L3 prompt 前缀复用"
          />
        </Field>
      </FieldGroup></CardContent></Card>
    </>
  );
}

function RoutingSection({ providers }: { providers: ProviderInfo[] }) {
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void configApi.get().then(setCfg).catch(error => toast.error(String(error))); }, []);
  const selected = cfg?.agent.fallbackProviders ?? [];
  const save = async (ids: string[]) => {
    if (!cfg) return;
    setBusy(true);
    try { await configApi.patch({ agent: { fallbackProviders: ids } }); setCfg(await configApi.get()); }
    catch (error) { toast.error(String(error)); }
    finally { setBusy(false); }
  };
  const ids = [...new Set([...providers.filter(provider => provider.enabled).map(provider => provider.id), ...selected])];
  return <>
    <SettingsHeading title="备用线路" description="任务使用当前所选模型；只有明确列出的备用 Provider 才能在主线路不可用时接替。" />
    <Card><CardHeader><CardTitle>调用顺序</CardTitle><CardDescription>按开启顺序尝试备用线路。关闭后重新开启可调整顺序；备用线路使用各自的默认模型，费用计入当前任务。</CardDescription></CardHeader><CardContent><FieldGroup>
      {!ids.length && <p className="text-sm text-muted-foreground">配置 Provider 后可在此选择备用线路。</p>}
      {ids.map(id => <Field orientation="horizontal" key={id}><FieldContent><FieldLabel htmlFor={`fallback-${id}`}>{providers.find(provider => provider.id === id)?.label ?? id}</FieldLabel><FieldDescription>{selected.includes(id) ? `备用顺序 ${selected.indexOf(id) + 1}` : '未启用备用'}</FieldDescription></FieldContent><Switch id={`fallback-${id}`} checked={selected.includes(id)} disabled={!cfg || busy || !providers.find(provider => provider.id === id)?.enabled && !selected.includes(id)} onCheckedChange={checked => void save(checked ? [...selected, id] : selected.filter(value => value !== id))} /></Field>)}
    </FieldGroup></CardContent></Card>
  </>;
}

function RulesSection() {
  const [view, setView] = useState<RulesView | null>(null);
  const [scope, setScope] = useState<'global' | 'project'>('project');
  const [file, setFile] = useState('AGENTS.md');
  const [draft, setDraft] = useState('');
  const [tip, setTip] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [policyDraft, setPolicyDraft] = useState<RulesView['policy'] | null>(null);
  const [policyPreview, setPolicyPreview] = useState<PolicyDryRunView | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);

  const load = async () => {
    try { setView(await rulesApi.get()); } catch (e) { toast.error(`规则没读到：${e instanceof Error ? e.message : String(e)}`); }
  };
  useEffect(() => {
    let alive = true;
    void rulesApi.get().then((next) => { if (alive) { setView(next); setDraft(next.projectFiles.find((item) => item.name === 'AGENTS.md' || item.name.endsWith('/AGENTS.md'))?.content ?? ''); } }).catch((error) => toast.error(String(error)));
    return () => { alive = false; };
  }, []);

  const options = scope === 'global'
    ? (view?.globalFiles ?? []).map(f => f.name)
    : ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.maharness/rules/'];
  const pickFile = (name: string, nextScope = scope) => {
    setFile(name);
    if (nextScope === 'global') setDraft(view?.globalFiles.find(f => f.name === name)?.content ?? '');
    else setDraft(view?.projectFiles.find(f => f.name.endsWith(name) || f.name === name)?.content ?? '');
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (scope === 'global') {
        const name = file.endsWith('.md') ? file : `${file}.md`;
        const revision = view?.ruleFileRevisions.global[name] ?? view?.globalFiles.find(f => f.name === name)?.revision;
        if (!revision) throw new Error('缺少规则文件版本，请刷新后重试');
        await rulesApi.putGlobal(name, draft, revision);
      } else {
        const revision = view?.ruleFileRevisions.project[file];
        if (!revision) throw new Error('缺少规则文件版本，请刷新后重试');
        await rulesApi.putProject(file, draft, revision);
      }
      await load();
      setTip('规则已写入并在下一轮对话生效');
      setTimeout(() => setTip(null), 3000);
    } catch (e) { toast.error(`规则没保存上：${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };

  const togglePolicy = async (idx: number, patch: Record<string, unknown>) => {
    if (!view) return;
    const next = (policyDraft ?? view.policy).map((r, i) => (i === idx ? { ...r, ...patch } : r));
    setPolicyDraft(next as RulesView['policy']);
    setPolicyPreview(null);
  };

  const addPolicy = async () => {
    if (!view) return;
    const next = [...(policyDraft ?? view.policy), { id: `rule-${Date.now().toString(36)}`, effect: 'allow', tool: 'powershell_execute', argPattern: 'npm run test', reason: '测试命令免审批', enabled: true }];
    setPolicyDraft(next as RulesView['policy']);
    setPolicyPreview(null);
  };

  const removePolicy = async (idx: number) => {
    if (!view) return;
    const next = (policyDraft ?? view.policy).filter((_, i) => i !== idx);
    setPolicyDraft(next as RulesView['policy']);
    setPolicyPreview(null);
  };

  const previewPolicy = async () => {
    if (!view || policyBusy) return;
    setPolicyBusy(true);
    try {
      const next = await rulesApi.dryRun(scope, policyDraft ?? view.policy);
      setPolicyPreview(next);
    } catch (e) { toast.error(`策略演练失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setPolicyBusy(false); }
  };

  const savePolicy = async () => {
    if (!view || !policyDraft || policyBusy) return;
    setPolicyBusy(true);
    try {
      const r = await rulesApi.putPolicy(scope, policyDraft, view.policyRevisions[scope]);
      if (!r.ok) { toast.error(r.error ?? '策略没保存上'); return; }
      await load();
      setPolicyDraft(null);
      setPolicyPreview(null);
      toast.success('策略已保存');
    } catch (e) { toast.error(`策略没保存上：${e instanceof Error ? e.message : String(e)}`); }
    finally { setPolicyBusy(false); }
  };

  if (!view) return <div className="flex flex-col gap-4" aria-label="读取规则中" aria-busy="true"><Skeleton className="h-8 w-40" /><Skeleton className="h-64" /></div>;
  const policy = policyDraft ?? view.policy;

  return (
    <>
      <SettingsHeading title="用户规则" description="规则文件随工作区自动重读，可使用 Git 管理版本。" />
      {tip && <Notice>{tip}</Notice>}
      {view.errors.length > 0 && <Notice ok={false}>策略文件问题：{view.errors.join('；')}</Notice>}

      <Card>
        <CardHeader><CardTitle>提示规则</CardTitle><CardDescription>当前注入 {view.promptChars} 字符 · 全局 data/rules/ 与项目规则文件共同生效。</CardDescription></CardHeader>
        <CardContent><FieldGroup>
        <Field orientation="responsive">
          <FieldContent><FieldTitle id="rules-scope-label">作用域</FieldTitle><FieldDescription>选择要编辑的规则来源。</FieldDescription></FieldContent>
          <ToggleGroup type="single" variant="outline" value={scope} aria-labelledby="rules-scope-label" disabled={busy} onValueChange={(next) => { if (next !== 'project' && next !== 'global') return; setScope(next); setPolicyDraft(null); setPolicyPreview(null); pickFile(next === 'global' ? view.globalFiles[0]?.name ?? 'maharness.md' : 'AGENTS.md', next); }}>
            <ToggleGroupItem value="project">项目</ToggleGroupItem><ToggleGroupItem value="global">全局</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="rule-file">规则文件</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={file || '__none__'}
            disabled={busy}
            onValueChange={(value) => {
              if (value !== '__none__') pickFile(value);
            }}
          >
            <SelectTrigger id="rule-file" className="min-w-0 flex-1" aria-label="规则文件">
              <SelectValue placeholder="（暂无文件）" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {options.length === 0 && <SelectItem value="__none__">（暂无文件）</SelectItem>}
                {options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                {!options.includes(file) && file && <SelectItem value={file}>{file}</SelectItem>}
              </SelectGroup>
            </SelectContent>
          </Select>
          {scope === 'global' && (
            <Button variant="outline" disabled={busy} onClick={() => { setFile('new-rule.md'); setDraft(''); }}><Plus data-icon="inline-start" />新建 .md</Button>
          )}
        </div>
        </Field>
        <Field><FieldLabel htmlFor="rule-body">规则正文</FieldLabel>
        <Textarea
          id="rule-body" className="min-h-64 font-mono" rows={12} value={draft} disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={'写自然语言即可，例如：\n- 提交信息用中文，遵循 feat/fix/chore 前缀\n- 改完代码必须跑 npm run typecheck\n- 不要动 src/legacy/ 下的文件'}
          aria-label="规则正文"
        />
        </Field></FieldGroup></CardContent>
        <CardFooter><Button onClick={() => void save()} disabled={busy}>{busy && <Spinner data-icon="inline-start" />}保存规则</Button></CardFooter>
      </Card>

      <Card>
        <CardHeader><CardTitle>策略规则</CardTitle><CardDescription>allow 免审批，deny 拒绝。写入{scope === 'project' ? '项目 .maharness/rules.json' : '全局 data/rules.json'}。</CardDescription></CardHeader>
        <CardContent><FieldGroup>
        {policy.length === 0 && <Empty><EmptyHeader><EmptyTitle>暂无策略规则</EmptyTitle><EmptyDescription>按内置白名单判定，只读命令免审批。</EmptyDescription></EmptyHeader></Empty>}
        {policy.map((r, i) => (
          <Field orientation="responsive" key={r.id ?? i}>
            <FieldContent className="min-w-0 break-all"><FieldTitle>{r.tool}</FieldTitle><FieldDescription>{r.argPattern ? `/${r.argPattern}/ · ` : ''}{r.reason || '无说明'}</FieldDescription></FieldContent>
            <div className="flex items-center gap-3">
              <Select value={r.effect} onValueChange={(value) => void togglePolicy(i, { effect: value })}>
                <SelectTrigger className="w-32" aria-label={`${r.tool} 策略效果`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="allow">allow</SelectItem>
                    <SelectItem value="deny">deny</SelectItem>
                    <SelectItem value="require-approval">需审批</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Switch checked={r.enabled !== false} aria-label="启用策略" onCheckedChange={() => void togglePolicy(i, { enabled: r.enabled === false })} />
              <Button variant="ghost" size="icon-sm" aria-label={`删除策略 ${r.tool}`} onClick={() => void removePolicy(i)}><Trash2 /></Button>
            </div>
          </Field>
        ))}
          {policyDraft ? <Notice>策略有未保存的修改。保存前可先预览变化，确认后再写入。</Notice> : null}
          {policyPreview ? (
            <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
              <div className="font-medium">
                {policyPreview.changed ? '策略判定将发生变化' : '判定结果不变'}
                {' · '}新增 {policyPreview.diff.filter((item) => item.change === 'added').length}
                {' · '}修改 {policyPreview.diff.filter((item) => item.change === 'changed').length}
                {' · '}删除 {policyPreview.diff.filter((item) => item.change === 'removed').length}
              </div>
              {policyPreview.probes.map((probe) => (
                <div key={probe.tool} className="text-muted-foreground">
                  {probe.tool}：{probe.current.decision} → {probe.candidate.decision}
                </div>
              ))}
              {policyPreview.issues.map((issue, index) => (
                <div key={`${issue.code}-${index}`} className={issue.level === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}>
                  {issue.level === 'error' ? '错误' : '提示'}：{issue.message}
                </div>
              ))}
            </div>
          ) : null}
        </FieldGroup></CardContent><CardFooter className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void addPolicy()} disabled={policyBusy}><Plus data-icon="inline-start" />添加策略（npm run test 免审批）</Button>
          <Button variant="outline" onClick={() => void previewPolicy()} disabled={policyBusy}>{policyBusy && <Spinner data-icon="inline-start" />}预览影响</Button>
          <Button onClick={() => void savePolicy()} disabled={policyBusy || !policyDraft}>{policyBusy && <Spinner data-icon="inline-start" />}保存策略</Button>
        </CardFooter>
      </Card>
    </>
  );
}

function readAutoScroll(): boolean {
  try { return localStorage.getItem('maharness-auto-scroll') !== 'off'; } catch { return true; }
}

const BRANDS: { key: Brand; label: string }[] = [
  { key: 'doodle', label: '暖砂' },
  { key: 'ink', label: '墨灰' },
  { key: 'moss', label: '苔绿' },
];

function GeneralSection({ theme, onThemeChange, brand, onBrandChange }: { theme: Theme; onThemeChange: (t: Theme) => void; brand: Brand; onBrandChange: (b: Brand) => void }) {
  const [autoScroll, setAutoScroll] = useState(readAutoScroll);
  return (
    <>
      <SettingsHeading title="通用" description="外观与对话偏好。" />
      <Card><CardHeader><CardTitle>外观</CardTitle><CardDescription>明暗主题与品牌强调色独立组合。</CardDescription></CardHeader><CardContent><FieldGroup>
        <Field orientation="horizontal">
          <FieldContent><FieldLabel htmlFor="dark-theme">深色主题</FieldLabel><FieldDescription>{theme === 'dark' ? '当前使用深色外观。' : '当前使用浅色外观。'}</FieldDescription></FieldContent>
          <Switch
            id="dark-theme"
            checked={theme === 'dark'}
            onCheckedChange={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
            aria-label="切换深色主题"
          />
        </Field>
        <Field orientation="responsive">
          <FieldContent><FieldTitle id="brand-label">品牌色板</FieldTitle><FieldDescription>暖砂、墨灰与苔绿。</FieldDescription></FieldContent>
          <ToggleGroup type="single" variant="outline" aria-labelledby="brand-label" value={brand} onValueChange={(next) => { if (next === 'doodle' || next === 'ink' || next === 'moss') onBrandChange(next); }}>
            {BRANDS.map((b) => (
              <ToggleGroupItem key={b.key} value={b.key} aria-label={b.label}>{b.label}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      </FieldGroup></CardContent></Card>
      <Card><CardHeader><CardTitle>对话</CardTitle><CardDescription>消息输出与阅读偏好。</CardDescription></CardHeader><CardContent><FieldGroup>
        <Field orientation="horizontal"><FieldContent><FieldTitle>流式输出</FieldTitle><FieldDescription>SSE 逐字呈现回复，由服务端控制。</FieldDescription></FieldContent><Badge variant="secondary">已开启</Badge></Field>
        <Field orientation="horizontal">
          <FieldContent><FieldLabel htmlFor="auto-scroll">自动滚动</FieldLabel><FieldDescription>新消息自动跟随，阅读历史时暂停。</FieldDescription></FieldContent>
          <Switch
            id="auto-scroll"
            checked={autoScroll}
            aria-label="自动滚动"
            onCheckedChange={() => {
              const next = !autoScroll;
              setAutoScroll(next);
              try { localStorage.setItem('maharness-auto-scroll', next ? 'on' : 'off'); } catch { /* 忽略 */ }
            }}
          />
        </Field>
      </FieldGroup></CardContent></Card>
    </>
  );
}

/**
 * 安全姿态（A6/A7 的前端侧）：把「哪些门开着、主密钥是否可用、审批门是否被策略整体放行」
 * 如实摆在界面上——这些状态此前只存在于服务端日志与 401 的报错里，用户看不见。
 *
 * 变更凭据为什么由人录入、不让服务端下发：本服务只监听 127.0.0.1，浏览器相对其它本机
 * 进程没有任何额外特权，页面能读到的通道本机进程都读得到。所以 token 只能由**人**从
 * 服务端的 env 抄进来（存在本浏览器 localStorage）；服务端下发等于对攻击者公开。
 */
function SecuritySection() {
  const [posture, setPosture] = useState<SecurityPosture | null>(null);
  const [tokenDraft, setTokenDraft] = useState(() => getMutationToken());
  const [tenantDraft, setTenantDraft] = useState(() => getTenantId());
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setPosture(await securityApi.get()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const saveToken = () => {
    setMutationToken(tokenDraft);
    toast.success(tokenDraft.trim() ? '变更凭据已存入本浏览器，之后所有修改类操作都会带上它' : '已清除本机变更凭据');
    setTokenDraft(getMutationToken());
    void load();
  };

  const saveTenant = () => {
    const next = tenantDraft.trim();
    if (next && !/^[A-Za-z0-9_-]{1,64}$/.test(next)) {
      toast.error('租户 id 仅支持字母/数字/下划线/连字符，长度 1-64');
      return;
    }
    setTenantId(tenantDraft);
    toast.success(next ? `已切换到租户 ${next}` : '已恢复默认租户');
    window.location.reload();
  };

  const blanket = posture?.policy.blanketAllow ?? [];

  return (
    <Card>
      <CardHeader><CardTitle>安全</CardTitle><CardDescription>凭据、审批与密钥状态。</CardDescription></CardHeader>
      <CardContent><FieldGroup>
      {err && <Notice ok={false}>安全状态读取失败：{err}</Notice>}
      {!posture && !err && <Skeleton className="h-32" />}

      {posture && (
        <>
          <Field orientation="responsive"><FieldContent><FieldTitle>监听地址</FieldTitle><FieldDescription>服务地址及 Host/Origin 访问校验。</FieldDescription></FieldContent><Badge variant="outline">{posture.bind}</Badge></Field>

          <Field>
            <FieldContent>
              <FieldTitle>当前租户</FieldTitle>
              <FieldDescription>
                每次 API 请求携带 <code>x-maharness-tenant</code>；留空使用服务端默认租户。切换后页面会重载。
              </FieldDescription>
            </FieldContent>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">当前 {getTenantId() || 'default'}</Badge>
              <Input
                className="min-w-40 flex-1"
                aria-label="当前租户"
                placeholder="default"
                value={tenantDraft}
                onChange={(event) => setTenantDraft(event.target.value)}
              />
              <Button variant="outline" onClick={saveTenant}>切换</Button>
            </div>
          </Field>

          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>变更类操作显式授权</FieldTitle>
              <FieldDescription>
                服务端 {posture.mutationAuthRequired ? '已要求' : '未要求'} <code>{posture.mutationTokenHeader}</code> 头
                （挡无意图的本机进程一次调用就批准危险命令 / 切沙箱根 / 注入 allow 策略；
                不是进程隔离边界——同用户身份的代码本就能改 data/ 下的文件）
              </FieldDescription>
            </FieldContent>
            <Badge variant={posture.mutationAuthRequired ? 'secondary' : 'outline'}>
              {posture.mutationAuthRequired ? '已启用' : '未启用'}
            </Badge>
          </Field>

          {posture.mutationAuthRequired && (
            <Field>
              <FieldContent>
                <FieldLabel htmlFor="mutation-token">录入变更凭据</FieldLabel>
                <FieldDescription>
                  填服务端 <code>MAHARNESS_API_TOKEN</code> 的值（只存这台浏览器，不从服务端取——
                  服务端下发等于对本机所有进程公开）。留空并保存 = 本机不再自动带凭据。
                </FieldDescription>
              </FieldContent>
              <div className="flex gap-2">
                <Input
                  id="mutation-token" className="min-w-0 flex-1" type="password" autoComplete="off"
                  aria-label="变更凭据" placeholder="与服务端 env 一致"
                  value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)}
                />
                <Button variant="outline" onClick={saveToken}>保存</Button>
              </div>
            </Field>
          )}

          <Field orientation="responsive">
            <FieldContent><FieldTitle>审批一次性凭据</FieldTitle><FieldDescription>凭据随审批卡下发并自动回带，单次有效。</FieldDescription></FieldContent>
            <Badge variant={posture.approvalTokenRequired ? 'secondary' : 'outline'}>
              {posture.approvalTokenRequired ? '强制' : '已下发但未强制'}
            </Badge>
          </Field>

          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>主密钥</FieldTitle>
              <FieldDescription className="break-all">
                {posture.masterKey.message || posture.masterKey.state}
                {posture.masterKey.backupPath ? `（原文件已备份为 ${posture.masterKey.backupPath}）` : ''}
              </FieldDescription>
            </FieldContent>
            <Badge variant={posture.masterKey.available ? 'secondary' : 'destructive'}>
              {posture.masterKey.available ? '可用' : '异常'}
            </Badge>
          </Field>

          {posture.credentials.broken.length > 0 && (
            <Alert variant="destructive"><ShieldAlert />
                <AlertTitle>密钥不可解的供应商 · {posture.credentials.broken.length} 个</AlertTitle>
                <AlertDescription>
                  {posture.credentials.broken.map((b) => `${b.label || b.id}（${b.reason === 'no-master-key' ? '没有主密钥' : '密文损坏或密钥已换'}）`).join('、')}
                  —— 请在「模型与 Provider」里重新录入 Key；这不是你按错了什么
                </AlertDescription>
            </Alert>
          )}

          {blanket.length > 0 && (
            <Alert variant="destructive"><ShieldAlert />
                <AlertTitle>审批门已被整体放行</AlertTitle>
                <AlertDescription>
                  策略里有对全部工具放行的 allow 规则（{blanket.map((b) => `${b.tool} ← ${b.file}`).join('、')}）。
                  这意味着高危调用不再逐个询问你——如果不是你本意，请到「用户规则」删掉它。
                </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </FieldGroup></CardContent></Card>
  );
}

export default function SettingsView({ providers, onChanged, theme, onThemeChange, brand, onBrandChange, onStartTask, onOpenPlugins, onOpenRuns, onOpenStats, pluginNav = [], onOpenPluginNav }: Props) {
  const [tab, setTab] = useState<SettingTab>('general');
  const mobile = useIsMobile();
  const navs: { key: SettingTab; label: string; badge?: string }[] = [
    { key: 'general', label: '通用' },
    { key: 'providers', label: '模型与 Provider' },
    { key: 'context', label: '上下文管理' },
    { key: 'routing', label: '备用线路' },
    { key: 'personas', label: '人设与提示词' },
    { key: 'rules', label: '用户规则' },
    { key: 'skills', label: '技能系统' },
    { key: 'advanced', label: '高级' },
  ];

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as SettingTab)}
      orientation={mobile ? 'horizontal' : 'vertical'}
      className="min-h-0 min-w-0 flex-1 gap-0"
    >
      <nav aria-label="设置分类" className="shrink-0 overflow-x-auto border-b p-3 md:w-44 md:overflow-y-auto md:border-r md:border-b-0">
        <TabsList aria-label="设置分类" className="md:w-full">
          {navs.map((nav) => (
            <TabsTrigger
              key={nav.key}
              value={nav.key}
              className="md:min-h-9"
            >
              <span>{nav.label}</span>
              {nav.badge && <Badge variant="secondary">{nav.badge}</Badge>}
            </TabsTrigger>
          ))}
        </TabsList>
      </nav>
      <ScrollArea className="min-h-0 min-w-0 flex-1"><div className="mx-auto w-full max-w-4xl p-4 md:p-6">
        <TabsContent value="general" className="flex flex-col gap-3">
          <GettingStarted providers={providers} onModels={() => setTab('providers')} onChanged={onChanged} onStart={onStartTask} />
          <DocumentSettings />
          <GeneralSection theme={theme} onThemeChange={onThemeChange} brand={brand} onBrandChange={onBrandChange} />
        </TabsContent>
        <TabsContent value="providers" className="flex flex-col gap-3">
          <ProvidersSection providers={providers} onChanged={onChanged} />
        </TabsContent>
        <TabsContent value="context" className="flex flex-col gap-3">
          <ContextSection />
        </TabsContent>
        <TabsContent value="routing" className="flex flex-col gap-3">
          <RoutingSection providers={providers} />
        </TabsContent>
        <TabsContent value="personas" className="flex flex-col gap-3">
          <PersonaPanel />
        </TabsContent>
        <TabsContent value="rules" className="flex flex-col gap-3">
          <RulesSection />
        </TabsContent>
        <TabsContent value="skills" className="flex flex-col gap-3">
          <SkillsView />
        </TabsContent>
        <TabsContent value="advanced" className="flex flex-col gap-3">
          <>
            <SettingsHeading title="高级" description="审计日志、本地存储与安全。" />
            <Card><CardHeader><CardTitle>扩展与诊断</CardTitle><CardDescription>插件页面、运行记录和成本统计保留在高级入口。</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Button variant="outline" onClick={onOpenPlugins}>插件管理</Button>{pluginNav.filter(item => item.pluginId !== 'workbench').map(item => <Button key={item.key} variant="outline" onClick={() => onOpenPluginNav?.(item.key)}>{item.pluginName} · {item.label}</Button>)}<Button variant="outline" onClick={onOpenRuns}>运行记录</Button><Button variant="outline" onClick={onOpenStats}>缓存与成本</Button></CardContent></Card>
            <Card><CardHeader><CardTitle>审计与存储</CardTitle><CardDescription>打开本地数据、配置及工作区。</CardDescription></CardHeader><CardContent><FieldGroup>
              {[['traces', 'JSONL 审计日志', 'data/traces'], ['db', '数据存储', 'data/agent.db'], ['sandbox', '沙箱根目录', '文件工具与文件 API 的可访问范围'], ['config', '用户配置', 'config.json']].map(([kind, label, description]) => <Field key={kind} orientation="horizontal"><FieldContent><FieldTitle>{label}</FieldTitle><FieldDescription>{description}</FieldDescription></FieldContent><Button variant="outline" size="sm" aria-label={`打开${label}`} onClick={() => { void metaApi.open(kind).catch((error) => toast.error(String(error))); }}>打开</Button></Field>)}
            </FieldGroup></CardContent></Card>
            <WorkspacePermissions />
            <SecuritySection />
          </>
        </TabsContent>
      </div></ScrollArea>
    </Tabs>
  );
}
