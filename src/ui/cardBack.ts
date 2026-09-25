import { pixelGlyphRects } from './pixelFont';

/**
 * 程序化 Art Deco 牌背（参考 img/01.png）：
 * 上半部分绘制后以 180° 旋转复制，得到扑克牌式的中心对称。
 */
export function cardBackSvg(bg: string, ink: string, monogram: string): string {
  const W = 250;
  const H = 350;
  const cx = W / 2;
  const cy = H / 2;
  const sw = 1.3;

  const half: string[] = [];
  // 顶部角落扇形（以内框角为圆心的同心四分之一圆）
  for (const side of [-1, 1]) {
    const x = side < 0 ? 16 : W - 16;
    for (const r of [16, 25, 34]) {
      half.push(`<path d="M ${x - side * r} 16 A ${r} ${r} 0 0 ${side < 0 ? 1 : 0} ${x} ${16 + r}" />`);
    }
  }
  // 顶部锯齿带（两层）
  const zigzag = (y0: number, y1: number) => {
    let d = `M 62 ${y0}`;
    for (let i = 0; i < 12; i++) d += ` L ${62 + (i + 0.5) * 10.5} ${i % 2 === 0 ? y1 : y0}`;
    return d;
  };
  half.push(`<path d="${zigzag(30, 58)}" />`);
  half.push(`<path d="${zigzag(38, 66)}" opacity="0.6"/>`);
  // 顶部中央「8」形标签
  half.push(`<rect x="${cx - 13}" y="22" width="26" height="46" fill="${bg}" />`);
  half.push(`<circle cx="${cx}" cy="36" r="6" /><circle cx="${cx}" cy="52" r="7" />`);
  // 两侧点线柱
  for (const x of [34, W - 34]) {
    half.push(`<line x1="${x}" y1="80" x2="${x}" y2="${cy - 20}" />`);
    for (let y = 90; y < cy - 20; y += 18) half.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="${bg}"/>`);
  }
  // 放射状斜线（中央菱形上方）
  for (let i = -5; i <= 5; i++) {
    half.push(`<line x1="${cx + i * 11}" y1="78" x2="${cx + i * 3}" y2="${cy - 58}" opacity="0.8"/>`);
  }
  // 上方三角
  half.push(`<path d="M ${cx - 10} 74 L ${cx} 86 L ${cx + 10} 74 Z" fill="${ink}" />`);

  const halfG = half.join('');
  const pixelSize = 26;

  return `
<svg class="card-back-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="0" y="0" width="${W}" height="${H}" rx="16" fill="${bg}"/>
  <g fill="none" stroke="${ink}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">
    <rect x="7" y="7" width="${W - 14}" height="${H - 14}" rx="11" stroke-width="2.6"/>
    <rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="3"/>
    <rect x="21" y="21" width="${W - 42}" height="${H - 42}" rx="2" opacity="0.55"/>
    ${[
      [16, 16],
      [W - 16, 16],
      [16, H - 16],
      [W - 16, H - 16],
    ]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.2" fill="${bg}"/>`)
      .join('')}
    <g>${halfG}</g>
    <g transform="rotate(180 ${cx} ${cy})">${halfG}</g>

    <!-- 中央倾斜矩形与侧翼菱形 -->
    <rect x="${cx - 62}" y="${cy - 74}" width="124" height="148" transform="rotate(-8 ${cx} ${cy})"/>
    <path d="M ${cx - 96} ${cy} L ${cx - 60} ${cy - 38} L ${cx - 60} ${cy + 38} Z"/>
    <path d="M ${cx + 96} ${cy} L ${cx + 60} ${cy - 38} L ${cx + 60} ${cy + 38} Z"/>
    <path d="M ${cx - 84} ${cy} L ${cx - 66} ${cy - 18} L ${cx - 66} ${cy + 18} Z" fill="${ink}"/>
    <path d="M ${cx + 84} ${cy} L ${cx + 66} ${cy - 18} L ${cx + 66} ${cy + 18} Z" fill="${ink}"/>

    <!-- 徽章：圆角菱形 + 双圆 -->
    <rect x="${cx - 42}" y="${cy - 42}" width="84" height="84" rx="16" transform="rotate(45 ${cx} ${cy})" fill="${bg}"/>
    <circle cx="${cx}" cy="${cy}" r="36" />
    <circle cx="${cx}" cy="${cy}" r="30" opacity="0.6"/>
    ${[0, 90, 180, 270]
      .map((a) => {
        const r = (a * Math.PI) / 180;
        return `<circle cx="${cx + Math.cos(r) * 47}" cy="${cy + Math.sin(r) * 47}" r="2.4" fill="${ink}" stroke="none"/>`;
      })
      .join('')}
  </g>
  <g fill="${ink}" transform="translate(${cx - pixelSize / 2} ${cy - pixelSize / 2}) scale(${pixelSize / 5})">
    ${pixelGlyphRects(monogram)}
  </g>
</svg>`;
}
