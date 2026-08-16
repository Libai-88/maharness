// ui/src/components/BrandLogo.tsx —— maharness 品牌徽章 v2「M 角星羊 · 驭能环」
// 自研原创图形语言（非图标库）：
//   1. M 角双关 —— 羊角外卷成品牌首字母 M（maharness × 羊角），头顶 V 分界构成 M 中缝；
//   2. 积木脸 —— 圆角六边形（积木哲学：万物可组合、可重塑）；
//   3. 终端光标眼 —— 品牌基因（代码在思考），闪烁与眨眼同节奏；
//   4. 能量火花 —— 角尖迸发（年轻活力：探索未至之境、以行动改变世界）；
//   5. 轨道环 —— 渐变虚线轨迹（运行轨迹 = harness 全程可观测），缓慢旋转。
// 双主题自适应：全部颜色走 CSS 变量 / 品牌渐变 token。
import { useEffect, useState } from 'react';

export default function BrandLogo({ size = 120 }: { size?: number }) {
  const [blink, setBlink] = useState(false);
  // 眨眼：光标式闪烁（与终端光标同节奏）
  useEffect(() => {
    const t = setInterval(() => setBlink((v) => !v), 1400);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="brand-logo" style={{ width: size, height: size }} aria-label="maharness 品牌标志（M 角星羊）">
      <svg viewBox="0 0 120 120" width={size} height={size} fill="none">
        <defs>
          <linearGradient id="mh-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accent)" />
            <stop offset="0.55" stopColor="var(--purple)" />
            <stop offset="1" stopColor="var(--teal)" />
          </linearGradient>
          <linearGradient id="mh-face" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--purple)" stopOpacity="0.10" />
          </linearGradient>
        </defs>

        {/* 轨道环：品牌渐变虚线（探索轨迹 · harness 全程可观测），缓慢旋转 */}
        <circle cx="60" cy="60" r="50" stroke="url(#mh-ring)" strokeOpacity="0.5" strokeWidth="1.8" strokeDasharray="5 7">
          <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="16s" repeatCount="indefinite" />
        </circle>
        <circle cx="60" cy="60" r="42" stroke="var(--accent)" strokeOpacity="0.15" strokeWidth="1" />

        {/* 能量火花 ×2（角尖迸发，交替闪烁 = 活力） */}
        <g fill="var(--teal)">
          <path d="M16 22 l.9 2.6 2.6 .9 -2.6 .9 -.9 2.6 -.9 -2.6 -2.6 -.9 2.6 -.9 Z">
            <animate attributeName="opacity" values="0.35;1;0.35" dur="1.7s" repeatCount="indefinite" />
          </path>
          <path d="M104 22 l.9 2.6 2.6 .9 -2.6 .9 -.9 2.6 -.9 -2.6 -2.6 -.9 2.6 -.9 Z">
            <animate attributeName="opacity" values="0.35;1;0.35" dur="1.7s" begin="0.85s" repeatCount="indefinite" />
          </path>
        </g>

        {/* M 角：双角外卷（M 双竖）+ 头顶 V 分界（M 中缝）= 首字母 × 羊角 */}
        <g stroke="url(#mh-ring)" strokeLinecap="round" strokeLinejoin="round">
          <path d="M36 51 C 24 43, 17 29, 26 20 C 32 14.5, 40 20, 38.5 30" strokeWidth="5" />
          <path d="M84 51 C 96 43, 103 29, 94 20 C 88 14.5, 80 20, 81.5 30" strokeWidth="5" />
          <path d="M38.5 32 L 60 23 L 81.5 32" strokeWidth="4" />
        </g>

        {/* 积木脸：圆角六边形（可组合 · 可重塑） */}
        <path d="M40 55 L 60 48 L 80 55 L 80 79 L 60 87 L 40 79 Z" fill="url(#mh-face)" stroke="url(#mh-ring)" strokeWidth="2.6" strokeLinejoin="round" />

        {/* 终端光标眼（▍▍ 代码在思考，闪烁） */}
        {blink ? (
          <path d="M48 63 h10 M62 63 h10" stroke="var(--accent)" strokeWidth="3.6" strokeLinecap="round" />
        ) : (
          <g stroke="var(--accent)" strokeWidth="3.6" strokeLinecap="round">
            <path d="M48 63 h10" />
            <path d="M62 63 h10" />
          </g>
        )}

        {/* 上扬微笑（年轻活力） */}
        <path d="M50 73 q 10 8 20 0" stroke="var(--accent)" strokeWidth="2.8" strokeLinecap="round" />

        {/* 颊：代码括号 { } */}
        <g stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M42.5 64.5 l-4 4 4 4" />
          <path d="M77.5 64.5 l4 4 -4 4" />
        </g>
      </svg>
    </div>
  );
}
