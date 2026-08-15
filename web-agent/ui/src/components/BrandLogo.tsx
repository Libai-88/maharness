// ui/src/components/BrandLogo.tsx —— maharness 品牌 Logo（羊主题 × 终端）
// 自研 SVG：几何羊 + 终端光标眼睛（▍▍ 闪烁 = 代码在思考）+ 卷毛与弯角
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
        {/* 光环（科技感呼吸） */}
        <circle cx="60" cy="62" r="52" stroke="var(--accent)" strokeOpacity="0.25" strokeWidth="1.5" strokeDasharray="4 6">
          <animateTransform attributeName="transform" type="rotate" from="0 60 62" to="360 60 62" dur="24s" repeatCount="indefinite" />
        </circle>
        {/* 羊角（弯月 ×2） */}
        <path d="M38 40 C 26 34, 20 18, 32 12 C 40 10, 44 20, 42 30" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" />
        <path d="M82 40 C 94 34, 100 18, 88 12 C 80 10, 76 20, 78 30" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" />
        {/* 卷毛（顶部三撮） */}
        <circle cx="40" cy="44" r="9" fill="var(--accent)" fillOpacity="0.18" />
        <circle cx="60" cy="38" r="11" fill="var(--accent)" fillOpacity="0.22" />
        <circle cx="80" cy="44" r="9" fill="var(--accent)" fillOpacity="0.18" />
        {/* 身体 */}
        <circle cx="60" cy="68" r="26" fill="var(--accent)" fillOpacity="0.10" stroke="var(--accent)" strokeWidth="2.5" />
        {/* 终端光标眼睛（▍▍：代码在思考） */}
        {blink ? (
          <path d="M48 64 h8 M64 64 h8" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
        ) : (
          <>
            <path d="M48 64 h8" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
            <path d="M64 64 h8" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
          </>
        )}
        {/* 微笑 */}
        <path d="M52 74 q8 6 16 0" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
        {/* 身体上的代码痕（{ }） */}
        <path d="M55 58 l-3 3 3 3" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M65 58 l3 3 -3 3" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
