// ui/src/components/BrandLogo.tsx —— maharness 品牌徽章（羊主题 × 终端）
// 自研 SVG：几何羊头（卷毛螺旋 + 弯角）+ 终端光标眼睛（闪烁 = 代码在思考）
// 双主题自适应：全部颜色走 CSS 变量
import { useEffect, useState } from 'react';

export default function BrandLogo({ size = 120 }: { size?: number }) {
  const [blink, setBlink] = useState(false);
  // 眨眼：光标式闪烁（与终端光标同节奏）
  useEffect(() => {
    const t = setInterval(() => setBlink((v) => !v), 1400);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="brand-logo" style={{ width: size, height: size }} aria-label="maharness 品牌标志（羊）">
      <svg viewBox="0 0 120 120" width={size} height={size} fill="none">
        <defs>
          <linearGradient id="bh-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--purple)" />
          </linearGradient>
          <linearGradient id="bh-wool" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.30" />
            <stop offset="1" stopColor="var(--purple)" stopOpacity="0.12" />
          </linearGradient>
        </defs>

        {/* 外环：品牌渐变虚线环（科技感呼吸旋转） */}
        <circle cx="60" cy="62" r="52" stroke="url(#bh-ring)" strokeOpacity="0.45" strokeWidth="1.6" strokeDasharray="4 6">
          <animateTransform attributeName="transform" type="rotate" from="0 60 62" to="360 60 62" dur="28s" repeatCount="indefinite" />
        </circle>
        <circle cx="60" cy="62" r="44" stroke="var(--accent)" strokeOpacity="0.14" strokeWidth="1" />

        {/* 羊角：弯月 ×2（外粗内细） */}
        <path d="M37 42 C 25 36, 19 18, 31 11 C 40 8.5, 45 19, 43 30" stroke="var(--accent)" strokeWidth="4.2" strokeLinecap="round" />
        <path d="M83 42 C 95 36, 101 18, 89 11 C 80 8.5, 75 19, 77 30" stroke="var(--accent)" strokeWidth="4.2" strokeLinecap="round" />

        {/* 卷毛：顶部三撮螺旋 */}
        <g stroke="url(#bh-ring)" strokeWidth="2.4" strokeLinecap="round">
          <circle cx="41" cy="45" r="8.5" fill="url(#bh-wool)" />
          <circle cx="60" cy="39" r="10.5" fill="url(#bh-wool)" />
          <circle cx="79" cy="45" r="8.5" fill="url(#bh-wool)" />
          <path d="M41 39 a4.5 4.5 0 0 1 4.5 -4.5" />
          <path d="M60 31.5 a5.5 5.5 0 0 1 5.5 -5.5" />
          <path d="M79 39 a4.5 4.5 0 0 1 4.5 -4.5" />
        </g>

        {/* 脸：柔和填充 + 轮廓 */}
        <circle cx="60" cy="68" r="25" fill="var(--accent)" fillOpacity="0.09" stroke="var(--accent)" strokeWidth="2.4" />

        {/* 终端光标眼睛（▍▍：代码在思考，闪烁） */}
        {blink ? (
          <path d="M49 64 h9 M62 64 h9" stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round" />
        ) : (
          <g stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round">
            <path d="M49 64 h9" />
            <path d="M62 64 h9" />
          </g>
        )}

        {/* 微笑 */}
        <path d="M52 74.5 q8 5.5 16 0" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" />

        {/* 脸上的代码痕（{ }） */}
        <path d="M56.5 58.5 l-2.5 2.5 2.5 2.5" stroke="var(--text-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M63.5 58.5 l2.5 2.5 -2.5 2.5" stroke="var(--text-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
