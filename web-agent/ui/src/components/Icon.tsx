// ui/src/components/Icon.tsx —— maharness 自研线性图标集（24×24，stroke=currentColor）
// 全部手绘 path，统一 1.8 线宽 + 圆角端点，替代 emoji 图标（品牌化）
interface IconProps { size?: number; className?: string }

function Svg({ children, size = 16, className }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 置顶：图钉 */
export const IconPin = (p: IconProps) => (
  <Svg {...p}><path d="M9 3 L15 3 M10 3 v5 l-3 4 h10 l-3 -4 v-5" /><path d="M12 12 v9" /></Svg>
);

/** 归档：档案盒 */
export const IconArchive = (p: IconProps) => (
  <Svg {...p}><path d="M3 7 h18 v12 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 Z" /><path d="M3 7 l2 -3 h14 l2 3" /><path d="M9 12 h6" /></Svg>
);

/** 删除：回收站 */
export const IconTrash = (p: IconProps) => (
  <Svg {...p}><path d="M4 6 h16" /><path d="M9 6 v-2 h6 v2" /><path d="M6 6 l1 14 h10 l1 -14" /><path d="M10 10 v6 M14 10 v6" /></Svg>
);

/** 批量管理：多选框 */
export const IconManage = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12 l3 3 5 -6" /></Svg>
);

/** 插件：拼图块 */
export const IconPlugin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4 h6 v3 h3 v6 h-3 v3 h-3 v4 h-6 v-4 h-3 v-6 h3 v-3 h3 Z" />
    <circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

/** 文件：文件夹 */
export const IconFolder = (p: IconProps) => (
  <Svg {...p}><path d="M3 6 a2 2 0 0 1 2 -2 h5 l2 3 h7 a2 2 0 0 1 2 2 v9 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 Z" /></Svg>
);

/** 统计：上升柱状 */
export const IconStats = (p: IconProps) => (
  <Svg {...p}><path d="M4 20 h16" /><path d="M7 20 v-7 M12 20 v-11 M17 20 v-4" /><path d="M17 5 l3 2 -3 2" /></Svg>
);

/** 设置：齿轮 */
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3 v3 M12 18 v3 M3 12 h3 M18 12 h3 M5.6 5.6 l2.1 2.1 M16.3 16.3 l2.1 2.1 M18.4 5.6 l-2.1 2.1 M7.7 16.3 l-2.1 2.1" />
  </Svg>
);

/** 主题：日月 */
export const IconTheme = (p: IconProps & { dark?: boolean }) => (
  p.dark
    ? <Svg {...p}><path d="M20 14.5 A8 8 0 1 1 9.5 4 A6.5 6.5 0 0 0 20 14.5 Z" /></Svg>
    : <Svg {...p}><circle cx="12" cy="12" r="4.5" /><path d="M12 2.5 v2.5 M12 19 v2.5 M2.5 12 H5 M19 12 h2.5 M5.3 5.3 l1.8 1.8 M16.9 16.9 l1.8 1.8 M18.7 5.3 l-1.8 1.8 M7.1 16.9 l-1.8 1.8" /></Svg>
);

/** 思考：脑波 */
export const IconBrain = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4 a3 3 0 0 1 3 3 c2 0 3 1.5 3 3 c2.2 0.5 3 2.2 2.4 4 c-0.6 1.8 -2.2 2.8 -4.4 2.4 c-1 1.8 -2.8 2.2 -4.6 1.6 c-1.8 -0.6 -2.6 -2 -2.4 -4 c-2 -0.8 -2.8 -2.8 -2 -4.8 c0.8 -2 2.6 -3 4.6 -3 c0 -1.6 1.4 -3 3 -2.2 Z" />
    <path d="M9 12 h2 l1.5 2 2 -4 1.5 2 h2" />
  </Svg>
);

/** 缓存命中：闪电 */
export const IconBolt = (p: IconProps) => (
  <Svg {...p}><path d="M13 3 L5 13 h6 l-1 8 8 -10 h-6 Z" /></Svg>
);

/** 计划：清单 */
export const IconPlan = (p: IconProps) => (
  <Svg {...p}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8 h8 M8 12 h8 M8 16 h5" /></Svg>
);

/** 锁（审批）：挂锁 */
export const IconLock = (p: IconProps) => (
  <Svg {...p}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10 V7 a4 4 0 0 1 8 0 v3" /><circle cx="12" cy="15" r="1.5" /></Svg>
);

/** 羊（品牌）：极简羊头——弯角 + 卷毛 + 微笑 */
export const IconSheep = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 10 C 5.5 8.5, 4.5 5, 7 3.8 C 8.8 3, 9.5 4.5, 9 6" />
    <path d="M15.5 10 C 18.5 8.5, 19.5 5, 17 3.8 C 15.2 3, 14.5 4.5, 15 6" />
    <circle cx="8.2" cy="11.5" r="2.8" />
    <circle cx="15.8" cy="11.5" r="2.8" />
    <circle cx="12" cy="15" r="5.4" />
    <path d="M9.6 14.4 h.01 M14.4 14.4 h.01" strokeWidth="2.6" />
    <path d="M10.2 16.8 q1.8 1.5 3.6 0" />
  </Svg>
);

/** 关闭：× */
export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M6 6 l12 12 M18 6 l-12 12" /></Svg>
);

/** 会话：对话气泡 */
export const IconChat = (p: IconProps) => (
  <Svg {...p}><path d="M4 5 h16 v11 h-9 l-4 3 v-3 h-3 Z" /><path d="M8.5 10.5 h.01 M12 10.5 h.01 M15.5 10.5 h.01" /></Svg>
);

/** 发送：纸飞机 */
export const IconSend = (p: IconProps) => (
  <Svg {...p}><path d="M20 4 L3 11 l7 2.5 L12.5 20 Z" /><path d="M10 13.5 L20 4" /></Svg>
);

/** 停止：方块 */
export const IconStop = (p: IconProps) => (
  <Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2.5" /></Svg>
);

/** 复制：叠层矩形 */
export const IconCopy = (p: IconProps) => (
  <Svg {...p}><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8 V5 a2 2 0 0 0 -2 -2 H6 a2 2 0 0 0 -2 2 v8 a2 2 0 0 0 2 2 h2" /></Svg>
);

/** 刷新：循环箭头 */
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M20 12 a8 8 0 1 1 -2.34 -5.66" /><path d="M20 3 v4 h-4" /></Svg>
);

/** 下载：箭头入托盘 */
export const IconDownload = (p: IconProps) => (
  <Svg {...p}><path d="M12 4 v10 M8 10 l4 4 4 -4" /><path d="M4 18 h16" /></Svg>
);

/** 搜索：放大镜 */
export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="M16 16 l5 5" /></Svg>
);

/** 加号 */
export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M12 5 v14 M5 12 h14" /></Svg>
);

/** 更多：水平三点 */
export const IconMore = (p: IconProps) => (
  <Svg {...p}><path d="M5 12 h.01 M12 12 h.01 M19 12 h.01" strokeWidth="3" /></Svg>
);

/** 终端：命令行提示符 */
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M7 9.5 l3 2.5 -3 2.5" /><path d="M13 14.5 h4" /></Svg>
);

/** 对勾 */
export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="M4.5 12.5 l5 5 10 -11" /></Svg>
);

/** 警告：三角感叹号 */
export const IconWarn = (p: IconProps) => (
  <Svg {...p}><path d="M12 3.5 L22 20 H2 Z" /><path d="M12 10 v4.5" /><path d="M12 17.5 h.01" /></Svg>
);

/** 面板：分栏矩形（轨迹面板开关） */
export const IconPanel = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M15 4.5 v15" /></Svg>
);

/** 下箭头（chevron） */
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="M6 9.5 l6 6 6 -6" /></Svg>
);

/** 右箭头（chevron） */
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="M9.5 6 l6 6 -6 6" /></Svg>
);

/** 展开：对角箭头 */
export const IconExpand = (p: IconProps) => (
  <Svg {...p}><path d="M9 4 H4 v5" /><path d="M15 4 h5 v5" /><path d="M9 20 H4 v-5" /><path d="M15 20 h5 v-5" /></Svg>
);

/** 收缩：对角箭头 */
export const IconShrink = (p: IconProps) => (
  <Svg {...p}><path d="M9 9 H4 M9 9 V4" /><path d="M15 9 h5 M15 9 V4" /><path d="M9 15 H4 M9 15 v5" /><path d="M15 15 h5 M15 15 v5" /></Svg>
);

/** 同步：双向箭头 */
export const IconSync = (p: IconProps) => (
  <Svg {...p}><path d="M4 12 a8 8 0 0 1 14 -5" /><path d="M18 3 v4 h-4" /><path d="M20 12 a8 8 0 0 1 -14 5" /><path d="M6 21 v-4 h4" /></Svg>
);

/** Git 分支 */
export const IconGitBranch = (p: IconProps) => (
  <Svg {...p}><circle cx="6" cy="5.5" r="2.2" /><circle cx="6" cy="18.5" r="2.2" /><circle cx="17.5" cy="7" r="2.2" /><path d="M6 7.7 v8.6" /><path d="M17.5 9.2 c0 5 -5.5 3.5 -7.5 4.5" /></Svg>
);

/** 星芒：品牌装饰 */
export const IconSpark = (p: IconProps) => (
  <Svg {...p}><path d="M12 3 l1.8 5.2 L19 10 l-5.2 1.8 L12 17 l-1.8 -5.2 L5 10 l5.2 -1.8 Z" /><path d="M19 15.5 l0.9 2.6 2.6 0.9 -2.6 0.9 -0.9 2.6 -0.9 -2.6 -2.6 -0.9 2.6 -0.9 Z" /></Svg>
);

/** 工作区：盒子（文件页工作区标识） */
export const IconBox = (p: IconProps) => (
  <Svg {...p}><path d="M12 3 L20 7 v10 L12 21 L4 17 V7 Z" /><path d="M4 7 l8 4 8 -4" /><path d="M12 11 v10" /></Svg>
);

/** 文件：单页文档 */
export const IconFileText = (p: IconProps) => (
  <Svg {...p}><path d="M7 3 h7 l5 5 v13 a1 1 0 0 1 -1 1 H7 a1 1 0 0 1 -1 -1 V4 a1 1 0 0 1 1 -1 Z" /><path d="M14 3 v5 h5" /><path d="M9 12 h6 M9 15.5 h6" /></Svg>
);
