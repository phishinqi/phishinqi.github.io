import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { LightField, FULLSCREEN_VERT, SEGMENT_GLSL, MAX_TUBES, type LightState, type Rect, type Tube } from './LightField';
import { Scene3D } from './Scene3D';
import { Flicker, Strobe } from '../core/flicker';
import { clamp, damp, mixRgb, type RGB } from '../core/math';
import { palettes } from '../core/theme';
import { motion, tier } from '../core/env';
import { siteConfig } from '../config/site.config';

/**
 * 全站唯一的 WebGL 画布（fixed，位于内容之下）。
 * 首屏渲染 2D 光场，向下滚动时交叉淡化到 3D 体积光场景；
 * 最终合成：平涂文字剪影 + 光源本体（灯管 / 圆形光） + 光轨迹 + 暗角 + 胶片颗粒。
 */

const COMPOSITE_FRAG = /* glsl */ `
  #define MAX_TUBES ${MAX_TUBES}
  uniform sampler2D uLight, uTrail, uMask, uScene;
  uniform float uHeroMix, uTheme, uAspect, uTime, uFlash, uSceneOn, uTubeW;
  uniform vec2 uRes;
  uniform vec3 uInk;
  uniform float uInkAlpha;
  uniform vec4 uSeg[MAX_TUBES];
  uniform vec3 uCol[MAX_TUBES];
  uniform float uInt[MAX_TUBES];
  uniform float uRad[MAX_TUBES];
  uniform int uCount;
  varying vec2 vUv;

  ${SEGMENT_GLSL}

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  vec3 toSRGB(vec3 c) {
    c = max(c, 0.0);
    vec3 over = max(c - 0.8, 0.0);
    c = min(c, 0.8) + 0.2 * (1.0 - exp(-over / 0.2));
    return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  vec3 hero(vec2 uv) {
    vec3 bg = texture2D(uLight, uv).rgb;

    // 平涂剪影：墨色实心字
    float m = texture2D(uMask, uv).a;
    vec3 col = mix(bg, mix(bg, uInk, uInkAlpha), m);

    // 移动光源的体积光轨迹
    vec3 tr = texture2D(uTrail, uv).rgb;
    float a = clamp(max(tr.r, max(tr.g, tr.b)), 0.0, 1.0);
    col = mix(mix(col, col * (tr / max(a, 1e-3)), a * 0.5), col + tr * 0.6, uTheme);

    // 光源本体：灯管 = 细亮芯；圆形光 = 实心圆盘。频闪熄灭时退成暗色玻璃
    for (int i = 0; i < MAX_TUBES; i++) {
      if (i >= uCount) break;
      float radPx = uRad[i] * uRes.y;
      float dpx = segDist(uv, uSeg[i].xy, uSeg[i].zw, uAspect) * uRes.y - radPx;
      float I = uInt[i];
      vec3 C = uCol[i];
      float core = radPx > 0.0 ? smoothstep(1.2, -0.8, dpx) : smoothstep(uTubeW, uTubeW * 0.35, dpx);
      float spread = radPx > 0.0 ? radPx * 0.9 + uTubeW * 3.0 : uTubeW * 5.0;
      float glow = exp(-max(dpx, 0.0) / spread) * 0.45 * I;
      // 光源本体的亮度与它照亮场景的强度解耦：本体始终明亮，只在频闪熄灭时变暗
      float on = clamp(I * 1.8, 0.0, 1.0);
      vec3 onD = mix(C, vec3(1.0), 0.25);
      vec3 darkT = mix(col + C * glow, mix(C * 0.2, onD, on), core);
      vec3 lightT = mix(mix(col, C, glow * 0.7), mix(mix(C, vec3(0.6), 0.5), C * 0.92, on), core);
      col = mix(lightT, darkT, uTheme);
    }
    return col;
  }

  void main() {
    vec2 uv = vUv;
    vec3 col;
    if (uSceneOn < 0.5) col = hero(uv);
    else if (uHeroMix < 0.001) col = toSRGB(texture2D(uScene, uv).rgb);
    else col = mix(toSRGB(texture2D(uScene, uv).rgb), hero(uv), uHeroMix);

    // 电影感暗角
    float v = smoothstep(0.35, 1.25, length((uv - 0.5) * vec2(uAspect, 1.0) * 1.15));
    col *= 1.0 - v * mix(0.12, 0.45, uTheme);

    col *= 1.0 + uFlash;
    col += (hash(uv * uRes + fract(uTime) * 100.0) - 0.5) * mix(0.03, 0.04, uTheme);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface StageInput {
  /** 指针 uv（0..1，y 向上）；null 表示无指针（触屏闲置） */
  pointer: THREE.Vector2 | null;
  /** 0..1：首屏 → 3D 场景的过渡 */
  heroMix: number;
  /** 3D 场景滚动进度 */
  sceneProgress: number;
  /** 目标主题 0 浅 1 深 */
  themeTarget: number;
  /** 名字轮播 glitch 强度 */
  glitch: number;
}

/** 背景灯管：长度（屏高为单位）、所属的人、方向（1 → 左到右，-1 → 右到左）、速度（uv/s） */
interface TubeDef {
  len: number;
  person: 0 | 1;
  dir: 1 | -1;
  speed: number;
  offset: number;
  strobe: boolean;
}

// 前 3 根在文字上方穿行，后 3 根在下方；相邻两行方向相反
const BG_TUBES: TubeDef[] = [
  { len: 0.5, person: 0, dir: 1, speed: 0.022, offset: 0.1, strobe: false },
  { len: 0.36, person: 1, dir: -1, speed: 0.034, offset: 0.55, strobe: true },
  { len: 0.62, person: 1, dir: 1, speed: 0.016, offset: 0.8, strobe: false },
  { len: 0.44, person: 1, dir: -1, speed: 0.026, offset: 0.3, strobe: false },
  { len: 0.3, person: 0, dir: 1, speed: 0.04, offset: 0.7, strobe: true },
  { len: 0.56, person: 0, dir: -1, speed: 0.019, offset: 0.05, strobe: false },
];

const MOUSE_RADIUS = 0.016;
const MOUSE_INTENSITY = 0.72;
const WANDER_INTENSITY = 0.6;
const WANDER_RADIUS = 0.013;

const v3 = (c: RGB) => new THREE.Vector3(c[0], c[1], c[2]);

const makeTube = (radius = 0): Tube => ({
  a: new THREE.Vector2(),
  b: new THREE.Vector2(),
  color: new THREE.Vector3(),
  intensity: 0,
  radius,
});

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  private field: LightField;
  private scene3d: Scene3D;
  private quad: FullScreenQuad;
  private composite: THREE.ShaderMaterial;

  private tubes: Tube[] = [makeTube(MOUSE_RADIUS), makeTube(WANDER_RADIUS), ...BG_TUBES.map(() => makeTube())];
  private modulators: { value(t: number): number }[] = [
    new Flicker(3, 8), // 鼠标光
    new Flicker(4, 11), // 游走光
    ...BG_TUBES.map((d) => (d.strobe ? new Strobe() : new Flicker(5, 14))),
  ];

  /** 当前两盏主光的强度（含闪烁），供 DOM 同步 */
  intensities: [number, number] = [0, 0];
  /** 开场点亮 0..1 */
  power = 0;
  theme = 0;
  private a = new THREE.Vector2(0.3, 0.82);
  private b = new THREE.Vector2(0.75, 0.18);
  private aPrev = new THREE.Vector2();
  private bPrev = new THREE.Vector2();
  private bVel = new THREE.Vector2();
  private idleTime = 0;
  private lastPointer = new THREE.Vector2(-1, -1);
  private w = 1;
  private h = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;

    // 面光源很柔和，光照可以用更低的分辨率计算
    this.field = new LightField(this.renderer, tier === 'high' ? 0.4 : 0.28, tier === 'high' ? 3 : 1);
    this.scene3d = new Scene3D(this.renderer, tier === 'low');
    this.quad = new FullScreenQuad();
    this.composite = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uLight: { value: this.field.lightRT.texture },
        uTrail: { value: null },
        uMask: { value: this.field.maskTexture },
        uScene: { value: null },
        uHeroMix: { value: 1 },
        uSceneOn: { value: 0 },
        uTheme: { value: 0 },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uTubeW: { value: 2 },
        uRes: { value: new THREE.Vector2() },
        uInk: { value: new THREE.Vector3() },
        uInkAlpha: { value: 1 },
        uSeg: { value: Array.from({ length: MAX_TUBES }, () => new THREE.Vector4()) },
        uCol: { value: Array.from({ length: MAX_TUBES }, () => new THREE.Vector3()) },
        uInt: { value: new Array(MAX_TUBES).fill(0) },
        uRad: { value: new Array(MAX_TUBES).fill(0) },
        uCount: { value: 0 },
      },
    });
    this.quad.material = this.composite;
  }

  get lightField() {
    return this.field;
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    const dpr = Math.min(devicePixelRatio, tier === 'high' ? 1.75 : 1.25);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.field.setSize(w, h, Math.min(devicePixelRatio, 2));
    this.scene3d.setSize(w, h, dpr);
    const u = this.composite.uniforms;
    u.uAspect.value = w / h;
    u.uRes.value.set(w * dpr, h * dpr);
    u.uTubeW.value = 2.4 * dpr;
  }

  /** 文字禁区：文字外框向外扩展「安全距离 + 额外像素」（uv） */
  private safeZone(extraPx: number): Rect {
    const r = this.field.textRect;
    const d = siteConfig.hero.lightSafeDistance + extraPx;
    return { x0: r.x0 - d / this.w, x1: r.x1 + d / this.w, y0: r.y0 - d / this.h, y1: r.y1 + d / this.h };
  }

  /** 若点落在禁区内，推到最近的边界上；返回是否被推动 */
  private pushOut(p: THREE.Vector2, extraPx: number): boolean {
    const z = this.safeZone(extraPx);
    if (p.x <= z.x0 || p.x >= z.x1 || p.y <= z.y0 || p.y >= z.y1) return false;
    const dl = (p.x - z.x0) * this.w;
    const dr = (z.x1 - p.x) * this.w;
    const db = (p.y - z.y0) * this.h;
    const dt = (z.y1 - p.y) * this.h;
    const m = Math.min(dl, dr, db, dt);
    if (m === dl) p.x = z.x0;
    else if (m === dr) p.x = z.x1;
    else if (m === db) p.y = z.y0;
    else p.y = z.y1;
    return true;
  }

  /** 两盏圆形主光：A 跟随指针（lerp 惯性），B 绕文字游走并被 A 吸引；两者都不进入文字禁区 */
  private moveLights(t: number, dt: number, pointer: THREE.Vector2 | null) {
    const aspect = this.w / this.h;
    this.aPrev.copy(this.a);
    this.bPrev.copy(this.b);

    if (pointer && !pointer.equals(this.lastPointer)) {
      this.idleTime = 0;
      this.lastPointer.copy(pointer);
    } else {
      this.idleTime += dt;
    }

    const rA = MOUSE_RADIUS * this.h;
    const rB = WANDER_RADIUS * this.h;
    const zone = this.safeZone(0);
    const cx = (zone.x0 + zone.x1) / 2;
    const cy = (zone.y0 + zone.y1) / 2;
    // 围绕文字的椭圆轨道（半径大于禁区）
    const rx = Math.max((zone.x1 - zone.x0) / 2 + 0.06, 0.3);
    const ry = Math.max((zone.y1 - zone.y0) / 2 + 0.08, 0.3);

    const target =
      pointer && this.idleTime < 4
        ? pointer.clone()
        : new THREE.Vector2(cx + Math.cos(t * 0.19) * rx, cy + Math.sin(t * 0.19) * ry * 0.95);
    this.pushOut(target, rA);
    this.a.x = damp(this.a.x, target.x, 5.5, dt);
    this.a.y = damp(this.a.y, target.y, 5.5, dt);
    this.pushOut(this.a, rA);

    const th = t * 0.13 + 2.2;
    const wander = new THREE.Vector2(
      cx + Math.cos(th) * rx * (1 + 0.1 * Math.sin(t * 0.41)),
      cy + Math.sin(th) * ry * (1 + 0.1 * Math.sin(t * 0.37 + 3)),
    );
    const toA = new THREE.Vector2((this.a.x - this.b.x) * aspect, this.a.y - this.b.y);
    const d = toA.length();
    const goal = wander.lerp(this.a, clamp(1 - d / 0.9) * 0.45);
    const acc = new THREE.Vector2((goal.x - this.b.x) * 1.4, (goal.y - this.b.y) * 1.4);
    if (d < 0.45 && d > 1e-4) {
      const tangent = new THREE.Vector2(-toA.y, toA.x).normalize().multiplyScalar(0.35 * (1 - d / 0.45));
      acc.x += tangent.x / aspect;
      acc.y += tangent.y;
    }
    this.bVel.addScaledVector(acc, dt);
    this.bVel.multiplyScalar(Math.exp(-1.6 * dt));
    this.b.addScaledVector(this.bVel, dt);
    this.b.x = clamp(this.b.x, 0.03, 0.97);
    this.b.y = clamp(this.b.y, 0.04, 0.96);
    if (this.pushOut(this.b, rB)) this.bVel.multiplyScalar(0.4);
  }

  /** 背景灯管：在文字禁区上下的行里横向穿行，移出屏幕后从另一侧循环回来 */
  private updateTubes(t: number, ca: RGB, cb: RGB) {
    const aspect = this.w / this.h;
    const lenScale = Math.min(1, aspect / 1.5);
    const colors = [v3(ca), v3(cb)];
    const [mouse, wanderer, ...rest] = this.tubes;

    mouse.a.copy(this.a);
    mouse.b.copy(this.a);
    mouse.color.copy(colors[0]);
    mouse.intensity = MOUSE_INTENSITY * this.modulators[0].value(t) * this.power;

    wanderer.a.copy(this.b);
    wanderer.b.copy(this.b);
    wanderer.color.copy(colors[1]);
    wanderer.intensity = WANDER_INTENSITY * this.modulators[1].value(t + 17) * this.power;

    // 可用的行：禁区上方、下方
    const zone = this.safeZone(4);
    const edge = 0.05;
    const bands = [
      { lo: Math.min(1 - edge, zone.y1), hi: 1 - edge },
      { lo: edge, hi: Math.max(edge, zone.y0) },
    ];
    const perBand = BG_TUBES.length / 2;

    BG_TUBES.forEach((def, i) => {
      let band = bands[i < perBand ? 0 : 1];
      // 某一侧没有空间时挪到另一侧
      if (band.hi - band.lo < 0.02) band = bands[i < perBand ? 1 : 0];
      const k = i % perBand;
      const y = band.lo + ((band.hi - band.lo) * (k + 0.5)) / perBand;

      const half = (def.len * lenScale) / 2 / aspect;
      const min = -half - 0.05;
      const span = 1 + 2 * (half + 0.05);
      const travel = motion.reduced ? 0 : def.dir * def.speed * t;
      const x = min + ((((def.offset * span + travel) % span) + span) % span);

      const tube = rest[i];
      tube.a.set(x - half, y);
      tube.b.set(x + half, y);
      tube.color.copy(colors[def.person]);
      tube.intensity = 0.42 * this.modulators[i + 2].value(t) * this.power;
    });

    this.intensities = [mouse.intensity, wanderer.intensity];
  }

  render(t: number, dt: number, input: StageInput) {
    dt = Math.min(dt, 1 / 20);
    this.theme = damp(this.theme, input.themeTarget, 3.2, dt);
    const th = this.theme;

    const pl = palettes.light;
    const pd = palettes.dark;
    const ca = mixRgb(pl.a, pd.a, th);
    const cb = mixRgb(pl.b, pd.b, th);
    const bg = mixRgb(pl.bg, pd.bg, th);
    const ink: RGB = mixRgb([0.08, 0.06, 0.1], [0.01, 0.01, 0.012], th);
    const flash = motion.reduced ? 0 : input.glitch * (Math.random() - 0.5) * 0.06;

    const heroOn = input.heroMix > 0.001;
    const sceneOn = input.heroMix < 0.999;
    const u = this.composite.uniforms;

    this.moveLights(t, dt, input.pointer);
    this.updateTubes(t, ca, cb);

    if (heroOn) {
      const [mouse, wanderer] = this.tubes;
      const state: LightState = {
        tubes: this.tubes,
        moving: [
          { cur: mouse, prevA: this.aPrev, prevB: this.aPrev },
          { cur: wanderer, prevA: this.bPrev, prevB: this.bPrev },
        ],
        theme: th,
        radius: 0.34 - th * 0.06,
        bgL: v3(pl.bg),
        bgD: v3(pd.bg),
        shadowL: v3(pl.shadow),
        trailDecay: motion.reduced ? 0 : Math.pow(0.88, dt * 60),
      };
      this.field.render(state);
      u.uTrail.value = this.field.trailTexture;

      u.uCount.value = this.tubes.length;
      this.tubes.forEach((tb, i) => {
        u.uSeg.value[i].set(tb.a.x, tb.a.y, tb.b.x, tb.b.y);
        u.uCol.value[i].copy(tb.color);
        u.uInt.value[i] = tb.intensity;
        u.uRad.value[i] = tb.radius;
      });
    }

    if (sceneOn) {
      const lin = (c: RGB) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      this.scene3d.update(t, dt, {
        theme: th,
        pointer: new THREE.Vector2(this.a.x * 2 - 1, this.a.y * 2 - 1),
        progress: input.sceneProgress,
        colorA: lin(ca),
        colorB: lin(cb),
        bg: lin(bg),
        // 3D 场景只取闪烁与点亮的变化，亮度基准独立于首屏
        ia: this.intensities[0] / MOUSE_INTENSITY,
        ib: this.intensities[1] / WANDER_INTENSITY,
      });
      u.uScene.value = this.scene3d.render();
    }

    u.uHeroMix.value = input.heroMix;
    u.uSceneOn.value = sceneOn ? 1 : 0;
    u.uTheme.value = th;
    u.uTime.value = t;
    u.uFlash.value = flash;
    u.uInk.value.copy(v3(ink));

    this.renderer.setRenderTarget(null);
    this.quad.render(this.renderer);
  }

  /** 鼠标光中心的屏幕 uv（供 DOM 使用，例如卡片受光方向） */
  get lightA() {
    return this.a;
  }
  get lightB() {
    return this.b;
  }
}
