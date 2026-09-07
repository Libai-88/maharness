// ui/src/components/BrandLogo.tsx —— maharness 品牌徽章 v7「蓬蓬蜡笔涂鸦羊 · 手账贴纸」
// 自研原创图形语言（非图标库）：
//   1. M 角双关 —— 羊角外卷成品牌首字母 M（maharness × 羊角）；
//   2. 蓬蓬羊毛云 —— 有机多段圆弧，纯手绘感（弃几何六边形脸）；
//   3. 终端光标眼 —— 品牌基因（代码在思考），闪烁与眨眼同节奏；
//   4. 上扬嘴角 + 代码括号颊（{ }）；
//   5. 能量火花 —— 角尖迸发（手绘涂鸦小星星）；
//   6. 轨道环 —— 蜡笔虚线轨迹（运行轨迹 = harness 全程可观测），缓慢旋转；
//   7. 蜡笔抖动 —— feTurbulence 位移滤镜让所有笔触带手绘毛边（滤镜自包含）。
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
    <div className="brand-logo" style={{ width: size, height: size }} aria-label="maharness 品牌标志（蓬蓬蜡笔涂鸦羊）">
      <svg viewBox="0 0 120 120" width={size} height={size} fill="none">
        <defs>
          <linearGradient id="mh-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accent)" />
            <stop offset="0.55" stopColor="var(--orange)" />
            <stop offset="1" stopColor="var(--teal)" />
          </linearGradient>
          <linearGradient id="mh-wool" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.26" />
            <stop offset="1" stopColor="var(--teal)" stopOpacity="0.12" />
          </linearGradient>
          <filter id="mh-wobble" x="-12%" y="-12%" width="124%" height="124%">
            <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="3" seed="7" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>

        {/* 轨道环：蜡笔虚线（探索轨迹 · harness 全程可观测），缓慢旋转 */}
        <g filter="url(#mh-wobble)">
          <circle cx="60" cy="60" r="52" stroke="url(#mh-ring)" strokeOpacity="0.55" strokeWidth="2.4" strokeDasharray="8 11" strokeLinecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="16s" repeatCount="indefinite" />
          </circle>
          <circle cx="60" cy="60" r="44" stroke="var(--accent)" strokeOpacity="0.2" strokeWidth="1.6" strokeDasharray="2 9" strokeLinecap="round" />
        </g>

        {/* 能量火花 ×3（蜡笔小星星，交替闪烁 = 活力） */}
        <g fill="var(--teal)" filter="url(#mh-wobble)">
          <path d="M18 22 l.9 2.6 2.6 .9 -2.6 .9 -.9 2.6 -.9 -2.6 -2.6 -.9 2.6 -.9 Z">
            <animate attributeName="opacity" values="0.35;1;0.35" dur="1.7s" repeatCount="indefinite" />
          </path>
          <path d="M102 22 l.9 2.6 2.6 .9 -2.6 .9 -.9 2.6 -.9 -2.6 -2.6 -.9 2.6 -.9 Z">
            <animate attributeName="opacity" values="0.35;1;0.35" dur="1.7s" begin="0.85s" repeatCount="indefinite" />
          </path>
          <path d="M100 90 l.7 2 2 .7 -2 .7 -.7 2 -.7 -2 -2 -.7 2 -.7 Z">
            <animate attributeName="opacity" values="0.3;1;0.3" dur="2.3s" begin="0.4s" repeatCount="indefinite" />
          </path>
        </g>

        {/* 蓬蓬羊毛身体：有机云朵轮廓（蜡笔填充） */}
        <path
          d="M34 64 C 28 70 30 82 40 84 C 42 92 50 94 54 88 C 56 94 64 94 66 88 C 70 94 78 92 80 84 C 90 82 92 70 86 64 C 92 56 90 46 82 44 C 78 34 66 32 60 38 C 54 32 42 34 38 44 C 30 46 28 56 34 64 Z"
          fill="url(#mh-wool)"
          stroke="url(#mh-ring)"
          strokeWidth="3.4"
          strokeLinejoin="round"
          filter="url(#mh-wobble)"
        />

        {/* M 角：双角外卷（M 双竖），蜡笔粗笔触 */}
        <g stroke="url(#mh-ring)" strokeLinecap="round" strokeLinejoin="round" filter="url(#mh-wobble)">
          <path d="M44 46 C 30 36 26 20 40 14 C 50 10 55 20 48 28" strokeWidth="5.2" />
          <path d="M76 46 C 90 36 94 20 80 14 C 70 10 65 20 72 28" strokeWidth="5.2" />
        </g>

        {/* 终端光标眼（▍▍ 代码在思考，闪烁） */}
        <g stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" filter="url(#mh-wobble)">
          {blink ? (
            <path d="M48 62 h9 M63 62 h9" />
          ) : (
            <>
              <path d="M48 62 h9" />
              <path d="M63 62 h9" />
            </>
          )}
        </g>

        {/* 上扬大笑（蜡笔咧嘴） */}
        <path d="M50 71 q 10 9 20 0" stroke="var(--accent)" strokeWidth="3.4" strokeLinecap="round" filter="url(#mh-wobble)" />

        {/* 颊：代码括号 { } */}
        <g stroke="var(--text-3)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" filter="url(#mh-wobble)">
          <path d="M43 66 l-5 5 5 5" />
          <path d="M77 66 l5 5 -5 5" />
        </g>

        {/* 短腿 */}
        <g stroke="url(#mh-ring)" strokeWidth="3.6" strokeLinecap="round" filter="url(#mh-wobble)">
          <path d="M51 88 L 51 97" />
          <path d="M69 88 L 69 97" />
        </g>
      </svg>
    </div>
  );
}
