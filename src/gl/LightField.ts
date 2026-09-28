import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * 首屏 2D 光照（仿 akari.lusion.co 的 Home）
 *
 *   名字（黑色遮挡物）+ 灯管（发光体）─▶ 低分辨率场景 ─▶ JFA 跳跃泛洪（灯管在动，每帧重算）
 *                                                          │
 *   每个像素向 SAMPLES 个方向做光线步进：命中灯管取光色、命中名字为黑 ─▶ 全局光照 ─▶ 填充模糊 ×3
 *
 *   名字距离场（名字变化时才重算）─▶ 两盏圆形主光：解析衰减 + 软阴影
 *   （圆光很小，用光线采样会满屏噪点，所以单独解析计算）
 *
 *   移动的圆光 ── 扫掠光晕 + 反馈衰减 ──▶ 体积光拖尾
 *
 * 名字、灯管本体与圆光本体在合成阶段以全分辨率绘制（见 Stage）。
 */

export const MAX_TUBES = 12;

export const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** 公共：点到线段的最近点与距离（aspect 空间） */
export const SEGMENT_GLSL = /* glsl */ `
  vec2 closestOnSeg(vec2 p, vec2 a, vec2 b, float aspect) {
    vec2 s = vec2(aspect, 1.0);
    vec2 pa = (p - a) * s, ba = (b - a) * s;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    return a + (b - a) * h;
  }
  float segDist(vec2 p, vec2 a, vec2 b, float aspect) {
    return length((p - closestOnSeg(p, a, b, aspect)) * vec2(aspect, 1.0));
  }
`;

// ── 名字距离场（供圆光软阴影）

const SEED_FRAG = /* glsl */ `
  uniform sampler2D uMask;
  varying vec2 vUv;
  void main() {
    float m = texture2D(uMask, vUv).a;
    gl_FragColor = m > 0.5 ? vec4(vUv, 0.0, 1.0) : vec4(-1.0, -1.0, 0.0, 1.0);
  }
`;

const JFA_FRAG = /* glsl */ `
  uniform sampler2D uSeed;
  uniform vec2 uStep;
  uniform float uAspect;
  varying vec2 vUv;
  void main() {
    vec2 best = vec2(-1.0);
    float bestD = 1e9;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 s = texture2D(uSeed, vUv + vec2(float(x), float(y)) * uStep).xy;
        if (s.x < 0.0) continue;
        vec2 d = (s - vUv) * vec2(uAspect, 1.0);
        float dd = dot(d, d);
        if (dd < bestD) { bestD = dd; best = s; }
      }
    }
    gl_FragColor = vec4(best, 0.0, 1.0);
  }
`;

const DIST_FRAG = /* glsl */ `
  uniform sampler2D uSeed;
  uniform float uAspect;
  varying vec2 vUv;
  void main() {
    vec2 s = texture2D(uSeed, vUv).xy;
    float d = s.x < 0.0 ? 2.0 : length((s - vUv) * vec2(uAspect, 1.0));
    gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
  }
`;

// ── 全局光照

/** 光追场景：名字是不透明的黑色遮挡物，点亮的灯管是不透明发光体（rgb = 光色） */
const GI_SCENE_FRAG = /* glsl */ `
  #define MAX_TUBES ${MAX_TUBES}
  uniform sampler2D uMask;
  uniform vec2 uTexel;
  uniform float uAspect;
  uniform float uTubeR;
  uniform vec4 uSeg[MAX_TUBES];
  uniform vec3 uCol[MAX_TUBES];
  uniform float uOn[MAX_TUBES];
  varying vec2 vUv;

  ${SEGMENT_GLSL}

  void main() {
    // 名字遮罩是全分辨率的：四点采样近似盒式降采样，细笔画不会断
    vec2 o = uTexel * 0.25;
    float m = 0.25 * (
      texture2D(uMask, vUv + vec2(-o.x, -o.y)).a + texture2D(uMask, vUv + vec2(o.x, -o.y)).a +
      texture2D(uMask, vUv + vec2(-o.x, o.y)).a + texture2D(uMask, vUv + vec2(o.x, o.y)).a);
    vec4 col = vec4(0.0, 0.0, 0.0, m);
    for (int i = 0; i < MAX_TUBES; i++) {
      if (uOn[i] <= 0.0) continue;
      float d = segDist(vUv, uSeg[i].xy, uSeg[i].zw, uAspect) - uTubeR;
      col = mix(col, vec4(uCol[i], 1.0), clamp(0.5 - d / uTexel.y, 0.0, 1.0));
    }
    gl_FragColor = col;
  }
`;

/** JFA 种子：被占据的像素记下自己的像素坐标（半浮点在 1024 以内可精确表示 x.5），.zw = 占据标记、覆盖率 */
const GI_SEED_FRAG = /* glsl */ `
  uniform sampler2D uScene;
  varying vec2 vUv;
  void main() {
    float a = texture2D(uScene, vUv).a;
    gl_FragColor = a > 0.02 ? vec4(gl_FragCoord.xy, 1.0, a) : vec4(-1.0, -1.0, 0.0, 0.0);
  }
`;

/** 像素空间的 JFA，.zw 原样带下去 */
const GI_JFA_FRAG = /* glsl */ `
  uniform sampler2D uSeed;
  uniform vec2 uTexel;
  uniform float uStep;
  varying vec2 vUv;
  void main() {
    vec2 p = gl_FragCoord.xy;
    vec2 best = vec2(-1.0);
    float bestD = 1e12;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 s = texture2D(uSeed, vUv + vec2(float(x), float(y)) * uStep * uTexel).xy;
        if (s.x < 0.0) continue;
        float dd = dot(s - p, s - p);
        if (dd < bestD) { bestD = dd; best = s; }
      }
    }
    gl_FragColor = vec4(best, texture2D(uSeed, vUv).zw);
  }
`;

/**
 * Akari 的光线步进：每个像素向均匀分布的 SAMPLES 个方向发射光线（整组方向按噪声旋转），
 * 沿距离场步进；命中时取该处场景颜色（灯管 = 光色，名字 = 黑），按走过的距离指数衰减。
 */
const giMarchFrag = (samples: number, steps: number) => /* glsl */ `
  #define SAMPLES ${samples}
  #define STEP_COUNT ${steps}
  uniform sampler2D uDf, uScene;
  uniform vec2 uRes, uTexel;
  uniform float uFalloff, uMinStep, uFrame;
  varying vec2 vUv;

  // 交错梯度噪声（带帧偏移）：旋转角在屏幕上分布均匀，经填充模糊后几乎看不出颗粒
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

  vec3 march(vec2 p, vec2 dir) {
    float dd = 0.0;
    for (int i = 0; i < STEP_COUNT; i++) {
      vec4 df = texture2D(uDf, p * uTexel);
      if (df.x < 0.0) break;
      float d = length(df.xy - p);
      dd += d;
      if (d < 0.75) return texture2D(uScene, df.xy * uTexel).rgb * exp(-dd * uFalloff);
      p += dir * max(uMinStep, d);
      if (p.x < 0.0 || p.y < 0.0 || p.x > uRes.x || p.y > uRes.y) break;
    }
    return vec3(0.0);
  }

  void main() {
    vec2 p = gl_FragCoord.xy;
    float bit = 6.2831853 / float(SAMPLES);
    float ang = ign(p + uFrame * 5.588238) * bit;
    vec2 dir = vec2(cos(ang), sin(ang));
    mat2 rot = mat2(cos(bit), sin(bit), -sin(bit), cos(bit));
    vec3 col = vec3(0.0);
    for (int i = 0; i < SAMPLES; i++) {
      col += march(p, dir);
      dir = rot * dir;
    }
    // 被占据的像素（名字、灯管内部）不计光照，由填充 pass 从四周补齐
    gl_FragColor = vec4(col / float(SAMPLES), 1.0) * (1.0 - texture2D(uDf, vUv).z);
  }
`;

/** 3×3 平均，只统计未被占据的像素：抹平采样噪点，并把光照补进遮挡物边缘 */
const GI_PAD_FRAG = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec4 sum = vec4(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        sum += texture2D(uTex, vUv + vec2(float(x), float(y)) * uTexel);
      }
    }
    gl_FragColor = sum.a > 0.0 ? vec4(sum.rgb / sum.a, min(1.0, sum.a)) : vec4(0.0);
  }
`;

// ── 圆形主光

const directFrag = (taps: 1 | 3) => /* glsl */ `
  #define TAPS ${taps}
  uniform sampler2D uDist;
  uniform float uAspect;
  uniform float uRadius;
  uniform float uHeight;
  uniform vec2 uPos[2];
  uniform vec3 uCol[2];
  uniform float uInt[2];
  uniform float uRad[2];
  varying vec2 vUv;

  vec2 asp(vec2 v) { return v * vec2(uAspect, 1.0); }
  float sdf(vec2 uv) { return texture2D(uDist, uv).r; }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  // 软阴影：字有厚度，光源悬在更高处 —— 只有距像素 tMax 以内的遮挡物挡得住光，
  // 阴影长度随光源距离增长；越接近 tMax 光线越贴近字顶，阴影末端柔和消散。
  // 半影宽度随「遮挡物 → 像素」距离线性增大
  float softShadow(vec2 p, vec2 l) {
    vec2 d = asp(l - p);
    float dist = length(d);
    vec2 dir = d / max(dist, 1e-5);
    float tMax = min(dist - 0.004, dist * uHeight);
    float res = 1.0;
    // 起点抖动：把步进产生的条纹打散成不可见的细噪
    float t = 0.004 + hash(p * 917.0) * 0.005;
    for (int i = 0; i < 28; i++) {
      if (t >= tMax) break;
      float h = sdf(p + (dir * t) / vec2(uAspect, 1.0));
      res = min(res, max(h / (t * 0.8), smoothstep(0.3, 1.0, t / tMax)));
      if (res < 0.002) return 0.0;
      t += max(h, 0.005);
    }
    res = clamp(res, 0.0, 1.0);
    return res * res * (3.0 - 2.0 * res);
  }

  // 长尾衰减：没有高斯那样的「光斑边缘」
  float falloff(float r, float radius) {
    float k = r / max(radius * 1.05, 0.001);
    return 0.74 * exp(-k * k * 0.9) + 0.26 / (1.0 + k * k * 3.0);
  }

  void main() {
    vec2 p = vUv;
    // 文字内部取半遮挡：上采样后字缘只留一圈很淡的接触阴影
    bool inside = sdf(p) < 0.0008;
    vec3 lit = vec3(0.0);
    for (int i = 0; i < 2; i++) {
      vec2 c = uPos[i];
      float f = falloff(length(asp(p - c)), uRadius) * uInt[i];
      if (f <= 0.0) continue;
      float sh = 0.5;
      if (!inside) {
        #if TAPS == 1
          sh = softShadow(p, c);
        #else
          // 在圆盘上垂直于视线方向取两侧边缘点，得到半影
          vec2 toP = normalize(asp(p - c) + 1e-6);
          vec2 perp = vec2(-toP.y, toP.x) * uRad[i] * 1.6 / vec2(uAspect, 1.0);
          sh = (softShadow(p, c) * 2.0 + softShadow(p, c - perp) + softShadow(p, c + perp)) * 0.25;
        #endif
      }
      lit += uCol[i] * f * sh;
    }
    gl_FragColor = vec4(lit, 1.0);
  }
`;

const TRAIL_FRAG = /* glsl */ `
  uniform sampler2D uPrev;
  uniform float uAspect, uDecay;
  uniform vec2 uCur[2];
  uniform vec2 uLast[2];
  uniform vec3 uCol[2];
  uniform float uInt[2];
  uniform float uMove[2];
  varying vec2 vUv;

  void main() {
    vec3 acc = texture2D(uPrev, vUv).rgb * uDecay;
    for (int i = 0; i < 2; i++) {
      // 在上一帧与当前帧之间插值 4 个点，得到扫掠形状（运动模糊）
      float g = 0.0;
      for (int k = 0; k < 4; k++) {
        vec2 d = (vUv - mix(uLast[i], uCur[i], float(k) / 3.0)) * vec2(uAspect, 1.0);
        g = max(g, exp(-dot(d, d) / 0.0006));
      }
      acc += uCol[i] * g * uInt[i] * uMove[i] * 0.12;
    }
    gl_FragColor = vec4(min(acc, vec3(1.4)), 1.0);
  }
`;

export interface Tube {
  a: THREE.Vector2;
  b: THREE.Vector2;
  color: THREE.Vector3;
  /** 1 = 点亮（发光并遮光），0 = 熄灭（从光追场景中移除） */
  on: number;
}

export interface RoundLight {
  pos: THREE.Vector2;
  /** 上一帧的位置，用于拖尾 */
  prev: THREE.Vector2;
  color: THREE.Vector3;
  intensity: number;
  /** 圆盘半径（屏高为单位） */
  radius: number;
}

/** uv 空间（y 向上）的矩形 */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LightState {
  tubes: Tube[];
  /** 两盏圆形主光：鼠标光、游走光 */
  lights: RoundLight[];
  /** 灯管半宽（CSS 像素） */
  tubeHalfPx: number;
  /** 圆光的照明半径（屏高为单位） */
  radius: number;
  trailDecay: number;
}

export interface FieldQuality {
  /** 模拟分辨率 = CSS 宽度 × scale，且不超过 maxWidth */
  scale: number;
  maxWidth: number;
  /** 每个像素的光线数、每条光线的最大步数 */
  samples: number;
  steps: number;
  /** 圆光软阴影的采样点数 */
  shadowTaps: 1 | 3;
}

/** 光照随传播距离的衰减（每屏高），与 Akari 相同 */
const GI_FALLOFF = 0.5;

const rt = (w: number, h: number, filter: THREE.MagnificationTextureFilter) =>
  new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: false,
    generateMipmaps: false,
  });

const vec2s = (n: number) => Array.from({ length: n }, () => new THREE.Vector2());
const vec3s = (n: number) => Array.from({ length: n }, () => new THREE.Vector3());
const vec4s = (n: number) => Array.from({ length: n }, () => new THREE.Vector4());

/** 含汉字的名字用 Noto Serif SC */
const CJK = /[⺀-鿿豈-﫿]/;

export class LightField {
  readonly maskCanvas = document.createElement('canvas');
  readonly maskTexture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private scratch = document.createElement('canvas');

  // 名字距离场
  private seedA = rt(4, 4, THREE.NearestFilter);
  private seedB = rt(4, 4, THREE.NearestFilter);
  private distRT = rt(4, 4, THREE.LinearFilter);
  /** 名字距离场（aspect 空间，屏高为单位） */
  readonly distTexture = this.distRT.texture;
  // 全局光照
  private giScene = rt(4, 4, THREE.NearestFilter);
  private giDfA = rt(4, 4, THREE.NearestFilter);
  private giDfB = rt(4, 4, THREE.NearestFilter);
  private giA = rt(4, 4, THREE.LinearFilter);
  private giB = rt(4, 4, THREE.LinearFilter);
  giTexture = this.giA.texture;
  // 圆光
  private directRT = rt(4, 4, THREE.LinearFilter);
  readonly directTexture = this.directRT.texture;
  private trailA = rt(4, 4, THREE.LinearFilter);
  private trailB = rt(4, 4, THREE.LinearFilter);
  trailTexture = this.trailA.texture;

  private quad = new FullScreenQuad();
  private seedMat: THREE.ShaderMaterial;
  private jfaMat: THREE.ShaderMaterial;
  private distMat: THREE.ShaderMaterial;
  private giSceneMat: THREE.ShaderMaterial;
  private giSeedMat: THREE.ShaderMaterial;
  private giJfaMat: THREE.ShaderMaterial;
  private giMarchMat: THREE.ShaderMaterial;
  private giPadMat: THREE.ShaderMaterial;
  private directMat: THREE.ShaderMaterial;
  private trailMat: THREE.ShaderMaterial;

  private simW = 4;
  private simH = 4;
  private texel = new THREE.Vector2(0.25, 0.25);
  private jfaSteps: number[] = [];
  private cssH = 1;
  private aspect = 1;
  private dirty = true;
  private frame = 0;
  private fontSize = 100;
  private twoLines = false;
  /** 文字外框（uv，按最宽的名字组合计算，轮播时保持稳定） */
  textRect: Rect = { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 };

  constructor(private renderer: THREE.WebGLRenderer, private quality: FieldQuality) {
    this.ctx = this.maskCanvas.getContext('2d')!;
    this.maskTexture = new THREE.CanvasTexture(this.maskCanvas);
    this.maskTexture.minFilter = THREE.LinearFilter;
    this.maskTexture.generateMipmaps = false;

    const mat = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    const texel = { value: this.texel };

    this.seedMat = mat(SEED_FRAG, { uMask: { value: this.maskTexture } });
    this.jfaMat = mat(JFA_FRAG, { uSeed: { value: null }, uStep: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
    this.distMat = mat(DIST_FRAG, { uSeed: { value: null }, uAspect: { value: 1 } });

    this.giSceneMat = mat(GI_SCENE_FRAG, {
      uMask: { value: this.maskTexture },
      uTexel: texel,
      uAspect: { value: 1 },
      uTubeR: { value: 0.003 },
      uSeg: { value: vec4s(MAX_TUBES) },
      uCol: { value: vec3s(MAX_TUBES) },
      uOn: { value: new Array(MAX_TUBES).fill(0) },
    });
    this.giSeedMat = mat(GI_SEED_FRAG, { uScene: { value: this.giScene.texture } });
    this.giJfaMat = mat(GI_JFA_FRAG, { uSeed: { value: null }, uTexel: texel, uStep: { value: 1 } });
    this.giMarchMat = mat(giMarchFrag(quality.samples, quality.steps), {
      uDf: { value: null },
      uScene: { value: this.giScene.texture },
      uRes: { value: new THREE.Vector2() },
      uTexel: texel,
      uFalloff: { value: 0 },
      // 最小步长（模拟像素）：略小于灯管宽度，掠射的光线不会在物体边缘无限逼近
      uMinStep: { value: 1.5 },
      uFrame: { value: 0 },
    });
    this.giPadMat = mat(GI_PAD_FRAG, { uTex: { value: null }, uTexel: texel });

    this.directMat = mat(directFrag(quality.shadowTaps), {
      uDist: { value: this.distRT.texture },
      uAspect: { value: 1 },
      uRadius: { value: 0.3 },
      uHeight: { value: 0.4 },
      uPos: { value: vec2s(2) },
      uCol: { value: vec3s(2) },
      uInt: { value: [0, 0] },
      uRad: { value: [0, 0] },
    });
    this.trailMat = mat(TRAIL_FRAG, {
      uPrev: { value: null },
      uAspect: { value: 1 },
      uDecay: { value: 0.9 },
      uCur: { value: vec2s(2) },
      uLast: { value: vec2s(2) },
      uCol: { value: vec3s(2) },
      uInt: { value: [0, 0] },
      uMove: { value: [0, 0] },
    });
  }

  setSize(cssW: number, cssH: number, dpr: number) {
    this.aspect = cssW / cssH;
    this.cssH = cssH;
    const fullScale = Math.min(dpr, 2560 / cssW);
    this.maskCanvas.width = Math.round(cssW * fullScale);
    this.maskCanvas.height = Math.round(cssH * fullScale);
    this.scratch.width = this.maskCanvas.width;
    this.scratch.height = this.maskCanvas.height;
    // 画布尺寸变化后必须重新分配 GPU 纹理，否则会按旧尺寸做子区域拷贝
    this.maskTexture.dispose();

    let w = Math.min(cssW * this.quality.scale, this.quality.maxWidth);
    // 像素坐标存在半浮点里，长边不超过 1024 才能精确表示
    if (w / this.aspect > 1024) w = 1024 * this.aspect;
    this.simW = Math.max(64, Math.round(w));
    this.simH = Math.max(64, Math.round(this.simW / this.aspect));
    this.texel.set(1 / this.simW, 1 / this.simH);
    const targets = [this.seedA, this.seedB, this.distRT, this.giScene, this.giDfA, this.giDfB, this.giA, this.giB, this.directRT, this.trailA, this.trailB];
    for (const t of targets) t.setSize(this.simW, this.simH);

    this.jfaSteps = [];
    for (let s = 1 << (Math.ceil(Math.log2(Math.max(this.simW, this.simH))) - 1); s >= 1; s >>= 1) this.jfaSteps.push(s);
    this.jfaSteps.push(1); // 1+JFA：额外一轮修正误差

    this.twoLines = this.aspect < 1.15;
    this.dirty = true;
  }

  /** 名字字体：拉丁字母用 Playfair Display（Akari 字标所用字体），含汉字的名字用 Noto Serif SC */
  private font(size: number, text: string) {
    return CJK.test(text) ? `500 ${size}px "Noto Serif SC", serif` : `400 ${size}px "Playfair Display", "Noto Serif SC", serif`;
  }

  private setFont(f: string) {
    this.ctx.font = f;
    // 收紧字距，得到 Akari 字标般的紧凑块面
    if ('letterSpacing' in this.ctx) (this.ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '-0.02em';
  }

  private measure(text: string, size: number) {
    this.setFont(this.font(size, text));
    return this.ctx.measureText(text).width;
  }

  /** 以所有候选名字中最宽的组合计算字号，轮播时字号稳定不跳动 */
  layout(candidatesA: string[], candidatesB: string[]) {
    const W = this.maskCanvas.width;
    const H = this.maskCanvas.height;
    const amp = this.measure(' & ', 100);
    let widest = 0;
    for (const a of candidatesA) {
      for (const b of candidatesB) {
        const wa = this.measure(a, 100);
        const wb = this.measure(b, 100);
        widest = Math.max(widest, this.twoLines ? Math.max(wa + amp, wb) : wa + amp + wb);
      }
    }
    const byWidth = ((W * (this.twoLines ? 0.84 : 0.7)) / widest) * 100;
    const byHeight = H * (this.twoLines ? 0.17 : 0.22);
    this.fontSize = Math.min(byWidth, byHeight);

    // 文字外框：与 drawNames 的排版保持一致（上缘≈字高 0.8，下缘≈0.18）
    const size = this.fontSize;
    const blockW = (widest / 100) * size;
    const cy = H * 0.5;
    const top = this.twoLines ? cy - size * 0.12 - size * 0.8 : cy + size * 0.33 - size * 0.8;
    const bottom = this.twoLines ? cy + size * 0.92 + size * 0.18 : cy + size * 0.33 + size * 0.18;
    this.textRect = {
      x0: (W - blockW) / 2 / W,
      x1: (W + blockW) / 2 / W,
      y0: 1 - bottom / H,
      y1: 1 - top / H,
    };
    this.dirty = true;
  }

  /** 绘制遮挡物（名字），glitch > 0 时附加水平切片错位 */
  drawNames(a: string, b: string, glitch: number) {
    const ctx = this.ctx;
    const W = this.maskCanvas.width;
    const H = this.maskCanvas.height;
    const size = this.fontSize;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';

    const amp = this.measure(' & ', size);
    const wa = this.measure(a, size);
    const wb = this.measure(b, size);
    const put = (text: string, x: number, y: number) => {
      this.setFont(this.font(size, text));
      ctx.fillText(text, x, y);
    };
    const cy = H * 0.5;

    if (this.twoLines) {
      const y1 = cy - size * 0.12;
      const x1 = (W - (wa + amp)) / 2;
      put(a, x1, y1);
      put(' & ', x1 + wa, y1);
      put(b, (W - wb) / 2, cy + size * 0.92);
    } else {
      const x = (W - (wa + amp + wb)) / 2;
      const y = cy + size * 0.33;
      put(a, x, y);
      put(' & ', x + wa, y);
      put(b, x + wa + amp, y);
    }

    if (glitch > 0.05) {
      const s = this.scratch.getContext('2d')!;
      s.clearRect(0, 0, W, H);
      s.drawImage(this.maskCanvas, 0, 0);
      const bands = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < bands; i++) {
        const y = cy - size * 0.9 + Math.random() * size * 1.8;
        const h = size * (0.04 + Math.random() * 0.12);
        const dx = (Math.random() - 0.5) * glitch * size * 0.25;
        ctx.clearRect(0, y, W, h);
        ctx.drawImage(this.scratch, 0, y, W, h, dx, y, W, h);
      }
    }

    this.maskTexture.needsUpdate = true;
    this.dirty = true;
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  private computeDistanceField() {
    this.pass(this.seedMat, this.seedA);
    let read = this.seedA;
    let write = this.seedB;
    this.jfaMat.uniforms.uAspect.value = this.aspect;
    for (const s of this.jfaSteps) {
      this.jfaMat.uniforms.uSeed.value = read.texture;
      this.jfaMat.uniforms.uStep.value.set(s / this.simW, s / this.simH);
      this.pass(this.jfaMat, write);
      [read, write] = [write, read];
    }
    this.distMat.uniforms.uSeed.value = read.texture;
    this.distMat.uniforms.uAspect.value = this.aspect;
    this.pass(this.distMat, this.distRT);
  }

  private renderGI(s: LightState) {
    const su = this.giSceneMat.uniforms;
    su.uAspect.value = this.aspect;
    // 灯管在光追场景里至少约 3 个模拟像素宽，否则光线会从它中间穿过去
    su.uTubeR.value = Math.max(s.tubeHalfPx / this.cssH, 1.5 / this.simH);
    for (let i = 0; i < MAX_TUBES; i++) {
      const t = s.tubes[i];
      su.uOn.value[i] = t ? t.on : 0;
      if (!t) continue;
      su.uSeg.value[i].set(t.a.x, t.a.y, t.b.x, t.b.y);
      su.uCol.value[i].copy(t.color);
    }
    this.pass(this.giSceneMat, this.giScene);
    this.pass(this.giSeedMat, this.giDfA);

    let read = this.giDfA;
    let write = this.giDfB;
    for (const step of this.jfaSteps) {
      this.giJfaMat.uniforms.uSeed.value = read.texture;
      this.giJfaMat.uniforms.uStep.value = step;
      this.pass(this.giJfaMat, write);
      [read, write] = [write, read];
    }

    const mu = this.giMarchMat.uniforms;
    mu.uDf.value = read.texture;
    mu.uRes.value.set(this.simW, this.simH);
    mu.uFalloff.value = GI_FALLOFF / this.simH;
    mu.uFrame.value = this.frame;
    this.frame = (this.frame + 1) % 64;
    this.pass(this.giMarchMat, this.giA);

    let src = this.giA;
    let dst = this.giB;
    for (let i = 0; i < 3; i++) {
      this.giPadMat.uniforms.uTex.value = src.texture;
      this.pass(this.giPadMat, dst);
      [src, dst] = [dst, src];
    }
    this.giTexture = src.texture;
  }

  render(s: LightState) {
    if (this.dirty) {
      this.computeDistanceField();
      this.dirty = false;
    }

    this.renderGI(s);

    const du = this.directMat.uniforms;
    du.uAspect.value = this.aspect;
    du.uRadius.value = s.radius;
    const tu = this.trailMat.uniforms;
    tu.uPrev.value = this.trailA.texture;
    tu.uAspect.value = this.aspect;
    tu.uDecay.value = s.trailDecay;
    s.lights.slice(0, 2).forEach((l, i) => {
      du.uPos.value[i].copy(l.pos);
      du.uCol.value[i].copy(l.color);
      du.uInt.value[i] = l.intensity;
      du.uRad.value[i] = l.radius;
      tu.uCur.value[i].copy(l.pos);
      tu.uLast.value[i].copy(l.prev);
      tu.uCol.value[i].copy(l.color);
      tu.uInt.value[i] = l.intensity;
      // 只有移动时才留下拖尾：位移越大越亮
      tu.uMove.value[i] = Math.min(1, l.pos.distanceTo(l.prev) * 60);
    });
    this.pass(this.directMat, this.directRT);
    this.pass(this.trailMat, this.trailB);
    [this.trailA, this.trailB] = [this.trailB, this.trailA];
    this.trailTexture = this.trailA.texture;

    this.renderer.setRenderTarget(null);
  }
}
