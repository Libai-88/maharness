// ui/src/components/BrandLogo.tsx —— maharness 品牌徽章（C 方向：负空间羊）
// 几何单一源：brand/sheep.ts（24 网格 ×5 放大到 120 viewBox），与 IconSheep / favicon 同一套 path。
// 大图专属的"涂鸦层"（轨道环 + 能量火花）保留，但羊本体与标志一致：
// 实心渐变羊毛 + M 角 + mask 挖空的终端光标眼（透明洞透出背景，双主题自适应）。
import { SHEEP_GRID, SHEEP_PATHS } from '../brand/sheep';

const SCALE = 120 / SHEEP_GRID;

export default function BrandLogo({ size = 120 }: { size?: number }) {
  const maskId = 'mh-blog-eye';
  return (
    <div className="brand-logo" style={{ width: size, height: size }} aria-label="maharness 品牌标志（负空间羊：羊毛 + M 角 + 光标眼）">
      <svg viewBox="0 0 120 120" width={size} height={size} fill="none">
        <defs>
          <linearGradient id="mh-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accent)" />
            <stop offset="0.55" stopColor="var(--orange)" />
            <stop offset="1" stopColor="var(--teal)" />
          </linearGradient>
          <linearGradient id="mh-wool" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--teal)" />
          </linearGradient>
          <filter id="mh-wobble" x="-12%" y="-12%" width="124%" height="124%">
            <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="3" seed="7" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>

        {/* 轨道环：蜡笔虚线（探索轨迹 = harness 全程可观测），缓慢旋转 */}
        <g filter="url(#mh-wobble)">
          <circle cx="60" cy="60" r="54" stroke="url(#mh-ring)" strokeOpacity="0.5" strokeWidth="2.2" strokeDasharray="8 12" strokeLinecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="16s" repeatCount="indefinite" />
          </circle>
          <circle cx="60" cy="60" r="46" stroke="var(--accent)" strokeOpacity="0.18" strokeWidth="1.5" strokeDasharray="2 9" strokeLinecap="round" />
        </g>

        {/* 羊本体：C 负空间——渐变实心羊毛 + mask 挖空光标眼（透明洞透出页面底色） */}
        <g transform={`translate(${(120 - SCALE * SHEEP_GRID) / 2} ${(120 - SCALE * SHEEP_GRID) / 2}) scale(${SCALE})`}>
          <mask id={maskId}>
            <rect width={SHEEP_GRID} height={SHEEP_GRID} fill="white" />
            <path d={SHEEP_PATHS.eyeBars} stroke="black" strokeWidth="2" strokeLinecap="round" />
          </mask>
          <g mask={`url(#${maskId})`} filter="url(#mh-wobble)">
            <path d={SHEEP_PATHS.wool} fill="url(#mh-wool)" />
          </g>
          <g fill="none" stroke="url(#mh-ring)" strokeWidth="2.3" strokeLinecap="round" filter="url(#mh-wobble)">
            <path d={SHEEP_PATHS.hornLSm} />
            <path d={SHEEP_PATHS.hornRSm} />
          </g>
        </g>

        {/* 能量火花 ×2（角尖上方，点缀层） */}
        <g fill="var(--teal)" filter="url(#mh-wobble)">
          <path d="M20 24 l.9 2.6 2.6 .9 -2.6 .9 -.9 2.6 -.9 -2.6 -2.6 -.9 2.6 -.9 Z">
            <animate attributeName="opacity" values="0.35;1;0.35" dur="1.7s" repeatCount="indefinite" />
          </path>
          <path d="M100 24 l.9 2.6 2.6 .9 -2.6 .9 -.9 2.6 -.9 -2.6 -2.6 -.9 2.6 -.9 Z">
            <animate attributeName="opacity" values="0.35;1;0.35" dur="1.7s" begin="0.85s" repeatCount="indefinite" />
          </path>
        </g>
      </svg>
    </div>
  );
}
