import { useState } from 'react';
import { AlertCircle, CheckCircle2, CircleDollarSign, Network, Play, RefreshCw, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { OrganizationExceptionView, OrganizationRoleView, SocietyRoleLifeView, WorkOrderView, WorkbenchProject } from '../workbench-api';
import { workbenchApi } from '../workbench-api';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';

export function OrganizationDialog({
  project,
  workOrders,
  roleDirectory,
  proposals,
  onClose,
  onSession,
  reload,
}: {
  project: WorkbenchProject;
  workOrders: WorkOrderView[];
  roleDirectory: OrganizationRoleView[];
  proposals: Array<{
    id: string;
    workOrderId: string;
    category: string;
    title: string;
    detail: string;
    impact: string;
    status: string;
    humanDecision?: string;
  }>;
  onClose: () => void;
  onSession: (id: string) => void;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState('');
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [reassignRoles, setReassignRoles] = useState<Record<string, string>>({});
  const [roleLife, setRoleLife] = useState<Record<string, SocietyRoleLifeView>>({});
  const [roleLifeBusy, setRoleLifeBusy] = useState('');
  const orders = workOrders.filter(order => order.projectId === project.id);
  const roles = [...new Map(orders.flatMap(order => order.roles).map(role => [role.id, role])).values()];
  const exceptions = orders.flatMap(order => order.exceptions).filter(item => item.status !== 'resolved' && item.status !== 'dismissed');

  const runAction = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await action();
      await reload();
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
    }
  };

  const resolveException = (item: OrganizationExceptionView) => {
    const decision = decisions[item.id]?.trim();
    if (!decision) {
      toast.error('填写人工裁决后再处理异常');
      return;
    }
    void runAction(item.id, () => workbenchApi.resolveException(item.id, decision), '异常已处理');
  };

  const loadRoleLife = async (roleId: string) => {
    if (roleLife[roleId]) {
      setRoleLife(values => {
        const next = { ...values };
        delete next[roleId];
        return next;
      });
      return;
    }
    setRoleLifeBusy(roleId);
    try {
      const result = await workbenchApi.roleLife(roleId);
      setRoleLife(values => ({ ...values, [roleId]: result.life }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRoleLifeBusy('');
    }
  };

  const rollbackRole = (roleId: string, version: number) => {
    if (!window.confirm(`回滚 ${roleDirectory.find(item => item.id === roleId)?.name ?? roleId} 到 v${version}？当前版本会保留在审计记录中。`)) return;
    void runAction(`role:rollback:${roleId}`, async () => {
      const result = await workbenchApi.rollbackRole(roleId, version, '人类在组织视图回滚角色治理配置');
      const life = await workbenchApi.roleLife(roleId);
      setRoleLife(values => ({ ...values, [roleId]: life.life }));
      return result;
    }, '角色已回滚并生成新版本');
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent
        className="flex h-[90dvh] max-w-5xl flex-col sm:max-w-5xl"
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <DialogHeader>
          <DialogTitle>{project.name} · 组织视图</DialogTitle>
          <DialogDescription>结果、费用和来源优先；角色履历、分工契约、账本与缓存诊断按需展开。</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 pb-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Card size="sm"><CardHeader><CardDescription>成员</CardDescription><CardTitle>{roles.length}</CardTitle></CardHeader></Card>
              <Card size="sm"><CardHeader><CardDescription>分工契约</CardDescription><CardTitle>{orders.reduce((sum, order) => sum + order.contracts.length, 0)}</CardTitle></CardHeader></Card>
              <Card size="sm"><CardHeader><CardDescription>待处理异常</CardDescription><CardTitle>{exceptions.length}</CardTitle></CardHeader></Card>
            </div>

            {!orders.length && (
              <Card>
                <CardHeader><CardTitle>还没有组织记录</CardTitle><CardDescription>从该项目执行事项或发起新会话后，工作契约和回执会出现在这里。</CardDescription></CardHeader>
              </Card>
            )}

            {orders.map(order => {
              const team = order.teamCycles.at(-1);
              return <Card key={order.id}>
                <CardHeader>
                  <CardTitle className="text-base">{order.objective}</CardTitle>
                  <CardDescription>
                    {order.status} · ${order.economics.actualCostUsd.toFixed(4)}
                    {order.economics.usageKnown ? '' : ' · 用量待核对'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {order.receipt && <div className="rounded-lg border bg-muted/30 p-3">
                    <div className="flex items-center gap-2"><CheckCircle2 className="size-4" /><p className="text-sm font-medium">工作回执</p><Badge variant={order.receipt.status === 'completed' ? 'secondary' : 'outline'}>{order.receipt.status}</Badge></div>
                    <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">{order.receipt.answer || '没有最终文本，保留已生成产物。'}</p>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span>{order.receipt.artifacts.length} 个产物</span>
                      <span>{order.receipt.sources.length} 个来源</span>
                      <span>{order.receipt.costUsd.toFixed(4)} USD</span>
                      {order.receipt.unfinished.length > 0 && <span className="text-destructive">{order.receipt.unfinished.length} 项未完成</span>}
                    </div>
                  </div>}

                  <div className="grid gap-3 text-sm sm:grid-cols-3">
                    <div><p className="text-xs text-muted-foreground">费用</p><p className="mt-1 font-medium">${order.economics.actualCostUsd.toFixed(4)} / 预算 {order.budgetUsd === undefined ? '未设置' : `$${order.budgetUsd.toFixed(4)}`}</p></div>
                    <div><p className="text-xs text-muted-foreground">协调</p><p className="mt-1 font-medium">{order.economics.coordinationRounds} 轮 · 重复证据读取 {order.economics.duplicateEvidenceReads}</p></div>
                    <div><p className="text-xs text-muted-foreground">缓存</p><p className="mt-1 font-medium">{order.economics.cacheSavingsUsd === null ? '用量未知' : `节约 $${order.economics.cacheSavingsUsd.toFixed(4)}`}</p></div>
                  </div>

                  <details>
                    <summary className="cursor-pointer text-sm font-medium">角色、契约与履历</summary>
                    <div className="mt-3 flex flex-col gap-2">
                      {order.roles.map(role => {
                        const card = order.scorecards.find(item => item.roleId === role.id);
                        const load = order.wellbeing.find(item => item.roleId === role.id);
                        return <div key={role.id} className="rounded-md border p-3">
                          <div className="flex flex-wrap items-center gap-2"><Users className="size-4" /><span className="font-medium">{role.name}</span><Badge variant="outline">{load?.state ?? role.employment}</Badge>{!role.persistent && <Badge variant="secondary">临时</Badge>}</div>
                          <p className="mt-1 text-xs text-muted-foreground">{role.responsibilities.join(' · ')}</p>
                          <p className="mt-2 text-xs text-muted-foreground">
                            履历置信度 {card?.confidence ?? 'insufficient'} · 样本 {card?.sampleSize ?? 0}
                            {card?.completionRate !== null && card?.completionRate !== undefined ? ` · 完成率 ${Math.round(card.completionRate * 100)}%` : ''}
                            {card?.budgetCompliance !== null && card?.budgetCompliance !== undefined ? ` · 预算遵守 ${Math.round(card.budgetCompliance * 100)}%` : ''}
                          </p>
                          {!role.persistent && <Button className="mt-2" size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction(`role:${role.id}`, () => workbenchApi.confirmRole(role.id), '角色已进入持久角色池')}>确认持久角色</Button>}
                          <Button className="mt-2" size="sm" variant="ghost" disabled={roleLifeBusy === role.id} onClick={() => void loadRoleLife(role.id)}>{roleLife[role.id] ? '收起生命史' : roleLifeBusy === role.id ? '读取中…' : '查看生命史'}</Button>
                          {roleLife[role.id] && <div className="mt-2 flex flex-col gap-2 rounded-md bg-muted/30 p-2">
                            <p className="text-xs font-medium">岗位版本与审计</p>
                            {roleLife[role.id]!.versions.slice(0, 5).map(version => <div key={version.id} className="flex items-center gap-2 text-xs">
                              <span className="min-w-0 flex-1"><span className="font-medium">v{version.version} · {version.status}</span><span className="text-muted-foreground"> · {version.reason} · {version.hash.slice(0, 12)}</span></span>
                              {version.status !== 'active' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => rollbackRole(role.id, version.version)}>回滚到此版</Button>}
                            </div>)}
                            {roleLife[role.id]!.versionAudits.slice(0, 3).map(audit => <p key={audit.id} className="text-xs text-muted-foreground">审计 v{audit.toVersion} · {audit.action} · {audit.reason} · {audit.actor}</p>)}
                            <p className="text-xs font-medium">跨任务记忆</p>
                            {roleLife[role.id]!.memories.slice(0, 8).map(memory => <div key={memory.id} className="text-xs"><span className="font-medium">{memory.kind}</span><span className="text-muted-foreground"> · {memory.summary}</span></div>)}
                            {!roleLife[role.id]!.memories.length && <p className="text-xs text-muted-foreground">暂无任务记忆。</p>}
                            <p className="mt-1 text-xs font-medium">协作关系</p>
                            {roleLife[role.id]!.relations.slice(0, 8).map(relation => {
                              const otherId = relation.fromRoleId === role.id ? relation.toRoleId : relation.fromRoleId;
                              const other = roleDirectory.find(item => item.id === otherId)?.name ?? otherId;
                              return <p key={relation.id} className="text-xs text-muted-foreground">{relation.kind} · {other} · {Math.round(relation.score * 100)}%</p>;
                            })}
                            {!roleLife[role.id]!.relations.length && <p className="text-xs text-muted-foreground">尚未形成有证据的跨角色关系。</p>}
                            <p className="text-xs text-muted-foreground">负载 {roleLife[role.id]!.wellbeing?.activeAssignments ?? '未知'} · 状态 {roleLife[role.id]!.wellbeing?.state ?? '未知'} · 上下文压力 {roleLife[role.id]!.wellbeing?.contextPressure ?? '未知'}</p>
                          </div>}
                        </div>;
                      })}
                      {order.contracts.map(contract => {
                        const targetRole = reassignRoles[contract.id] ?? roleDirectory.find(role => role.employment === 'active')?.id ?? '';
                        return <div key={contract.id} className="rounded-md border p-3">
                        <div className="flex flex-wrap items-center gap-2"><Network className="size-4" /><span className="text-sm font-medium">{contract.branchObjective}</span><Badge variant="outline">{contract.status}</Badge></div>
                        <p className="mt-1 text-xs text-muted-foreground">产物：{contract.expectedArtifacts.join(' · ') || '未指定'} · 预算 ${contract.budgetUsd?.toFixed(4) ?? '未知'}</p>
                        {contract.delivery && <p className="mt-2 whitespace-pre-wrap text-sm">{contract.delivery.summary}</p>}
                        {contract.delivery?.unfinished.length ? <p className="mt-1 text-xs text-destructive">未完成：{contract.delivery.unfinished.join('；')}</p> : null}
                        {team && ['proposed', 'failed'].includes(contract.status) && roleDirectory.length > 0 && <div className="mt-2 flex gap-2">
                          <select aria-label={`改派 ${contract.id}`} className="min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" value={targetRole} onChange={event => setReassignRoles(values => ({ ...values, [contract.id]: event.target.value }))}>
                            {roleDirectory.filter(role => role.employment === 'active').map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
                          </select>
                          <Button size="sm" variant="outline" disabled={!targetRole || !!busy} onClick={() => void runAction(`contract:${contract.id}`, () => workbenchApi.reassignContract(team.id, contract.id, targetRole), '分工已改派')}>改派</Button>
                        </div>}
                      </div>;
                      })}
                    </div>
                  </details>

                  {proposals.filter(item => item.workOrderId === order.id && item.status === 'pending').map(item => <div key={item.id} className="rounded-md border p-3">
                    <div className="flex items-center gap-2"><span className="min-w-0 flex-1 text-sm font-medium">{item.title}</span><Badge variant="outline">{item.impact}</Badge></div>
                    <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" disabled={!!busy} onClick={() => {
                        if (!window.confirm('采纳该制度提案？')) return;
                        void runAction(`proposal:${item.id}`, () => workbenchApi.decideProposal(item.id, true, '人类确认采纳'), '制度提案已采纳');
                      }}>采纳</Button>
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction(`proposal:${item.id}`, () => workbenchApi.decideProposal(item.id, false, '人类拒绝'), '制度提案已拒绝')}>拒绝</Button>
                    </div>
                  </div>)}

                  {team && <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                    <CircleDollarSign className="size-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">团队 {team.teamEstimateUsd.toFixed(4)} USD · 单角色基线 {team.soloEstimateUsd.toFixed(4)} USD</span>
                    {['planned', 'running'].includes(team.status) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction(`${team.id}:pause`, () => workbenchApi.teamAction(team.id, 'pause'), '团队已暂停')}>暂停新分支</Button>}
                    {team.status === 'paused' && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction(`${team.id}:resume`, () => workbenchApi.teamAction(team.id, 'resume'), '团队已恢复')}>恢复</Button>}
                    {!['completed', 'cancelled', 'dissolved'].includes(team.status) && <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => {
                      if (!window.confirm('解散团队会停止仍在运行的分支。已完成产物会保留。继续？')) return;
                      void runAction(`${team.id}:dissolve`, () => workbenchApi.teamAction(team.id, 'dissolve'), '团队已解散');
                    }}>解散团队</Button>}
                    <Button size="sm" variant="ghost" onClick={() => onSession(order.sessionId)}><Play data-icon="inline-start" />打开会话</Button>
                  </div>}
                </CardContent>
              </Card>;
            })}

            {exceptions.length > 0 && <Card>
              <CardHeader><CardTitle>需要处理的组织异常</CardTitle><CardDescription>事实由 maharness 记录；权限、费用和价值取舍由你决定。</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-3">
                {exceptions.map(item => <div key={item.id} className="rounded-md border border-destructive/30 p-3">
                  <div className="flex items-center gap-2"><AlertCircle className="size-4 text-destructive" /><span className="text-sm font-medium">{item.summary}</span><Badge variant="destructive">{item.kind}</Badge></div>
                  <p className="mt-2 text-xs text-muted-foreground">{item.factRuling} · {item.recovery}</p>
                  <div className="mt-2 flex gap-2"><Input aria-label={`异常决定 ${item.id}`} placeholder="填写恢复、授权或费用决定" value={decisions[item.id] ?? ''} onChange={event => setDecisions(values => ({ ...values, [item.id]: event.target.value }))} /><Button size="sm" disabled={!!busy} onClick={() => resolveException(item)}>处理</Button></div>
                </div>)}
              </CardContent>
            </Card>}

            <Button variant="outline" onClick={() => void reload()}><RefreshCw data-icon="inline-start" />刷新</Button>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
