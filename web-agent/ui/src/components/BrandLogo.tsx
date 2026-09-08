// ui/src/components/BrandLogo.tsx —— maharness 品牌徽章（首页大图）
// 几何单一源：brand/sheep.ts 的 SHEEP_FULL，按 5× 缩放进 120 viewBox——
// 与侧栏/头像/ favicon 共用同一套 path，只在尺寸够大时叠加品牌装饰：
//   轨道环（harness 全程可观测）、蜡笔渐变描边、抖动毛边滤镜、代码括号颊、眨眼。
// 颜色全部走 CSS 变量 token（--accent/--orange/--teal/--text-3），双主题自适应。
import { useEffect, useState } from 'react';
import { SHEEP_FULL, SHEEP_GRID } from '../brand/sheep';

const SCALE = 120 / SHEEP_GRID;

export default function BrandLogo({ size = 120 }: { size?: number }) {
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setBlink((v) => !v), 1400);
    return () => clearInterval(t);
  }, []);
  const s = SHEEP_FULL;
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

        {/* 轨道环：蜡笔虚线（探索轨迹 = harness 全程可观测），缓慢旋转 */}
        <g filter="url(#mh-wobble)">
          <circle cx="60" cy="60" r="54" stroke="url(#mh-ring)" strokeOpacity="0.5" strokeWidth="2.2" strokeDasharray="8 12" strokeLinecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="16s" repeatCount="indefinite" />
          </circle>
          <circle cx="60" cy="60" r="46" stroke="var(--accent)" strokeOpacity="0.18" strokeWidth="1.5" strokeDasharray="2 9" strokeLinecap="round" />
        </g>

        {/* 角尖能量火花（交替闪烁） */}
        <g fill="var(--teal)" filter="url(#mh-wobble)" transform={`scale(${SCALE})`}>
          {s.sparks?.map((d, i) => (
            <path key={i} d={d} stroke="none">
              <animate attributeName="opacity" values="0.35;1;0.35" dur={i === 2 ? '2.3s' : '1.7s'} begin={`${i * 0.45}s`} repeatCount="indefinite" />
            </path>
          ))}
        </g>

        {/* 羊本体：与 IconSheep / favicon 同一套 path */}
        <g transform={`scale(${SCALE})`} strokeLinecap="round" strokeLinejoin="round" filter="url(#mh-wobble)">
          <path d={s.wool} fill="url(#mh-wool)" stroke="url(#mh-ring)" strokeWidth={s.stroke.wool} />
          <g stroke="url(#mh-ring)" strokeWidth={s.stroke.horn}>
            <path d={s.hornL} />
            <path d={s.hornR} />
          </g>
          <g stroke="var(--accent)" strokeWidth={blink ? s.stroke.eyes : s.stroke.eyes * 0.62}>
            {blink
              ? <path d="M9.7 11.3 h2.1 M12.6 11.3 h2.1" />
              : <path d={s.eyes} />}
          </g>
          {s.smile && <path d={s.smile} stroke="var(--accent)" strokeWidth={s.stroke.smile} />}
          <g stroke="url(#mh-ring)" strokeWidth={s.stroke.legs}>
            <path d={s.legs} />
          </g>
          {/* 品牌装饰：代码括号颊（仅大图出现） */}
          <g stroke="var(--text-3)" strokeWidth="0.9" fill="none">
            <path d="M8.6 13.4 l-1.4 1.4 1.4 1.4" />
            <path d="M15.4 13.4 l1.4 1.4 -1.4 1.4" />
          </g>
        </g>
      </svg>
    </div>
  );
}
