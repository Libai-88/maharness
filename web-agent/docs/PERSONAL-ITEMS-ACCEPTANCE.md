# 个人事项与工作台验收

日期：2026-11-16。

| 检查类型 | 结果 | 范围 |
| --- | --- | --- |
| 定向自动检查 | 50/50 通过 | 事项持久化、迁移、去重、版本冲突、租户隔离、重复事项、结果确认、共享工作台、Run 执行与恢复、事件过滤、API 契约 |
| 权限回归 | 3/3 通过 | 事项创建/更新/执行的凭据门、只读凭据、插件接口鉴权 |
| 自动浏览器检查 | 13/13 通过 | 事项添加与排期、刷新恢复、版本冲突草稿、共享存储、来源会话跳转、事项直达、工作台项目、历史导入、搜索与撤销、导出、主题与可访问性、功能页关闭、运行诊断 |
| 前后端类型检查 | 通过 | `npm run typecheck`、`npm run ui:typecheck` |
| 生产构建 | 通过 | `npm run build` |
| 插件锁校验 | 通过 | `npm run plugin:lock:verify` |
| 差异格式检查 | 通过 | `git diff --check` |
| 人工验收 | 未执行 | 自动浏览器检查不替代人工检查 |
| 真实模型验收 | 未执行 | 此前获准的真实模型评测预算已用尽，本轮没有追加调用 |

定向自动检查耗时约 2.36 秒；权限回归进程耗时约 2.34 秒。13 项浏览器检查包含 11 项功能检查与两种宽度的运行诊断检查；诊断检查使用固定 API 样本，其余事项持久化与共享工作台检查包含隔离环境中的真实 HTTP 接口。执行接口检查使用确定性 AgentLoop，不能代表真实模型的工具选择和安排理解能力。

本轮验收的真实模型调用量为 0，未新增模型费用。已有长内容评测结果不作为本轮事项协同能力的真实模型结果。

构建仍提示 `api.ts` 与 `run-api.ts` 的循环重导出，以及部分分包超过 500 kB。构建产物可生成，选定页面检查通过。

## 复核命令

```powershell
node --import tsx --test core/todo/tests/items.spec.ts core/todo/tests/todo.spec.ts plugins/workbench/tests/merge.spec.ts server/tests/items.spec.ts server/tests/api-contract.spec.ts server/tests/events-tenant.spec.ts server/tests/run-service.spec.ts
node --import tsx --test --test-name-pattern "事项接口|readonly token|插件 API 挂载点" server/tests/auth.spec.ts
npm run e2e --prefix ui -- personal-items.spec.ts workbench.spec.ts settings-layout.spec.ts --grep "personal items|editing conflict|workbench overview|iframe source|侧边栏选择|功能页和设置|工作台记录|全局搜索|浏览器历史|工作台布局|任务诊断"
npm run build
npm run plugin:lock:verify
```
