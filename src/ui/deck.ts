import type { Project } from '../config/site.config';
import { cardColors } from '../core/theme';
import { getLang } from '../core/i18n';
import { isTouch } from '../core/env';
import { clamp, damp, easeInOutCubic, easeOutCubic, range } from '../core/math';
import { cardBackSvg } from './cardBack';
import { pixelGlyphSvg } from './pixelFont';

/**
 * 项目牌：滚动时从扇形牌背依次翻面并排开（参考 img/01.png → img/02.png）。
 * 所有运动都经过 lerp 平滑；悬停时 3D 倾斜 + 眩光；投影方向由光源 A（鼠标光）决定。
 */

const CARD_INK = '#16121A';

type Pt = { x: number; y: number };

interface CardView {
  el: HTMLAnchorElement;
  flip: HTMLElement;
  tilt: HTMLElement;
  shadow: HTMLElement;
  list: HTMLUListElement;
  project: Project;
  color: string;
  tiltX: number;
  tiltY: number;
  targetX: number;
  targetY: number;
  hover: boolean;
  flipped: number;
  cx: number;
  cy: number;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class Deck {
  private cards: CardView[] = [];
  private progress = 0;
  private w = 240;
  private grid: { x: number; y: number }[] = [];

  constructor(private section: HTMLElement, private deckEl: HTMLElement, projects: Project[]) {
    projects.forEach((p, i) => this.cards.push(this.build(p, i)));
    this.renderPoints();
    this.layout();
  }

  private build(project: Project, i: number): CardView {
    const color = cardColors[i % cardColors.length];
    const el = document.createElement('a');
    el.className = 'card';
    el.href = project.url;
    el.target = '_blank';
    el.rel = 'noopener';
    el.style.setProperty('--card-color', color);
    el.setAttribute('aria-label', project.title);

    const title = escapeHtml(project.title);
    const glyph = pixelGlyphSvg(project.monogram, 'cf-glyph');
    el.innerHTML = `
      <div class="card-tilt">
        <div class="card-shadow"></div>
        <div class="card-flip">
          <div class="card-face card-back">${cardBackSvg(color, CARD_INK, project.monogram)}</div>
          <div class="card-face card-front">
            <div class="cf-head"><h3 class="cf-title">${title}</h3>${glyph}</div>
            <ul class="cf-list"></ul>
            <div class="cf-foot" aria-hidden="true"><span class="cf-title">${title}</span>${glyph}</div>
          </div>
        </div>
        <div class="card-glare"></div>
      </div>`;
    this.deckEl.appendChild(el);

    const view: CardView = {
      el,
      flip: el.querySelector('.card-flip')!,
      tilt: el.querySelector('.card-tilt')!,
      shadow: el.querySelector('.card-shadow')!,
      list: el.querySelector('.cf-list')!,
      project,
      color,
      tiltX: 0,
      tiltY: 0,
      targetX: 0,
      targetY: 0,
      hover: false,
      flipped: 0,
      cx: 0,
      cy: 0,
    };

    if (!isTouch) {
      el.addEventListener('pointermove', (e) => {
        const r = view.tilt.getBoundingClientRect();
        const nx = (e.clientX - r.left) / r.width - 0.5;
        const ny = (e.clientY - r.top) / r.height - 0.5;
        view.targetX = -ny * 16;
        view.targetY = nx * 18;
        view.tilt.style.setProperty('--gx', `${(nx + 0.5) * 100}%`);
        view.tilt.style.setProperty('--gy', `${(ny + 0.5) * 100}%`);
      });
      el.addEventListener('pointerenter', () => (view.hover = true));
      el.addEventListener('pointerleave', () => {
        view.hover = false;
        view.targetX = view.targetY = 0;
      });
    }
    return view;
  }

  renderPoints() {
    const lang = getLang();
    for (const c of this.cards) {
      c.list.innerHTML = c.project.points[lang].map((p) => `<li>${escapeHtml(p)}</li>`).join('');
    }
  }

  layout() {
    const vw = innerWidth;
    const vh = innerHeight;
    const n = this.cards.length;
    const pad = Math.max(20, vw * 0.05);
    const gap = Math.max(16, Math.min(40, vw * 0.02));
    const avail = Math.min(vw - pad * 2, 2000);

    let cols = Math.min(n, 4);
    let w = (avail - gap * (cols - 1)) / cols;
    // 窄屏减少列数，保持牌不小于 150px
    while (cols > 1 && w < 150) {
      cols--;
      w = (avail - gap * (cols - 1)) / cols;
    }
    const rows = Math.ceil(n / cols);
    // 牌组放在标题下方的剩余空间里居中
    const head = this.section.querySelector<HTMLElement>('.work-head');
    const headBottom = head ? head.offsetTop + head.offsetHeight : vh * 0.25;
    const areaH = vh - headBottom - Math.max(24, vh * 0.06);
    this.deckEl.style.setProperty('--deck-cy', `${headBottom + areaH / 2 + 12}px`);
    const maxH = (areaH * 0.9 - gap * (rows - 1)) / rows;
    w = clamp(Math.min(w, maxH / 1.4, 420), 120, 420);
    this.w = w;
    const h = w * 1.4;
    this.deckEl.style.setProperty('--card-w', `${w}px`);

    this.grid = this.cards.map((_, i) => {
      const r = Math.floor(i / cols);
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const c = i - r * cols;
      return {
        x: (c - (inRow - 1) / 2) * (w + gap),
        y: (r - (rows - 1) / 2) * (h + gap),
      };
    });
  }

  update(dt: number, lights: { a: Pt; b: Pt }, themeDark: number) {
    const rect = this.section.getBoundingClientRect();
    const vh = innerHeight;
    const scrollable = Math.max(1, rect.height - vh);
    const target = clamp(-rect.top / scrollable);
    this.progress = damp(this.progress, target, 6, dt);

    // 不在视口附近时跳过
    if (rect.bottom < -vh || rect.top > vh * 2) return;

    const p = this.progress;
    const n = this.cards.length;
    const mid = (n - 1) / 2;
    const enter = easeOutCubic(range(p, 0, 0.22));
    const stagger = Math.min(0.1, 0.3 / Math.max(1, n));

    this.cards.forEach((c, i) => {
      const k = i - mid;
      const fan = {
        x: k * this.w * 0.46,
        y: Math.abs(k) * Math.abs(k) * 8 + (1 - enter) * vh * 0.75,
        rz: k * 7 * (0.6 + enter * 0.4),
      };
      const lp = easeInOutCubic(range(p, 0.26 + i * stagger, 0.26 + i * stagger + 0.34));
      c.flipped = lp;
      const g = this.grid[i];
      const x = fan.x + (g.x - fan.x) * lp;
      const y = fan.y + (g.y - fan.y) * lp;
      const rz = fan.rz * (1 - lp);
      const lift = Math.sin(Math.PI * lp);
      c.el.style.transform = `translate3d(calc(-50% + ${x}px), calc(-50% + ${y}px), ${lift * 140}px) rotateZ(${rz}deg) scale(${1 + lift * 0.05})`;
      c.el.style.zIndex = String(lp > 0.5 ? 100 + i : n - Math.abs(Math.round(k)));
      c.flip.style.transform = `rotateY(${lp * 180}deg) rotateX(${lift * -10}deg)`;
      c.el.style.pointerEvents = lp > 0.98 ? 'auto' : 'none';
      // 显式隐藏朝后的一面：带混合模式的光照层不受 backface-visibility 约束
      c.el.classList.toggle('is-front', lp > 0.5);

      // 悬停倾斜（lerp）
      const active = c.hover && lp > 0.98;
      c.tiltX = damp(c.tiltX, active ? c.targetX : 0, 8, dt);
      c.tiltY = damp(c.tiltY, active ? c.targetY : 0, 8, dt);
      c.tilt.style.transform = `rotateX(${c.tiltX}deg) rotateY(${c.tiltY}deg) translateZ(${active ? 30 : 0}px)`;
      c.tilt.classList.toggle('is-hover', active);

      // 场景光照：两束光在牌面上的位置 → 彩色受光、背光面压暗、迎光边缘高光
      const box = c.el.getBoundingClientRect();
      c.cx = box.left + box.width / 2;
      c.cy = box.top + box.height / 2;
      const rel = (p: Pt) => [((p.x - box.left) / box.width) * 100, ((p.y - box.top) / box.height) * 100];
      const [ax, ay] = rel(lights.a);
      const [bx, by] = rel(lights.b);
      const dx = c.cx - lights.a.x;
      const dy = c.cy - lights.a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const st = c.el.style;
      st.setProperty('--ax', `${ax.toFixed(1)}%`);
      st.setProperty('--ay', `${ay.toFixed(1)}%`);
      st.setProperty('--bx', `${bx.toFixed(1)}%`);
      st.setProperty('--by', `${by.toFixed(1)}%`);
      st.setProperty('--shade-angle', `${((Math.atan2(dx, -dy) * 180) / Math.PI).toFixed(1)}deg`);
      st.setProperty('--rim-x', `${(-(dx / dist) * 1.5).toFixed(2)}px`);
      st.setProperty('--rim-y', `${(-(dy / dist) * 1.5).toFixed(2)}px`);

      // 深投影：影子朝远离光源 A 的方向投射，不随翻转镜像，只随牌的可见宽度收缩
      const len = Math.min(60, 16 + dist * 0.045) * (1 + lift);
      const alpha = 0.34 + (1 - themeDark) * 0.2 + themeDark * 0.3;
      // 阴影层推到牌面后方（旋转时牌面不会穿过它），翻转途中淡出
      const facing = Math.abs(Math.cos(lp * Math.PI));
      c.shadow.style.transform = `translateZ(-${this.w * 0.6}px) scale(${(1 + (this.w * 0.6) / 1800).toFixed(3)}) scaleX(${Math.max(0.04, facing)})`;
      c.shadow.style.opacity = (facing * facing).toFixed(3);
      c.shadow.style.boxShadow = `${((dx / dist) * len).toFixed(1)}px ${((dy / dist) * len).toFixed(1)}px ${46 + lift * 30}px rgba(6, 2, 12, ${alpha.toFixed(2)})`;
    });
  }
}
