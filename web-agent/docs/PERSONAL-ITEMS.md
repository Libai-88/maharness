# 个人事项与工作台

主导航提供四个入口：

- **会话**：提出问题、附加文件并继续处理任务结果。
- **文件**：管理工作区文件、预览资料并发起任务。
- **工作台**：聚合今日与逾期事项、待确认自动化、最近运行、产物、项目、笔记、体验指标和继续处理入口。
- **自动化**：查看下次运行、上次结果、审批状态和执行历史。

设置固定在侧边栏底部，运行记录、插件和统计位于高级入口。点击侧边栏会话、功能页关闭按钮或按 `Esc` 返回会话；浏览器后退同样恢复会话。

## 记录与安排

直接说“记下周五交周报”“把复习安排改到下周二”，模型可通过 `item_*` 工具保存。额外推断的事项先作为建议，用户采纳后保存。`todo_*` 维护当前会话的执行步骤。

“新建项目”“更新项目阶段”“记一条笔记”及“修改这条笔记”分别使用 `workbench_add_project`、`workbench_update_project`、`workbench_add_note` 和 `workbench_update_note`。项目和笔记更新携带读取时得到的 `updatedAt`；过期版本返回冲突，不覆盖较新的内容。

日期留空表示未排期；具体时间使用 IANA 时区。日期时间记录个人安排，不触发提醒或自动执行。现有续跑计划独立管理。

事项支持标题、说明、优先级、项目、日期、时间、重复规则和最多 10 个文件。单文件上限 20 MB，文件访问沿用工作区和租户边界。模型仅在用户明确要求时记录或更新事项；推断出的后续安排先在聊天中作为建议，用户确认后才持久化。

## 执行与确认

“现在执行”首次创建专属会话，后续重试复用该会话。来源会话与执行会话分别可访问。执行复用 Run 的权限、审批、预算、停止、恢复和文件产物。

有效结果进入“结果待确认”，用户检查后确认完成。失败、取消和中断保留实际状态；中断任务提供“继续任务”和“另起执行”。执行期间修改事项不会改写已发出的请求。旧版本结果保留在历史中，不会完成新版本事项。

每次创建和执行使用操作标识去重。修改需要最新 revision，冲突返回 409，原数据保持完整。工作台保存失败时保留当前页面草稿，可导出后重新载入应用数据。

## 存储与迁移

待办和完整工作台共用待办插件的 `personal-items.sqlite`，个人事项、项目与笔记按租户隔离。

首次读取 default 工作台时，迁移 `workbench.json` 及文件桥数据；原文件保留，并生成 `.before-items` 备份。损坏输入返回错误。已标记的示例记录不进入个人事项。

浏览器历史数据需在完整工作台的“数据与备份”中预览数量并确认导入；原浏览器副本保留。同 ID 按更新时间合并，删除记录遵守墓碑。历史看板继续可编辑，需逐条点击“转入个人事项”，重复转入保持同一事项。

## 插件与 API

待办插件提供 `service:personal-items`；工作台与 `item_*` 工具复用该服务。停用待办插件后，事项接口返回 503。

- `item_list`：分页读取事项，默认 20 条，最多 50 条。
- `item_get`：事项、revision 与执行关联。
- `item_create`：明确安排；`operationId` 用于重试去重。
- `item_update`：按 revision 修改、归档或重新打开。
- `item_complete`：用户明确要求完成时调用。

兼容工作台工具保持独立入口并转调同一 `PersonalItems` 服务：`workbench_today`、`workbench_add_task`、`workbench_update_task`、`workbench_add_project`、`workbench_update_project`、`workbench_add_note`、`workbench_update_note` 和 `workbench_diary`。

HTTP 接口：`GET/POST /api/items`、`GET/PATCH /api/items/:id`、`POST /api/items/:id/execute`、`POST /api/items/import-legacy/:id`。执行需 `Idempotency-Key`，写操作沿用现有凭据门。`items.updated` 事件按租户过滤。

工作台聚合接口为 `GET /api/workbench/summary`。兼容工作台接口 `GET/PUT /api/plugins/workbench/wb/data` 继续可用，写入携带 `{revision,data}`；`POST /api/plugins/workbench/wb/import` 按版本合并。文件夹和浏览器存储仅用于历史导入，日常数据以应用存储为准。

验证范围见 [个人事项与工作台验收](PERSONAL-ITEMS-ACCEPTANCE.md)。
