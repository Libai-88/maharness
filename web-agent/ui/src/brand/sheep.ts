/**
 * ui/src/brand/sheep.ts —— 品牌图形单一源（24×24 网格）
 * 此前羊的图形有三份互不引用的手写副本（BrandLogo.tsx / Icon.tsx / index.html favicon），
 * 各自颜色与 path 漂移，小尺寸下糊成一团。这里收敛为一份 path：
 *   · full    ≥28px：完整细节（羊毛 + M 角 + 光标眼 + 笑 + 腿 + 火花）
 *   · compact <28px：只留三个可辨识元素（羊毛轮廓 + M 角 + 单眼光标），16px 仍读得出是羊
 *   · mark    favicon/单色场景：实心剪影
 * 一律 currentColor / CSS 变量，不写死颜色，深浅主题与品牌色自动跟随。
 */

export const SHEEP_GRID = 24;

/** 蓬松羊毛：多段波浪云朵轮廓（品牌身体） */
const WOOL = 'M8.6 16.7 C 6.6 17.5 4.9 16.4 4.7 14.8 C 3.2 14.2 2.6 12.4 3.7 11.4 C 3.4 9.6 5 8.2 6.7 8.5 C 7.7 6.9 10 6.4 11.4 7.6 C 12.8 6.2 15.2 6.6 16 8.2 C 18 7.9 19.7 9.4 19.4 11.3 C 20.6 12.3 20 14.2 18.4 14.8 C 18.1 16.5 16.3 17.6 14.5 16.9 C 13.9 17.9 11.9 17.9 11.3 16.9 C 10.4 17.4 9 17.4 8.6 16.7 Z';

/** M 形双角（maharness 首字母 × 羊角双关） */
const HORN_L = 'M9 8.3 C 6.4 7 5.2 4.6 6.8 3.2 C 8 2.2 9.4 3.2 9.2 5';
const HORN_R = 'M15 8.3 C 17.6 7 18.8 4.6 17.2 3.2 C 16 2.2 14.6 3.2 14.8 5';
/** 压缩版双角：笔顺更短、开口更大，小尺寸不糊 */
const HORN_L_SM = 'M9.1 8.2 C 7 7.2 6.1 5.1 7.3 3.9';
const HORN_R_SM = 'M14.9 8.2 C 17 7.2 17.9 5.1 16.7 3.9';

/** 终端光标眼（代码在思考） */
const EYES = 'M9.7 11.3 h2.1 M12.6 11.3 h2.1';
/** 单眼光标（compact）：一个竖条，16px 下是唯一的"眼睛"信号 */
const EYE_SM = 'M11.1 10.6 v2.6';
const SMILE = 'M10.3 13.2 q 1.8 1.4 3.4 0';
const LEGS = 'M9.7 17.1 L 9.7 20 M14.3 17.1 L 14.3 20';
const LEGS_SM = 'M10.2 17.2 L 10.2 19.4 M13.8 17.2 L 13.8 19.4';
/** 角尖能量火花（四角星） */
const SPARK_L = 'M4 3.6 l.6 1.7 1.7 .6 -1.7 .6 -.6 1.7 -.6 -1.7 -1.7 -.6 1.7 -.6 Z';
const SPARK_R = 'M20 3.6 l.6 1.7 1.7 .6 -1.7 .6 -.6 1.7 -.6 -1.7 -1.7 -.6 1.7 -.6 Z';

export interface SheepParts {
  wool: string;
  hornL: string;
  hornR: string;
  eyes: string;
  smile?: string;
  legs: string;
  sparks?: [string, string];
  /** 各部件推荐描边宽度（24 网格） */
  stroke: { wool: number; horn: number; eyes: number; smile: number; legs: number };
  /** 羊毛是否实心填充（compact/mark 用实心保证小尺寸辨识） */
  solid: boolean;
}

/** ≥28px：完整细节 */
export const SHEEP_FULL: SheepParts = {
  wool: WOOL, hornL: HORN_L, hornR: HORN_R, eyes: EYES, smile: SMILE, legs: LEGS,
  sparks: [SPARK_L, SPARK_R],
  stroke: { wool: 1.6, horn: 1.7, eyes: 2, smile: 1.5, legs: 1.8 },
  solid: false,
};

/** <28px（侧栏 17px / 头像 16px）：三元素可辨识版 */
export const SHEEP_COMPACT: SheepParts = {
  wool: WOOL, hornL: HORN_L_SM, hornR: HORN_R_SM, eyes: EYE_SM, legs: LEGS_SM,
  stroke: { wool: 1.8, horn: 2, eyes: 2.2, smile: 0, legs: 2 },
  solid: false,
};

/** favicon / 单色剪影：羊毛实心，靠 M 角与光标辨认 */
export const SHEEP_MARK: SheepParts = {
  wool: WOOL, hornL: HORN_L_SM, hornR: HORN_R_SM, eyes: EYE_SM, legs: LEGS_SM,
  stroke: { wool: 1.4, horn: 2.2, eyes: 2.4, smile: 0, legs: 2.2 },
  solid: true,
};

/** 小尺寸阈值：低于此值用 compact 部件 */
export const SHEEP_COMPACT_BELOW = 28;

export const pickSheep = (size: number): SheepParts => (size < SHEEP_COMPACT_BELOW ? SHEEP_COMPACT : SHEEP_FULL);

/** 生成独立 SVG 字符串（favicon/静态资源用），颜色写死为两套 + prefers-color-scheme */
export function sheepSvg(opts: { fg: string; bg?: string; size?: number; parts?: SheepParts }): string {
  const { fg, bg = 'transparent', size = 24, parts = SHEEP_MARK } = opts;
  const inner = parts.wool;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHEEP_GRID} ${SHEEP_GRID}" width="${size}" height="${size}">
<rect width="${SHEEP_GRID}" height="${SHEEP_GRID}" rx="5.5" fill="${bg}"/>
<g fill="${parts.solid ? fg : 'none'}" fill-opacity="${parts.solid ? 1 : 0.12}" stroke="${fg}" stroke-width="${parts.stroke.wool}" stroke-linejoin="round"><path d="${inner}"/></g>
<g fill="none" stroke="${fg}" stroke-width="${parts.stroke.horn}" stroke-linecap="round"><path d="${parts.hornL}"/><path d="${parts.hornR}"/></g>
<g fill="none" stroke="${fg}" stroke-width="${parts.stroke.eyes}" stroke-linecap="round"><path d="${parts.eyes}"/></g>
${parts.smile ? `<path d="${parts.smile}" fill="none" stroke="${fg}" stroke-width="${parts.stroke.smile}" stroke-linecap="round"/>` : ''}
<g fill="none" stroke="${fg}" stroke-width="${parts.stroke.legs}" stroke-linecap="round"><path d="${parts.legs}"/></g>
</svg>`;
}
