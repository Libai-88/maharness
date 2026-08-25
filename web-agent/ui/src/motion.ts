// ui/src/motion.ts —— maharness 动效系统（Motion 共享配置与 variants）
// 对齐 2026 产品动效实践（Linear / Raycast / Claude 精工）：
//   - 进入一律 ease-out（ease-in 开头慢，用户会感到延迟）
//   - 常规时长 ≤300ms；页面级 / 仪式感可到 400-600ms
//   - 只动 transform / opacity（GPU 合成，避免布局抖动）
//   - prefers-reduced-motion 由 <MotionConfig reducedMotion="user"> 全局兜底
import type { Variants } from 'motion/react';

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;
export const EASE_EMPH = [0.2, 0, 0, 1] as const;

export const DUR = {
  fast: 0.12,    // 微交互 / hover / 反馈
  base: 0.2,     // 下拉 / 开关 / 标签
  med: 0.28,     // 弹层 / 抽屉 / 工具卡
  slow: 0.4,     // 页面过渡
  slower: 0.6,   // 入场 choreography（首屏 / 仪式感）
} as const;

/** 页面级切换：淡入上移 + 轻 blur（进入），淡出（退出）——操作型界面保持扫描速度 */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 14, filter: 'blur(4px)' },
  enter: {
    opacity: 1, y: 0, filter: 'blur(0px)',
    transition: { duration: DUR.slow, ease: EASE_OUT },
  },
  exit: {
    opacity: 0, y: -8, filter: 'blur(2px)',
    transition: { duration: DUR.base, ease: EASE_IN_OUT },
  },
};

/** stagger 容器：子元素依次揭示（choreography 编排） */
export const staggerContainer: Variants = {
  initial: {},
  enter: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
  exit: {},
};

/** 单项上浮揭示 */
export const fadeUp: Variants = {
  initial: { opacity: 0, y: 12 },
  enter: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

/** 消息行：assistant 淡入上移微缩放 / user 从右滑入；退出快速淡出 */
export const msgRow: Variants = {
  initial: { opacity: 0, y: 10, scale: 0.99 },
  enter: { opacity: 1, y: 0, scale: 1, transition: { duration: DUR.med, ease: EASE_OUT } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.16, ease: EASE_OUT } },
};

export const userMsg: Variants = {
  initial: { opacity: 0, x: 24 },
  enter: { opacity: 1, x: 0, transition: { duration: DUR.med, ease: EASE_OUT } },
  exit: { opacity: 0, x: 12, transition: { duration: 0.16 } },
};

/** 工具卡：pop-in（新工具出现） */
export const toolCardIn: Variants = {
  initial: { opacity: 0, y: 8, scale: 0.97 },
  enter: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.22, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.14 } },
};

/** 弹层 / 菜单：origin-aware scale-in（从触发器位置缩放展开，勿从中心冒出） */
export const popIn: Variants = {
  initial: { opacity: 0, scale: 0.96, y: -4 },
  enter: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.16, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.97, y: -2, transition: { duration: 0.1, ease: EASE_OUT } },
};

/** 抽屉 / 面板：从右侧滑入 */
export const drawerIn: Variants = {
  initial: { opacity: 0, x: 28 },
  enter: { opacity: 1, x: 0, transition: { duration: DUR.med, ease: EASE_OUT } },
  exit: { opacity: 0, x: 24, transition: { duration: 0.16, ease: EASE_IN_OUT } },
};

/** 完成态图标 spring 弹出（工具完成 / 勾选确认） */
export const springPop = { scale: [0.5, 1.2, 1] } as const;
export const springTransition = { type: 'spring', stiffness: 520, damping: 22, mass: 0.6 } as const;
