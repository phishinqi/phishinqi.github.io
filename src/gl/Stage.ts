import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { LightField, FULLSCREEN_VERT, SEGMENT_GLSL, MAX_TUBES, type Rect, type RoundLight, type Tube } from './LightField';
import { Scene3D } from './Scene3D';
import { Flicker } from '../core/flicker';
import { bounceIn, clamp, damp, mixRgb, rand, type RGB } from '../core/math';
import { palettes } from '../core/theme';
import { motion, tier } from '../core/env';
import { siteConfig } from '../config/site.config';

/**
 * 全站唯一的 WebGL 画布（fixed，位于内容之下）。
 * 首屏：Akari 式霓虹灯管阵列 + 两盏圆形主光照亮墙面，名字是墨色剪影；
 * 向下滚动时交叉淡化到 3D 体积光场景。
 */

const COMPOSITE_FRAG = /* glsl */ `
  #define MAX_TUBES ${MAX_TUBES}
  uniform sampler2D uGi, uDirect, uTrail, uMask, uDist, uScene;
  uniform float uHeroMix, uTheme, uAspect, uTime, uFlash, uSceneOn;
  uniform float uTubeR, uPower, uGiGain, uAmbient;
  uniform vec2 uRes;
  uniform vec3 uInk, uBgL, uShadowL;
  uniform vec4 uSeg[MAX_TUBES];
  uniform vec3 uCol[MAX_TUBES];
  uniform float uOn[MAX_TUBES];
  uniform vec2 uLPos[2];
  uniform vec3 uLCol[2];
  uniform float uLInt[2];
  uniform float uLRad[2];
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
    vec3 gi = texture2D(uGi, uv).rgb * uGiGain * uPower;
    vec3 direct = texture2D(uDirect, uv).rgb;
    vec3 tr = texture2D(uTrail, uv).rgb;

    // ── 深色（Akari）：黑墙只被灯管的全局光照亮，另有一层很淡的环境底色
    vec3 dark = vec3(uAmbient) + gi + direct * 0.35 + tr * 0.35;

    // ── 浅色：白墙被彩光染色；照不到的地方（名字的影子）落入浅影，远离文字处由环境光补亮
    vec3 lit = gi + direct * 0.6;
    float L = dot(lit, vec3(0.299, 0.587, 0.114));
    float fill = smoothstep(0.02, 0.5, texture2D(uDist, uv).r) * 0.55;
    vec3 base = mix(uShadowL, uBgL, max(smoothstep(0.0, 0.3, L), fill));
    vec3 tint = lit / max(max(lit.r, max(lit.g, lit.b)), 1e-3);
    vec3 light = base * mix(vec3(1.0), tint, clamp(L * 1.4, 0.0, 1.0) * 0.4);
    float ta = clamp(max(tr.r, max(tr.g, tr.b)), 0.0, 1.0);
    light = mix(light, light * (tr / max(ta, 1e-3)), ta * 0.4);

    vec3 col = mix(light, dark, uTheme);

    // 名字：平涂墨色剪影
    col = mix(col, uInk, texture2D(uMask, uv).a);

    // 灯管本体：实心胶囊（Akari 的霓虹条），通电时随总电源一起明灭
    float body = clamp(uPower * 1.5, 0.0, 1.0);
    for (int i = 0; i < MAX_TUBES; i++) {
      if (uOn[i] <= 0.0) continue;
      float d = segDist(uv, uSeg[i].xy, uSeg[i].zw, uAspect) * uRes.y - uTubeR;
      col = mix(col, mix(uCol[i] * 0.9, uCol[i], uTheme), clamp(0.5 - d, 0.0, 1.0) * body);
    }

    // 圆形主光：实心圆盘 + 很小的光晕。闪烁熄灭时退成暗色玻璃
    for (int i = 0; i < 2; i++) {
      float radPx = uLRad[i] * uRes.y;
      float d = length((uv - uLPos[i]) * vec2(uAspect, 1.0)) * uRes.y - radPx;
      float I = uLInt[i];
      vec3 C = uLCol[i];
      float core = smoothstep(1.2, -0.8, d);
      float glow = exp(-max(d, 0.0) / (radPx * 0.9)) * 0.3 * I;
      float on = clamp(I * 1.8, 0.0, 1.0);
      vec3 darkL = mix(col + C * glow, mix(C * 0.2, mix(C, vec3(1.0), 0.25), on), core);
      vec3 lightL = mix(mix(col, C, glow * 0.7), mix(mix(C, vec3(0.6), 0.5), C * 0.92, on), core);
      col = mix(lightL, darkL, uTheme);
    }
    return col;
  }

  void main() {
    vec2 uv = vUv;
    vec3 col;
    if (uSceneOn < 0.5) col = hero(uv);
    else if (uHeroMix < 0.001) col = toSRGB(texture2D(uScene, uv).rgb);
    else col = mix(toSRGB(texture2D(uScene, uv).rgb), hero(uv), uHeroMix);

    // 暗角：首屏用 Akari 的（只在深色下，角落压暗约三分之一），3D 场景保持电影感暗角
    float vHero = smoothstep(0.6, 1.6, length((uv - 0.5) * vec2(uAspect, 1.0)) * 2.0 * inversesqrt(uAspect * uAspect + 1.0)) * uTheme;
    float vScene = smoothstep(0.35, 1.25, length((uv - 0.5) * vec2(uAspect, 1.0) * 1.15)) * mix(0.12, 0.45, uTheme);
    col *= 1.0 - mix(vScene, vHero, uHeroMix);

    col *= 1.0 + uFlash;
    // 首屏只留 1/255 的抖动（消除色带），3D 场景保留胶片颗粒
    col += (hash(uv * uRes + fract(uTime) * 100.0) - 0.5) * mix(mix(0.03, 0.04, uTheme), 1.0 / 255.0, uHeroMix);
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

/** 霓虹灯管的亮灭周期（秒）：每根灯管半个周期亮、半个周期灭，彼此错开 */
const LOOP = 16;
/** 灯管半宽（CSS 像素） */
const TUBE_HALF_PX = 3;

/** 背景灯管：长度（CSS 像素）、所属的人、方向（1 → 左到右）、速度（屏宽/s）、亮灭相位、同色系偏移（HSL） */
interface BarDef {
  len: number;
  person: 0 | 1;
  dir: 1 | -1;
  speed: number;
  offset: number;
  phase: number;
  hsl: [number, number, number];
}

/**
 * 与 Akari 相同的 12 根灯管：偶数在名字上方、奇数在下方，越靠前越贴近名字；
 * 两人的颜色在每一侧交替出现，三分之二的灯管在主题色基础上做小幅色相 / 饱和度 / 明度偏移
 */
const makeBars = (): BarDef[] =>
  Array.from({ length: MAX_TUBES }, (_, i) => ({
    len: 500 * (0.5 + Math.random()),
    person: ((i >> 1) % 2) as 0 | 1,
    dir: Math.random() > 0.5 ? 1 : -1,
    speed: 0.3 * (0.1 + Math.random() * 0.1),
    offset: Math.random(),
    phase: (i / MAX_TUBES) * LOOP,
    hsl: i % 3 === 0 ? [0, 0, 0] : [rand(-0.05, 0.05), rand(-0.1, 0.1), rand(-0.08, 0.05)],
  }));

const MOUSE_RADIUS = 0.016;
const MOUSE_INTENSITY = 0.72;
const WANDER_INTENSITY = 0.6;
const WANDER_RADIUS = 0.013;

const v3 = (c: RGB) => new THREE.Vector3(c[0], c[1], c[2]);
const tmpColor = new THREE.Color();

const makeTube = (): Tube => ({ a: new THREE.Vector2(), b: new THREE.Vector2(), color: new THREE.Vector3(), on: 0 });

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  private field: LightField;
  private scene3d: Scene3D;
  private quad: FullScreenQuad;
  private composite: THREE.ShaderMaterial;

  private bars = makeBars();
  private tubes: Tube[] = this.bars.map(makeTube);
  private modulators = [new Flicker(3, 8), new Flicker(4, 11)];

  /** 当前两盏主光的强度（含闪烁），供 DOM 同步 */
  intensities: [number, number] = [0, 0];
  /** 开场点亮 0..1 */
  power = 0;
  /** 导航条底边到视口顶部的距离（CSS 像素），灯管不进入这一区域 */
  topInset = 0;
  theme = 0;
  private a = new THREE.Vector2(0.3, 0.82);
  private b = new THREE.Vector2(0.75, 0.18);
  private aPrev = new THREE.Vector2();
  private bPrev = new THREE.Vector2();
  private bVel = new THREE.Vector2();
  private lights: RoundLight[] = [
    { pos: this.a, prev: this.aPrev, color: new THREE.Vector3(), intensity: 0, radius: MOUSE_RADIUS },
    { pos: this.b, prev: this.bPrev, color: new THREE.Vector3(), intensity: 0, radius: WANDER_RADIUS },
  ];
  private idleTime = 0;
  private lastPointer = new THREE.Vector2(-1, -1);
  private w = 1;
  private h = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;

    // 全局光照在半分辨率上计算（与 Akari 相同），低端设备再降一档
    this.field = new LightField(
      this.renderer,
      tier === 'high'
        ? { scale: 0.5, maxWidth: 960, samples: 16, steps: 24, shadowTaps: 3 }
        : { scale: 0.35, maxWidth: 420, samples: 12, steps: 20, shadowTaps: 1 },
    );
    this.scene3d = new Scene3D(this.renderer, tier === 'low');
    this.quad = new FullScreenQuad();
    this.composite = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uGi: { value: this.field.giTexture },
        uDirect: { value: this.field.directTexture },
        uTrail: { value: null },
        uMask: { value: this.field.maskTexture },
        uDist: { value: this.field.distTexture },
        uScene: { value: null },
        uHeroMix: { value: 1 },
        uSceneOn: { value: 0 },
        uTheme: { value: 0 },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uTubeR: { value: 3 },
        uPower: { value: 0 },
        // 墙面亮度：全局光照增益、深色下的环境底色（Akari：#ddd × 0.1）
        uGiGain: { value: 1 },
        uAmbient: { value: 0.07 },
        uRes: { value: new THREE.Vector2() },
        uInk: { value: new THREE.Vector3() },
        uBgL: { value: v3(palettes.light.bg) },
        uShadowL: { value: v3(palettes.light.shadow) },
        uSeg: { value: Array.from({ length: MAX_TUBES }, () => new THREE.Vector4()) },
        uCol: { value: Array.from({ length: MAX_TUBES }, () => new THREE.Vector3()) },
        uOn: { value: new Array(MAX_TUBES).fill(0) },
        uLPos: { value: [new THREE.Vector2(), new THREE.Vector2()] },
        uLCol: { value: [new THREE.Vector3(), new THREE.Vector3()] },
        uLInt: { value: [0, 0] },
        uLRad: { value: [MOUSE_RADIUS, WANDER_RADIUS] },
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
    u.uTubeR.value = TUBE_HALF_PX * dpr;
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

  /**
   * 霓虹灯管（Akari）：在文字禁区上下的行里横向漂移，移出屏幕后从另一侧回来；
   * 亮灭包络 bounceIn(sin(2πt/16))，通电和断电时各有一串快速的明灭
   */
  private updateBars(t: number, ca: RGB, cb: RGB) {
    const aspect = this.w / this.h;
    const lenScale = Math.max(1, Math.sqrt(aspect)) * Math.min(1, this.w / 1280);
    // 减少动态效果时：灯管静止，保持开场那一刻的亮灭
    const tt = motion.reduced ? 0 : t;
    const colors = [ca, cb];

    const zone = this.safeZone(4);
    const edge = 0.05;
    // 上方的行不进入导航条（窄屏时导航有两行）
    const top = 1 - Math.max(edge, (this.topInset + 16) / this.h);
    const bands = [
      { lo: Math.min(top, zone.y1), hi: top },
      { lo: edge, hi: Math.max(edge, zone.y0) },
    ];
    const perBand = MAX_TUBES / 2;

    this.bars.forEach((def, i) => {
      let side = i % 2;
      // 某一侧没有空间时挪到另一侧
      if (bands[side].hi - bands[side].lo < 0.02) side = 1 - side;
      const band = bands[side];
      const k = ((i >> 1) + 0.5) / perBand;
      const y = side === 0 ? band.lo + (band.hi - band.lo) * k : band.hi - (band.hi - band.lo) * k;

      const half = (def.len * lenScale) / 2 / this.w;
      const min = -half - 0.02;
      const span = 1 + 2 * (half + 0.02);
      const x = min + ((((def.offset * span + def.dir * def.speed * tt) % span) + span) % span);

      const tube = this.tubes[i];
      tube.a.set(x - half, y);
      tube.b.set(x + half, y);
      tube.on = bounceIn(Math.sin((2 * Math.PI * (def.phase + tt)) / LOOP)) > 0.005 ? 1 : 0;
      const c = colors[def.person];
      tmpColor.setRGB(c[0], c[1], c[2]).offsetHSL(def.hsl[0], def.hsl[1], def.hsl[2]);
      tube.color.set(clamp(tmpColor.r), clamp(tmpColor.g), clamp(tmpColor.b));
    });
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
    const ink: RGB = mixRgb([0.035, 0.03, 0.045], [0.01, 0.01, 0.012], th);
    const flash = motion.reduced ? 0 : input.glitch * (Math.random() - 0.5) * 0.06;

    const heroOn = input.heroMix > 0.001;
    const sceneOn = input.heroMix < 0.999;
    const u = this.composite.uniforms;

    this.moveLights(t, dt, input.pointer);
    this.updateBars(t, ca, cb);
    const [la, lb] = this.lights;
    la.color.copy(v3(ca));
    la.intensity = MOUSE_INTENSITY * this.modulators[0].value(t) * this.power;
    lb.color.copy(v3(cb));
    lb.intensity = WANDER_INTENSITY * this.modulators[1].value(t + 17) * this.power;
    this.intensities = [la.intensity, lb.intensity];

    if (heroOn) {
      this.field.render({
        tubes: this.tubes,
        lights: this.lights,
        tubeHalfPx: TUBE_HALF_PX,
        radius: 0.34 - th * 0.06,
        trailDecay: motion.reduced ? 0 : Math.pow(0.88, dt * 60),
      });
      u.uGi.value = this.field.giTexture;
      u.uTrail.value = this.field.trailTexture;

      this.tubes.forEach((tb, i) => {
        u.uSeg.value[i].set(tb.a.x, tb.a.y, tb.b.x, tb.b.y);
        u.uCol.value[i].copy(tb.color);
        u.uOn.value[i] = tb.on;
      });
      this.lights.forEach((l, i) => {
        u.uLPos.value[i].copy(l.pos);
        u.uLCol.value[i].copy(l.color);
        u.uLInt.value[i] = l.intensity;
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
    u.uPower.value = this.power;
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
