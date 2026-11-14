import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { runsApi, type WorkspacePermission } from '../run-api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Field, FieldLabel, FieldDescription, FieldGroup } from '@/components/ui/field';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

export default function WorkspacePermissions() {
  const [permission, setPermission] = useState<WorkspacePermission>();
  const [confirm, setConfirm] = useState(false);
  const [pluginConfirm, setPluginConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void runsApi.permission().then(setPermission).catch(error => setError(String(error))); }, []);
  const change = async (profile: WorkspacePermission['profile']) => {
    if (!permission) return;
    setBusy(true);
    try { const next = await runsApi.setPermission(profile, permission.revision); setPermission(current => ({ ...current, ...next })); }
    catch (error) { toast.error(String(error)); void runsApi.permission().then(setPermission); }
    finally { setBusy(false); }
  };
  const changePlugins = async (enabled: boolean, permissions = permission?.pluginDevelopment?.permissions.length ? permission.pluginDevelopment.permissions : ['workspace.read', 'workspace.write'], dependencies = permission?.pluginDevelopment?.dependencies ?? []) => {
    if (!permission) return;
    setBusy(true);
    try { const next = await runsApi.setPluginDevelopment({ enabled, permissions, dependencies }, permission.revision); setPermission(current => ({ ...current, ...next })); }
    catch (error) { toast.error(String(error)); void runsApi.permission().then(setPermission); }
    finally { setBusy(false); }
  };
  return <Card><CardHeader><CardTitle>工作区权限</CardTitle><CardDescription className="break-all">{permission?.workspace ?? error ?? '正在读取…'}</CardDescription></CardHeader><CardContent>
    <FieldGroup><Field orientation="horizontal"><div className="flex flex-col gap-1"><FieldLabel htmlFor="developer-profile">开发者权限</FieldLabel><FieldDescription>常规权限允许工作区普通读写。开发者权限允许获授权的子代理写入项目；密钥、授权配置、发布与框架当前运行实例继续受保护。</FieldDescription></div><Switch id="developer-profile" checked={permission?.profile === 'developer'} disabled={!permission || busy} onCheckedChange={checked => checked ? setConfirm(true) : void change('standard')} /></Field>
    <Field orientation="horizontal"><div className="flex flex-col gap-1"><FieldLabel htmlFor="task-plugin-development">任务插件开发</FieldLabel><FieldDescription>允许 Agent 编写、验证并运行当前任务的插件。完整类型插件运行在可信宿主中，具有生成代码执行风险；任务作用域不是操作系统安全沙箱。</FieldDescription></div><Switch id="task-plugin-development" checked={permission?.pluginDevelopment?.enabled ?? false} disabled={!permission || busy} onCheckedChange={checked => checked ? setPluginConfirm(true) : void changePlugins(false)} /></Field>
    {permission?.pluginDevelopment?.enabled && <><FieldDescription>有效工具权限：{permission.pluginDevelopment.permissions.join('、') || '无'}。外部依赖：{permission.pluginDevelopment.dependencies.join('、') || '无'}。</FieldDescription>{[['network', '网络工具'], ['process', '进程工具'], ['delegate', '委派工具']].map(([name, label]) => <Field key={name} orientation="horizontal"><FieldLabel htmlFor={`plugin-${name}`}>{label}</FieldLabel><Switch id={`plugin-${name}`} disabled={busy} checked={permission.pluginDevelopment!.permissions.includes(name)} onCheckedChange={checked => void changePlugins(true, checked ? [...permission.pluginDevelopment!.permissions, name] : permission.pluginDevelopment!.permissions.filter(item => item !== name))} /></Field>)}</>}
    {permission?.pluginDevelopment?.enabled && permission.allowedPluginDependencies?.map(name => <Field key={name} orientation="horizontal"><FieldLabel htmlFor={`dependency-${name}`}>依赖 {name}</FieldLabel><Switch id={`dependency-${name}`} disabled={busy} checked={permission.pluginDevelopment!.dependencies.includes(name)} onCheckedChange={checked => void changePlugins(true, permission.pluginDevelopment!.permissions, checked ? [...permission.pluginDevelopment!.dependencies, name] : permission.pluginDevelopment!.dependencies.filter(item => item !== name))} /></Field>)}
    </FieldGroup>
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>开启此工作区的开发者权限？</AlertDialogTitle><AlertDialogDescription>新任务中的子代理可以在此工作区执行获得授权的写入。现有活动任务必须先停止。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void change('developer')}>开启开发者权限</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={pluginConfirm} onOpenChange={setPluginConfirm}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>允许运行任务生成的插件代码？</AlertDialogTitle><AlertDialogDescription>Agent 可在任务内自主创建和启用插件。工具声明默认限工作区读写，但可信宿主中的 JavaScript 不受 OS 级隔离。插件结束后释放运行资源，已经发生的文件与外部变更仍会保留。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void changePlugins(true)}>授权任务插件开发</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </CardContent></Card>;
}
