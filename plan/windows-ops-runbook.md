# Windows 运维手册（安装 / 升级 / 恢复 / 数据目录）

适用对象：在 Windows 上安装、升级 maharness，或在数据损坏 / 端口冲突时执行恢复操作。所有命令均按原文复制即可执行；`<仓库路径>` 替换为本机 maharness 仓库目录。

## 数据目录与密钥位置

| 路径 | 内容 | 说明 |
|---|---|---|
| `web-agent\data\` | 默认数据目录 | SQLite 主库 `agent.db`、技能提案 `skill-proposals\`、Trace `traces\`、启动备份 `backups\` |
| `web-agent\data\backups\` | 启动自动备份 | 每次启动热备份主库与 WAL/SHM 伴生文件，保留最近 7 份，超出自动轮转 |
| `web-agent\data\secret.key` | 主密钥 | AES-256-GCM 加密 Provider API Key；Windows 上以 `icacls` 收紧 DACL |
| `web-agent\.env` | 环境配置 | Provider Key、部署模式（`MAHARNESS_MODE`）等；文件已 gitignore，升级不会覆盖已有内容 |
| `$env:AGENT_DATA_DIR` | 数据目录覆盖 | 设置后全部数据写入该目录（多实例 / 隔离部署用） |

## 安装（首次）

前置：Node.js ≥ 20.6（推荐 22，`node --version` 确认）、npm ≥ 10。

```powershell
git clone https://github.com/Libai-88/maharness.git
cd maharness\web-agent
npm run setup
```

`npm run setup` 完成后端 / 前端依赖安装、`.env` 生成与全局 `maharness` 命令注册。编辑 `.env` 填入至少一个 Provider Key 后，任意目录执行 `maharness` 即启动并自动打开浏览器（就绪前挂起，已在运行则复用）。仅需跑测试时不要求 Key。

## 升级（保留数据）

```powershell
Set-Location <仓库路径>
git pull
Set-Location web-agent
npm ci
npm ci --prefix ui
```

升级后首次启动自动完成数据库 schema 版本迁移与启动备份，无需手动干预。2026-11-01 干净 checkout 演练：`git fetch` 到最新 `maharness` 分支 → 双仓 `npm ci` → `npm run typecheck` → 全量 `npm test` 911/911 通过，总耗时约 1 分钟。

## 恢复（数据库损坏）

### 自动恢复（默认路径）

启动时服务先对 `agent.db` 做 `integrity_check`：损坏即从 `data\backups\` 最近一份通过校验的备份恢复，损坏现场保留为 `agent.db.corrupt-<时间戳>`，日志输出 `[store] 已从备份 <文件名> 恢复数据库`。此路径无需人工介入。

2026-11-01 实际演练（干净 checkout）：隔离数据目录启动 → 停止 → 覆盖 `agent.db` 头部 512 字节模拟损坏 → 重启，日志确认自动从 `backups\agent-*.db` 恢复且服务正常启动。

### 手动恢复（备份存在但服务无法启动时）

```powershell
Set-Location <仓库路径>\web-agent\data
Copy-Item backups\agent-<时间戳>.db agent.db -Force
Remove-Item agent.db-wal, agent.db-shm -Force -ErrorAction SilentlyContinue
Set-Location ..\
npm run start:all
```

替换 `<时间戳>` 为 `Get-ChildItem backups` 中最新一份；删除 WAL/SHM 伴生文件是因为它们属于旧主库，与新拷贝的主库不匹配。

### 主密钥异常

`secret.key` 丢失或损坏时服务标 `keyBroken` 并拒绝静默重建。确需重建（旧密文将不可恢复，需重新录入 Provider Key）：先备份原文件，再设置 `MAHARNESS_ALLOW_SECRET_KEY_RESET=1` 重启。

## 端口冲突

`.env` 中设置 `PORT=<其他端口>`（默认 3000）后重启；或关闭已占用实例。全局 `maharness` 命令已对「已在运行」做复用，不会重复启动。

## 部署模式（remote 暴露前置）

对外暴露需在 `.env` 同时配置齐备，启动自检缺任一项即拒绝启动：

```ini
MAHARNESS_MODE=remote
MAHARNESS_API_TOKEN=<强随机长 token>
MAHARNESS_TLS_CERT=<证书路径>
MAHARNESS_TLS_KEY=<私钥路径>
MAHARNESS_BIND=0.0.0.0
MAHARNESS_ALLOWED_HOSTS=<对外域名>
MAHARNESS_ALLOWED_ORIGINS=https://<对外域名>
```

插件仍在宿主进程执行，remote 模式只解决传输与凭据层，不等价于多租户隔离；详细边界见威胁模型 v1.1。

## 升级回滚

代码回退：`git checkout <上一版本 tag 或 commit>` 后重新 `npm ci` 双仓。数据回退：停止服务，把 `data\backups\` 中目标版本启动时生成的备份拷回 `agent.db`（步骤同上节手动恢复）。数据库 schema 版本高于当前代码时启动自检拒绝打开，不允许降级打开新版库。
