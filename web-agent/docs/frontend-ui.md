# 前端组件替换方案

## 视觉规范

- AI Elements 全部采用官方组件：Attachment、Bubble、MessageScroller、Questionnaire、Marker、Trace、CodeBlock、Message。
- 通用组件按当前页面交互需要选用官方 shadcn/ui 组件。
- Markdown 渲染采用 Streamdown，代码高亮采用 Shiki 细粒度语言加载。
- 首页贴纸图片压缩采用 browser-image-compression。
- 基础组件采用 shadcn/ui Radix Nova，字体采用 Geist 与系统中文字体。
- 页面使用中性色表面、细边框和统一圆角；品牌色仅强调主要操作与选中状态。
- 明暗主题与陶土、石墨、苔绿三种品牌色独立组合。
- 标题、正文、辅助信息、数值建立统一层级；列表与表单保持相同间距。
- 首页贴纸采用官方 Attachment 纵向图片卡，保留倾斜、换图与恢复默认交互。

## 替换清单

| 区域 | 官方组件 | 交互要求 |
| --- | --- | --- |
| 应用导航与会话 | Sidebar、DropdownMenu、Input、Checkbox | 折叠导航、重命名、置顶、归档与批量管理 |
| Chat 空状态 | Empty、Button、Attachment | 欢迎问候、快捷提问与首页贴纸 |
| Chat 消息流 | MessageScroller、Message、Bubble | 用户消息锚定、流式跟随、阅读历史时停止跟随、回到最新 |
| 消息操作 | ContextMenu、Button、Tooltip | 右键、触摸长按、键盘操作、复制、引用、重发与移除 |
| 思考与工具调用 | Trace、CodeBlock、Spinner | 运行状态、按需展开、工具输出与错误 |
| 消息输入 | InputGroup、Command、Popover | 模型切换、斜杠命令、表情、发送与停止 |
| 目标与审批 | Trace、Item、Alert、Progress | 目标进度、验收证据与逐项审批 |
| 运行轨迹 | ScrollArea、Trace、Badge、Empty | 父子步骤、状态、耗时与实时更新 |
| 文件工作区 | Popover、Command、Collapsible、Button、ScrollArea | 工作区切换、目录展开、文件搜索 |
| 文件预览与编辑 | CodeBlock、Textarea、Dialog | 预览、复制、编辑保存、键盘保存与全屏 |
| Git 面板 | Tabs、Item、Input、Button、Alert | 分支、变更文件、提交与推送 |
| 插件管理 | Card、Item、Badge、Switch、Sheet | 搜索、状态、重载、启停、配置与详情 |
| 技能系统 | Item、Badge、Input、Sheet、CodeBlock | 来源分组、搜索、安装卸载、锁同步与提案采纳 |
| 缓存与成本 | Card、Progress、Table、Skeleton | 真实命中率、成本、调用计数与上下文质量 |
| 设置导航 | Tabs、ScrollArea | 键盘切换、窄屏导航与独立滚动 |
| 设置表单 | Field、Input、Textarea、Select、Switch、Slider、ToggleGroup | 可访问标签、分组、保存与即时设置 |
| 人设管理 | Card、Dialog、Field、Switch、AlertDialog | 新建、编辑、启停与删除确认 |
| 通用反馈 | Alert、Empty、Skeleton、Spinner、Sonner | 错误、空态、加载与操作反馈 |
| 待办看板 | Card、Input、Select、Sheet、Field | 搜索、来源与状态筛选、拖拽、编辑与删除 |
| 工作台 | Sidebar、Tabs、Card、Field、Command、Dialog、Sonner | 任务、项目、灵感、复盘与本地文件同步 |

## 执行顺序

1. Chat 与消息菜单。
2. 全局主题、导航和布局。
3. 文件、Git、插件和技能。
4. 统计、设置和人设。
5. 插件页面宿主与剩余控件。
6. 类型检查、生产构建、自动化交互测试与明暗主题响应式验收。

## Chat 页面

参考：[shadcn Chat](https://ui.shadcn.com/docs/ai-elements/base/chat)。组件 API 使用项目现有的 Radix 版本。

| 优先级 | 区域 | 替换与布局 | 验收条件 |
| --- | --- | --- | --- |
| P0 | 消息阅读 | MessageScroller + Message；用户使用 muted Bubble，回复使用 ghost Bubble；统一 48rem 内容宽度 | 流式跟随、历史阅读、回到最新、切换会话位置独立 |
| P0 | 思考与工具 | 每段活动共用一个 Trace；运行态采用官方 shimmer；结果使用 TraceCollapsible 和 CodeBlock | 思考、工具、子代理顺序一致，完成后可展开详情 |
| P0 | 输入区 | InputGroup + 表单；模型 Combobox（Popover + Command）；命令 Command + Popover | 中文输入法确认不发送，模型与表情不提交表单，命令可键盘选择 |
| P0 | 窄屏轨迹 | 桌面独立侧栏，窄屏 Sheet | 面板可开启、关闭，焦点可返回，不挤压消息列 |
| P1 | 消息操作 | ContextMenu 与可聚焦消息 | 右键、触屏长按、键盘调用，保留复制、引用、重发与移除 |
| P1 | 验收与审批 | 任务确认采用 Item + Sheet，验收结果采用 TraceCollapsible；审批保持独立 Item | 逐项证据可查看，批准与拒绝只提交一次，关闭确认面板保留验收草稿 |
| P1 | 欢迎页 | Empty + 建议 Button + Attachment，贴纸自适应摆放 | 无模型时有明确入口，贴纸在窄屏也可换图与恢复 |

只迁移已有功能，不增加附件上传、联网模式或新的模型协议。

### Chat 优化清单

| 优先级 | 范围 | 调整方案 | 验收条件 |
| --- | --- | --- | --- |
| P0 | 阅读布局 | 消息、输入、审批与目标摘要共享内容宽度和水平边距；运行轨迹默认收起，桌面侧栏与窄屏 Sheet 按需展开 | 关闭轨迹后正文仍保持阅读宽度，开启后不出现横向溢出，收起期间的步骤可在展开后查看 |
| P0 | 状态区域 | 计划和验收先呈现摘要，详情按需展开；审批、目标和任务确认共用限高 ScrollArea | 同时存在计划、审批和验收表单时，仍可阅读最新回复并操作输入框 |
| P1 | 思考与工具 | 保留 Trace 的运行态 shimmer；长思考和工具详情采用折叠层级，错误保持明确提示 | 自动状态切换尊重用户手动展开或收起，运行完成后保留可查看的记录 |
| P1 | 输入区 | 保留 InputGroup、模型选择与发送/停止；校准空草稿高度、多行增长和辅助提示的占用 | 中文输入、斜杠命令、引用、表情和模型切换不丢失草稿、不误发送 |
| P1 | 欢迎页 | 调整问候、建议与贴纸的间距和响应式位置 | 桌面和窄屏均可直接输入，贴纸换图、持久化与恢复默认可用 |

组件基座沿用项目现有的 Radix 版本。使用官方 Chat 的组合方式，不切换底层组件库或改写现有聊天协议。

验收覆盖新会话、长历史、持续流式输出、长思考、多工具调用、审批与计划并存，以及 390px、900px、1440px 下的明暗主题布局。

## 插件页面

- 插件页面使用独立构建入口，共用主应用的官方组件与主题变量；保留 iframe 隔离和现有 API 地址。
- 待办看板保留四列、搜索、来源筛选、状态切换、拖拽、新建、编辑、优先级与删除；拖拽采用现有 dnd-kit，状态选择同时支持键盘。
- 工作台保留任务列表、看板、四象限、时间轴、月历、项目、灵感、复盘、备份、回收站、番茄钟与文件同步；数据格式与存储键保持兼容。

### 工作台组件清单

| 区域 | 官方组件与成熟库 | 验收条件 |
| --- | --- | --- |
| 导航与全局搜索 | Sidebar、Command、Dialog | 六个视图、双语、折叠偏好、Ctrl/Cmd+K 与 Alt+1–6 |
| 今日聚焦 | Card、Item、Alert、Progress | 逾期任务、受阻项目、每日记录、预计负载与已有快捷操作 |
| 任务表单与编辑 | Field、Input、Textarea、Select、Sheet | 日期、起始日、优先级、项目、标签、子任务、重复规则与预计番茄数 |
| 列表与批选 | Item、Checkbox、DropdownMenu、Input | 搜索、排序、日期分组、批量修改、延期、完成、删除与撤销 |
| 任务视图 | Tabs、Card、现有 dnd-kit | 列表、看板、四象限、时间轴与月历保持同一任务数据；拖拽和触屏可用 |
| 项目与灵感 | Card、Badge、Field、Sheet | 项目阶段、下一步、阻塞原因、关联任务、标签、检索与编辑 |
| 复盘 | Card、Table、Chart | 周/月周期、趋势、项目投入、报告复制与下载保持原有统计口径 |
| 备份与回收站 | Card、Item、AlertDialog、Button | JSON/Markdown 导出、合并/覆盖导入、恢复、清空与数据健康检查 |
| 文件同步 | Alert、Button、Sonner | IndexedDB 句柄恢复、授权重连、写前合并、外部修改吸收、冲突副本与每日快照 |
| 番茄钟与反馈 | Card、Button、Sonner | 倒计时、标题提示、工作/休息时长、停止与撤销操作 |

存储兼容要求：保留 `pd_workbench_v1`、`pd_wb_uipref` 与 IndexedDB `pd_wb_fs`；保留 `workbench-data.json` 的记录 ID、墓碑、回收站、日记时间戳和元数据。组件迁移不得重置或自动清空已有记录。

## 验收

- 现有 API、事件协议、权限和数据行为保持一致。
- 通用控件由官方组件提供焦点管理、键盘交互和弹层行为。
- Chat 流式输出、审批、重发、引用与滚动功能可用。
- 页面在桌面与窄屏下可访问主要操作，无横向溢出。
- 三种品牌色在明暗主题中均生效。
- 首页贴纸可换图、持久化并恢复默认。
