import './styles/main.css';
import Lenis from 'lenis';
import * as THREE from 'three';
import { siteConfig } from './config/site.config';
import { applyLang, onLangChange, t, toggleLang } from './core/i18n';
import { getTheme, onThemeChange, toggleTheme } from './core/theme';
import { NameRotator } from './core/nameRotator';
import { isTouch, motion } from './core/env';
import { clamp, damp, easeOutCubic, range, smoothstep } from './core/math';
import { Stage } from './gl/Stage';
import { Deck } from './ui/deck';
import { renderPlates, renderStatic } from './ui/content';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ── 内容
const rotators = siteConfig.people.map((p) => new NameRotator(p.names, siteConfig.nameRotateInterval));
renderStatic();
renderPlates(rotators);
const deck = new Deck($('#work'), $('#deck'), siteConfig.projects);

// ── 进入视口时显现
const io = new IntersectionObserver(
  (entries) => entries.forEach((en) => en.isIntersecting && en.target.classList.add('is-in')),
  { threshold: 0.25 },
);
document.querySelectorAll('.plate').forEach((el) => io.observe(el));
const revealTagline = () => {
  const tg = $('#tagline');
  tg.classList.remove('is-in');
  io.unobserve(tg);
  io.observe(tg);
};

const updateHint = () => {
  $('#hero-hint').textContent = t(isTouch ? 'hero.hintTouch' : 'hero.hint');
  $('.work-hint').textContent = t(isTouch ? 'work.hintTouch' : 'work.hint');
};
onLangChange(() => {
  renderStatic();
  deck.renderPoints();
  updateHint();
  revealTagline();
});
applyLang();
updateHint();
revealTagline();

$('#lang-toggle').addEventListener('click', toggleLang);
$('#theme-toggle').addEventListener('click', toggleTheme);

let themeTarget = getTheme() === 'dark' ? 1 : 0;
onThemeChange((th) => (themeTarget = th === 'dark' ? 1 : 0));

// ── 平滑滚动
const lenis = new Lenis({ lerp: motion.reduced ? 1 : 0.085, smoothWheel: true });
document.querySelectorAll<HTMLAnchorElement>('a[data-scroll]').forEach((a) =>
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (!id?.startsWith('#')) return;
    e.preventDefault();
    lenis.scrollTo(id === '#home' ? 0 : id, { duration: 1.6 });
  }),
);

// ── 指针（uv，y 向上）
let pointer: THREE.Vector2 | null = null;
const onPointer = (e: PointerEvent) => {
  pointer ??= new THREE.Vector2();
  pointer.set(e.clientX / innerWidth, 1 - e.clientY / innerHeight);
};
addEventListener('pointermove', onPointer, { passive: true });
addEventListener('pointerdown', onPointer, { passive: true });

// ── WebGL
let stage: Stage | null = null;
try {
  stage = new Stage($<HTMLCanvasElement>('#gl'));
  stage.theme = themeTarget;
} catch (err) {
  console.warn('WebGL unavailable', err);
  document.documentElement.classList.add('no-webgl');
}

const loaderNum = $('#loader-num');
const loaderBar = $('#loader-bar');
let loadTarget = stage ? 0.25 : 0.6;
let loadShown = 0;
let loaded = false;
let loadedAt = 0;
const t0 = performance.now();

const redrawNames = () => {
  const [a, b] = rotators;
  stage?.lightField.drawNames(a.display, b.display, Math.max(a.glitch, b.glitch));
};

const resize = () => {
  if (!stage) return deck.layout();
  stage.resize(innerWidth, innerHeight);
  stage.lightField.layout(siteConfig.people[0].names, siteConfig.people[1].names);
  redrawNames();
  deck.layout();
};

let namesDirty = true;
rotators.forEach((r) => r.subscribe(() => (namesDirty = true)));

// 字体加载完成后再绘制画布文字（中文字体按需分片，限时 4s）
const fontsReady = Promise.race([
  Promise.all([
    document.fonts.load('500 100px "Outfit"'),
    document.fonts.load('400 100px "Outfit"'),
    document.fonts.load('500 100px "Noto Sans SC"', siteConfig.people.flatMap((p) => p.names).join('')),
  ]),
  new Promise((r) => setTimeout(r, 4000)),
]);
fontsReady.then(() => {
  loadTarget = 0.85;
  resize();
  requestAnimationFrame(() => (loadTarget = 1));
});

let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(resize, 120);
});

/** 开场点亮：带两次克制的「打火」闪烁 */
const ignition = (x: number) => {
  const base = easeOutCubic(clamp(x));
  if (motion.reduced) return base;
  const dip = (c: number, w: number, d: number) => {
    const k = Math.abs(x - c) / w;
    return k < 1 ? d * (1 - k) : 0;
  };
  return Math.max(0, base - dip(0.18, 0.06, 0.5) - dip(0.36, 0.05, 0.35));
};

// ── 主循环
let last = performance.now();
let frame = 0;
const coordA = $('#coord-a');
const coordB = $('#coord-b');
const lightVarsTargets = [$('.nav-logo'), $('#plates')];

const tick = (now: number) => {
  requestAnimationFrame(tick);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const time = now / 1000;
  frame++;

  lenis.raf(now);
  rotators.forEach((r) => r.update(time));

  // 加载计数
  if (!loaded) {
    const minTime = clamp((now - t0) / 1400);
    loadShown = damp(loadShown, Math.min(loadTarget, minTime), 6, dt);
    if (loadTarget >= 1 && minTime >= 1 && loadShown > 0.995) loadShown = 1;
    loaderNum.textContent = String(Math.round(loadShown * 100)).padStart(3, '0');
    loaderBar.style.transform = `scaleX(${loadShown})`;
    if (loadShown >= 1) {
      loaded = true;
      loadedAt = time;
      $('#loader').classList.add('is-done');
    }
  }

  const toPx = (v: THREE.Vector2) => ({ x: v.x * innerWidth, y: (1 - v.y) * innerHeight });
  deck.update(
    dt,
    stage ? { a: toPx(stage.lightA), b: toPx(stage.lightB) } : { a: { x: innerWidth / 2, y: 0 }, b: { x: innerWidth, y: innerHeight } },
    themeTarget,
  );

  if (!stage) return;

  if (namesDirty) {
    redrawNames();
    namesDirty = false;
  }

  stage.power = loaded ? ignition((time - loadedAt) / 1.8) : 0;

  const vh = innerHeight;
  const heroMix = 1 - smoothstep(0.1, 0.85, scrollY / vh);
  const sceneRect = $('#scene').getBoundingClientRect();
  const sceneProgress = range(vh - sceneRect.top, 0, sceneRect.height + vh * 0.5);

  stage.render(time, dt, {
    pointer,
    heroMix,
    sceneProgress,
    themeTarget,
    glitch: Math.max(rotators[0].glitch, rotators[1].glitch),
  });

  // 让 DOM 中的光点与 WebGL 光源同步闪烁
  const [ia, ib] = stage.intensities;
  for (const el of lightVarsTargets) {
    el.style.setProperty('--ia', Math.min(1, ia / 0.72).toFixed(3));
    el.style.setProperty('--ib', Math.min(1, ib / 0.6).toFixed(3));
  }

  if (frame % 4 === 0 && heroMix > 0) {
    const f = (v: THREE.Vector2) => `${v.x.toFixed(3)} · ${v.y.toFixed(3)}`;
    coordA.textContent = f(stage.lightA);
    coordB.textContent = f(stage.lightB);
  }
};

if (!stage) {
  loadTarget = 1;
  fontsReady.then(resize);
}
requestAnimationFrame(tick);
