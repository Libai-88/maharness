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

/** 羊（品牌）：极简羊头 */
export const IconSheep = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 9 C 5 7.5 5 4.5 7.5 3.5 C 9 4.5 9 6 8.5 7.5" />
    <path d="M16 9 C 19 7.5 19 4.5 16.5 3.5 C 15 4.5 15 6 15.5 7.5" />
    <circle cx="8.5" cy="11" r="2.6" />
    <circle cx="15.5" cy="11" r="2.6" />
    <circle cx="12" cy="15" r="5" />
    <path d="M10 15 h1.5 l1 1.5 1.5 -2.5 1 1 h1.5" />
  </Svg>
);

/** 关闭：× */
export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M6 6 l12 12 M18 6 l-12 12" /></Svg>
);
