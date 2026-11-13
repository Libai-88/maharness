import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { runsApi, type WorkspacePermission } from '../run-api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

export default function WorkspacePermissions() {
  const [permission, setPermission] = useState<WorkspacePermission>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void runsApi.permission().then(setPermission).catch(error => setError(String(error))); }, []);
  const change = async (profile: WorkspacePermission['profile']) => {
    if (!permission) return;
    setBusy(true);
    try { setPermission(await runsApi.setPermission(profile, permission.revision)); }
    catch (error) { toast.error(String(error)); void runsApi.permission().then(setPermission); }
    finally { setBusy(false); }
  };
  return <Card><CardHeader><CardTitle>工作区权限</CardTitle><CardDescription className="break-all">{permission?.workspace ?? error ?? '正在读取…'}</CardDescription></CardHeader><CardContent>
    <Field orientation="horizontal"><div className="flex flex-col gap-1"><FieldLabel htmlFor="developer-profile">开发者权限</FieldLabel><FieldDescription>常规权限允许工作区普通读写。开发者权限允许获授权的子代理写入项目；密钥、授权配置、发布与框架当前运行实例继续受保护。</FieldDescription></div><Switch id="developer-profile" checked={permission?.profile === 'developer'} disabled={!permission || busy} onCheckedChange={checked => checked ? setConfirm(true) : void change('standard')} /></Field>
    <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>开启此工作区的开发者权限？</AlertDialogTitle><AlertDialogDescription>新任务中的子代理可以在此工作区执行获得授权的写入。现有活动任务必须先停止。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void change('developer')}>开启开发者权限</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </CardContent></Card>;
}
