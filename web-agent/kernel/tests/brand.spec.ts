import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'src');

describe('品牌几何单一源（C 负空间方向落地后不得再漂移）', () => {
  it('IconSheep 消费 sheepSolidInner（不再手写 path）', () => {
    const icon = readFileSync(join(root, 'components', 'Icon.tsx'), 'utf-8');
    assert.match(icon, /sheepSolidInner/, 'Icon.tsx 必须引用品牌源');
    assert.doesNotMatch(icon, /M8\.6 16\.7 C 6\.6 17\.5/, 'Icon.tsx 不得再内嵌羊毛 path 副本');
  });

  it('BrandLogo 消费 SHEEP_PATHS（羊毛/角/眼同源）', () => {
    const logo = readFileSync(join(root, 'components', 'BrandLogo.tsx'), 'utf-8');
    assert.match(logo, /SHEEP_PATHS\.wool/);
    assert.match(logo, /SHEEP_PATHS\.hornLSm/);
    assert.match(logo, /SHEEP_PATHS\.eyeBars/);
    assert.doesNotMatch(logo, /<path d="M8\.6 16\.7/, 'BrandLogo 不得手写羊毛 path');
  });

  it('favicon 走 sheepSolidSvg 且颜色来自 token', () => {
    const fav = readFileSync(join(root, 'brand', 'favicon.ts'), 'utf-8');
    assert.match(fav, /sheepSolidSvg/);
    assert.match(fav, /getComputedStyle/);
    assert.doesNotMatch(fav, /e0512f/, '旧写死色不得回归');
  });

  it('sheep.ts 内 C 方向三元素齐备（羊毛/角/挖空眼）', () => {
    const src = readFileSync(join(root, 'brand', 'sheep.ts'), 'utf-8');
    assert.match(src, /export function sheepSolidInner/);
    assert.match(src, /mask/);
    assert.match(src, /EYE_BARS/);
    assert.match(src, /export const SHEEP_PATHS/);
  });
});
