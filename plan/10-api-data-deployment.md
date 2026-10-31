# API、数据与部署

关联登记项：API-01、API-02、API-03、API-04、API-05、API-06、API-07、API-08。

## 现状证据

Express、SSE、SQLite 和多类路由已存在。变更类 API 可通过 `MAHARNESS_API_TOKEN` 启用 token 校验，审批端点支持一次性审批凭据；授权与 SSE 生命周期审计持久化于 SQLite，并通过只读端点限量查询。`/api/health`、`/api/ready`、`/api/storage` 和 Provider 诊断端点已提供稳定、非泄密的运行状态；存储检查按 10%/5% 空间阈值报告警告/临界状态，Provider 真实探测故障进入健康账本并支持熔断诊断。数据库 schema 以 `PRAGMA user_version` 版本化管理（API-04）：启动时经基线/增量迁移推进版本，自动备份到 `data/backups/`（保留 7 份）并做完整性校验，损坏时自动从最近可用备份恢复；管理端点 `GET /api/maintenance/db` 与 `POST /api/maintenance/db/backup` 提供维护状态查询和手动热备份。鉴权仍是本机控制面保护，不构成用户身份或角色授权；多用户/多租户未建模，配置热更新不落盘。

## 目标

交付两个明确模式：本机单用户模式继续安全默认；受限远程单用户模式和团队多用户模式具备身份认证、授权、租户隔离、数据迁移、备份和运维入口。任何模式不得把 UI 隐藏、提示词或同一 OS 用户进程当作安全边界。

## 执行

1. 定义 local、remote-single-user、team 部署模式和启动安全检查；默认绑定回环，remote 模式强制 TLS/认证配置。
2. 增加用户身份、会话管理、角色和能力授权；按用户隔离会话、工作区、审批、Provider 凭据与 Trace 查询。
3. 为 team 模式设计 tenant/principal 数据键、租户级密钥、配额和管理角色；所有查询/写入在数据访问层强制 tenant scope。
4. 将 SQLite migration、schema version、备份/恢复和归档轮转扩展为租户化迁移；先做 dry-run 行数/孤儿/跨租户检查，再原子切换。
5. 对第三方插件和工具进程使用独立 OS 身份/容器执行，配置工作目录、文件 ACL、网络出口策略和资源配额。
6. 配置写入采用原子落盘、版本校验、敏感字段脱敏和失败回滚。
7. 提供部署清单、健康/就绪检查、日志/指标、数据目录、密钥轮换和升级步骤。

## 验收与回滚

未鉴权远程请求默认拒绝；迁移前自动备份且可恢复；新版本启动自检失败时保留旧数据和旧配置，禁止半迁移运行。

## 依赖、兼容和指标

依赖 05 的权限/信任模型和 09 的恢复存储契约。数据库采用逐版本 migration，迁移步骤必须可重入；破坏性 schema 变更采用 expand/migrate/contract 两阶段。先保持单机数据格式可回滚，再迁移 principal/tenant 归属；不能确定归属的数据不得默认共享。目标：备份恢复演练成功率 100%；迁移失败时原库可用；health check 不泄露密钥；remote 模式未设置身份与 TLS 配置时拒绝启动；team 模式跨租户读写测试全部拒绝；所有长耗时插件任务在独立执行边界运行。出现隔离逃逸立即关闭 remote/team 模式并保留 local-only。

## 范围、测试与完成定义

范围包括 HTTP/SSE 路由、身份与租户模型、SQLite migration、密钥/配置存储、备份恢复、健康诊断和部署脚本。

测试覆盖未鉴权请求、SSE 断线重连、跨租户读写、迁移失败恢复、备份校验、配置崩溃注入、密钥轮换和插件隔离。`ui/e2e/sse-reconnect.spec.ts` 使用真实 Playwright 浏览器和 `/api/events`，在离线后恢复联网且不重载页面的情况下验证 EventSource 自动重建，并确认关闭页面后连接审计回到基线；专项 `1/1`、`npm run ui:typecheck`、`npm run ui:build` 和 `git diff --check` 通过。API-03 仍待长时连接资源回收演练，API-01 至 API-08 均有实现、迁移演练、部署文档和回滚证据后关闭。

API-03 长连接资源补充（2026-10-31）：`server/tests/auth.spec.ts` 真实 HTTP 连接保持超过 15 秒心跳周期，验证初始 `retry: 15000` 帧、`: ping` 心跳、取消后 `ClientTracker` 归零和资源释放；专项 `34/34`，完整 `npm run e2e` `22/22`，`npm run typecheck`、`npm run ui:typecheck`、`npm run ui:build` 和 `git diff --check` 通过。API-03 仍待更长时段及多连接压力演练。

API-05 原子写入与审计补充（2026-10-31）：新增 `kernel/atomic-file.ts`，以同目录临时文件、完整写入后 `fsync`、原子替换和失败清理统一保护配置、规则和 `secret.key` 写入；`Config.setPersistentBatch` 让 `/api/config` 先整体提交再发布运行时变更，提交失败不广播部分状态。变更类 API 的成功/拒绝授权和 SSE 生命周期均写入脱敏审计，`createApiTokenGuard` 对真实 Express 请求与轻量测试请求使用同一路径兜底。原子文件、配置批量提交、失败注入、真实配置路由和授权审计回归均已覆盖：`server/tests/auth.spec.ts` `34/34`，全量 `npm test` `887/887`，`npm run typecheck`、`git diff --check` 通过。API-05 进入进行中，仍待 SQLite 写入事务、并发版本校验及真实崩溃注入覆盖。

API-05 并发与崩溃防护（2026-10-31）：SQLite 写入全部事务化——审计事件、明文密钥迁移、批量模型 upsert、工具账本 `claimToolEffect`、会话消息与断点清理均为全成或全回滚；Provider 与模型行以 `updatedAt` 乐观版本防同毫秒覆盖，配置与规则文件以内容指纹 revision 做乐观锁，路由层缺失版本返回 428、冲突返回 409 并附最新版本，UI 保存/启停/删除自动携带版本。`server/tests/sqlite-crash.spec.ts` 以真实子进程在事务中 `exit(137)` 注入崩溃，重开数据库断言行已回滚，验证崩溃后配置与数据库无半写。专项（sqlite-crash、db、config-provider）`23/23`，全量 `npm test` `892/892`，`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。API-05 验收条件已满足，登记为已验收。

API-04 版本化迁移与自动维护（2026-11-01）：schema 版本通过 `PRAGMA user_version` 管理，新库与历史库统一经基线建表推进到当前版本，更高版本库 fail-closed 拒绝打开，未来破坏性变更经 `Store.MIGRATIONS` 步骤表逐版本事务化推进。启动时 `Store.autoMaintain` 在 Store 打开前热备份主库与 WAL/SHM 到 `data/backups/`（保留最近 7 份），只读 `integrity_check` 校验失败时保留损坏现场并从最近通过校验的备份自动恢复。`GET /api/maintenance/db` 返回 schema 版本、完整性和备份清单，`POST /api/maintenance/db/backup` 手动触发热备份（token guard 保护，契约已登记）。Trace 归档轮转由 `kernel/trace.ts` `pruneOld()` 按 `trace.retainDays` 执行。回归：`server/tests/db.spec.ts` 22/22（版本推进、更高版本拒绝、损坏恢复、轮转），全量 `npm test` 905/905、`npm run selftest` 91/91、`npm run eval:ci` 27/27、`npm run typecheck`、`git diff --check` 通过。
