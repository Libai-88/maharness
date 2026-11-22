// ui/src/components/SettingsProviders.tsx —— 设置面板 Provider 区块（从 SettingsView 拆出）
import { useState } from 'react';
import { providersApi } from '../api';
import type { ProviderDiagnostic, ProviderForm, ProviderInfo, PulledModel } from '../types';
import { toast } from 'sonner';
import { Check, ChevronsUpDown, Plus, Trash2, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { EMPTY, Notice, PROVIDER_PRESETS, SettingsHeading } from './settings-common';

export default function ProvidersSection({ providers, onChanged }: { providers: ProviderInfo[]; onChanged: () => void }) {
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
    try {
      const result = await providersApi.checkTools(p.id);
      if (result.status === 'confirmed') toast.success('已确认原生工具调用能力');
      else toast.error(result.reason ?? '本次检测未确认工具调用能力');
      onChanged();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setCheckingId(null);
    }
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
    if (ok) {
      setCreating(false);
      setEditing(null);
      onChanged();
    }
  };

  const startCreate = () => {
    setCreating(true);
    setEditing(null);
    setForm(EMPTY);
    setMsg(null);
    setModels([]);
  };
  const startEdit = (p: ProviderInfo) => {
    setEditing(p);
    setCreating(false);
    setMsg(null);
    setModels([]);
    setForm({
      label: p.label,
      baseUrl: p.baseUrl,
      apiKey: '',
      model: p.model,
      protocol: p.protocol ?? 'openai',
      priceIn: p.priceIn ? String(p.priceIn) : '',
      priceOut: p.priceOut ? String(p.priceOut) : '',
    });
  };

  const save = async () => {
    if (!form.label.trim() || !form.baseUrl.trim() || !form.model.trim() || (!isLocal && creating && !form.apiKey.trim())) {
      return refresh(false, isLocal ? '名称 / 地址 / 模型必填（本地网关无需 Key）' : '名称 / 地址 / 模型必填，新建时 Key 必填');
    }
    setBusy('save');
    let savedId: string | null = null;
    try {
      if (creating) {
        const p = await providersApi.create(form);
        savedId = p.id;
        await refresh(true, '已添加');
      } else if (editing) {
        await providersApi.update(editing.id, { ...form, expectedUpdatedAt: editing.updatedAt });
        savedId = editing.id;
        await refresh(true, '已保存');
      } else {
        return;
      }
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
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        model: form.model.trim(),
        protocol: form.protocol,
        ...(editing ? { providerId: editing.id } : {}),
      });
      if (r.ok) await refresh(true, r.message ?? `连接成功（${r.latencyMs ?? 0}ms）`);
      else await refresh(false, r.error ?? '连接失败');
    } catch (err) {
      await refresh(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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
        const pick = list.find((m) => m.id === f.model.trim()) ?? list[0];
        if (!pick) return f;
        return {
          ...f,
          model: pick.id,
          priceIn: f.priceIn?.trim() ? f.priceIn : String(pick.priceIn ?? ''),
          priceOut: f.priceOut?.trim() ? f.priceOut : String(pick.priceOut ?? ''),
        };
      });
      const vision = list.filter((m) => m.vision).length;
      setMsg({ ok: true, text: `已拉取 ${list.length} 个模型（其中 ${vision} 个支持视觉）——选择模型即自动带入能力与价格` });
      setTimeout(() => setMsg(null), 6000);
    } catch (err) {
      await refresh(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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
    } finally {
      setTogglingId(null);
    }
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
      <SettingsHeading title="模型与 Provider" description="管理模型、连接凭据与调用价格。">
        <Button onClick={startCreate}>
          <Plus data-icon="inline-start" />
          新增 Provider
        </Button>
      </SettingsHeading>
      {msg && <Notice ok={msg.ok}>{msg.text}</Notice>}

      {(creating || editing) && (
        <Card>
          <CardHeader>
            <CardTitle>{creating ? '新增 Provider' : `编辑 · ${editing!.label}`}</CardTitle>
            <CardDescription>保存后即可在对话中切换模型。</CardDescription>
          </CardHeader>
          <CardContent>
            {creating && (
              <div className="mb-4 flex flex-wrap gap-2">
                {PROVIDER_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setForm({ ...EMPTY, ...preset, apiKey: form.apiKey })}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            )}
            <FieldGroup className="grid grid-cols-1 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="provider-label">Provider 名称</FieldLabel>
                <Input
                  id="provider-label"
                  placeholder="如 DeepSeek"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="provider-base">Base URL</FieldLabel>
                <Input
                  id="provider-base"
                  placeholder={isLocal ? 'http://localhost:11434/v1' : 'https://api.deepseek.com'}
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="provider-key">API Key</FieldLabel>
                <Input
                  id="provider-key"
                  placeholder={isLocal ? '本地网关可留空' : editing ? '留空保留已保存的密钥' : '输入 API Key'}
                  type="password"
                  autoComplete="off"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="provider-protocol">协议类型</FieldLabel>
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
                </Select>
              </Field>
              <Field className="md:col-span-2">
                <FieldLabel htmlFor="provider-model">模型名</FieldLabel>
                <Input
                  id="provider-model"
                  placeholder="输入模型 ID，或拉取后选择"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="provider-price-in">输入价格（USD / 1M tokens）</FieldLabel>
                <Input
                  id="provider-price-in"
                  inputMode="decimal"
                  value={form.priceIn ?? ''}
                  onChange={(e) => setForm({ ...form, priceIn: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="provider-price-out">输出价格（USD / 1M tokens）</FieldLabel>
                <Input
                  id="provider-price-out"
                  inputMode="decimal"
                  value={form.priceOut ?? ''}
                  onChange={(e) => setForm({ ...form, priceOut: e.target.value })}
                />
              </Field>
            </FieldGroup>
            {msg && !msg.ok && (
              <p className="mt-4 text-sm text-muted-foreground">
                检查 Base URL 与 API Key，再点击“测试连接”。失败时可用“拉取模型列表”确认服务端返回的模型 ID。凭据只保存在本机配置中。
              </p>
            )}
            {models.length > 0 && (
              <Popover open={modelOpen} onOpenChange={setModelOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="mt-4 w-full justify-between"
                    role="combobox"
                    aria-label={`选择已拉取的模型（${models.length}）`}
                    aria-expanded={modelOpen}
                  >
                    选择已拉取的模型（{models.length}）<ChevronsUpDown data-icon="inline-end" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start" aria-label="选择已拉取的模型">
                  <Command>
                    <CommandInput placeholder="搜索模型…" aria-label="搜索已拉取的模型" />
                    <CommandList>
                      <CommandEmpty>无匹配模型</CommandEmpty>
                      <CommandGroup heading="可用模型">
                        {models.map((m) => (
                          <CommandItem
                            key={m.id}
                            value={m.id}
                            onSelect={() => {
                              setForm({
                                ...form,
                                model: m.id,
                                priceIn: form.priceIn?.trim() ? form.priceIn : String(m.priceIn ?? ''),
                                priceOut: form.priceOut?.trim() ? form.priceOut : String(m.priceOut ?? ''),
                              });
                              setModelOpen(false);
                            }}
                            title={`上下文 ${m.contextWindow} · 最大输出 ${m.maxOutput} · $${m.priceIn}/$${m.priceOut} per 1M`}
                          >
                            <span className="min-w-0 flex-1 truncate">{m.id}</span>
                            {m.vision && <Badge variant="secondary">视觉</Badge>}
                            {m.tools && <Badge variant="secondary">工具</Badge>}
                            {m.reasoning && <Badge variant="secondary">推理</Badge>}
                            {form.model === m.id && <Check />}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
            {isLocal && (
              <p className="mt-4 text-sm text-muted-foreground">
                本地网关提示：本机模式直接连接即可；Key 留空，地址填 http://localhost:11434/v1（Ollama 默认端口）。
              </p>
            )}
          </CardContent>
          <CardFooter className="flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={busy !== null}>
              {busy === 'save' && <Spinner data-icon="inline-start" />}保存
            </Button>
            <Button variant="outline" onClick={() => void pullModels()} disabled={busy !== null}>
              {busy === 'pull' && <Spinner data-icon="inline-start" />}拉取模型列表
            </Button>
            <Button variant="outline" onClick={() => void test()} disabled={busy !== null}>
              {busy === 'test' && <Spinner data-icon="inline-start" />}测试连接
            </Button>
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              取消
            </Button>
          </CardFooter>
        </Card>
      )}

      {providers.map((p) => {
        const connected = p.enabled && (p.hasKey || p.protocol === 'ollama');
        const tr = testResult[p.id];
        const diagnostic = diagnostics[p.id];
        return (
          <Card key={p.id}>
            <CardHeader>
              <CardTitle>{p.label}</CardTitle>
              <CardDescription className="break-all">{p.baseUrl}</CardDescription>
              <CardAction>
                <div className="flex items-center gap-3">
                  {p.health?.authFailed && (
                    <Badge variant="destructive" title={p.health.lastError}>
                      密钥失效
                    </Badge>
                  )}
                  <Switch
                    checked={p.enabled}
                    aria-label={`${p.enabled ? '停用' : '启用'} Provider ${p.label}`}
                    disabled={togglingId === p.id}
                    onCheckedChange={() => void toggle(p)}
                    title={p.enabled ? '停用' : '启用'}
                  />
                </div>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant={connected ? 'secondary' : 'outline'}>
                  {connected ? (providers[0]?.id === p.id ? '已配置 · 默认' : '已配置') : !p.enabled ? '已停用' : '未配置密钥'}
                </Badge>
                <Badge variant="outline">{p.protocol ?? 'openai'}</Badge>
                {(p.models?.length ?? 0) > 0 && <Badge variant="outline">{p.models!.length} 模型</Badge>}
                {(p.models ?? []).some((m) => !!m.vision) && <Badge variant="outline">视觉资料</Badge>}
                <Badge variant="outline">协议支持工具调用</Badge>
                <Badge variant={p.toolCheck?.status === 'confirmed' ? 'secondary' : 'outline'}>
                  模型工具能力：
                  {p.toolCheck?.status === 'confirmed' ? '已确认' : p.toolCheck?.status === 'not_confirmed' ? '检测未确认' : '未知'}
                </Badge>
              </div>
              {p.toolCheck?.reason && <p className="text-sm text-muted-foreground">{p.toolCheck.reason}</p>}
              <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                {[
                  ['API Key', p.apiKeyMasked || '—'],
                  ['模型', p.model],
                  ['输入价格 / 1M tokens', `$${p.priceIn ?? '?'}`],
                  ['输出价格 / 1M tokens', `$${p.priceOut ?? '?'}`],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 break-all font-mono">{value}</dd>
                  </div>
                ))}
              </dl>
              {diagnostic && (
                <Notice ok={diagnostic.issues.length === 0}>
                  配置：
                  {diagnostic.configured.baseUrl && diagnostic.configured.apiKey && diagnostic.configured.defaultModel ? '完整' : '不完整'}{' '}
                  · 模型 {diagnostic.models.length} 个 · {diagnostic.issues.length ? diagnostic.issues.join('；') : '未发现问题'}
                </Notice>
              )}
            </CardContent>
            <CardFooter className="flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={tr?.pending} onClick={() => void runTest(p)}>
                {tr?.pending && <Spinner data-icon="inline-start" />}验证密钥
              </Button>
              <Button variant="outline" size="sm" disabled={checkingId === p.id} onClick={() => void checkTools(p)}>
                {checkingId === p.id && <Spinner data-icon="inline-start" />}检测工具调用（一次模型请求）
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void runDiagnostic(p)}>
                诊断
              </Button>
              {tr && !tr.pending && (
                <Badge variant={tr.ok ? 'secondary' : 'destructive'}>
                  {tr.ok ? <Check /> : <X />}
                  {tr.ms ? `${tr.ms}ms` : tr.ok ? '成功' : '失败'}
                </Badge>
              )}
              <div className="ml-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={() => startEdit(p)}>
                  编辑
                </Button>
                <Button variant="destructive" size="icon-sm" aria-label={`删除 Provider ${p.label}`} onClick={() => void remove(p)}>
                  <Trash2 />
                </Button>
              </div>
            </CardFooter>
          </Card>
        );
      })}
      {providers.length === 0 && !creating && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>尚未配置 Provider</EmptyTitle>
            <EmptyDescription>添加模型提供商后即可开始对话。</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={startCreate}>
            <Plus data-icon="inline-start" />
            新增 Provider
          </Button>
        </Empty>
      )}
      <AlertDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>请确认</AlertDialogTitle>
            <AlertDialogDescription className="leading-6">{confirm?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                confirm?.onOk();
                setConfirm(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
