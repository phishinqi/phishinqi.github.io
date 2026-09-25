import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * 首屏 2D 光线追踪（致敬 akari.lusion.co）
 *
 *   遮挡物（名字） ─seed─▶ JFA 跳跃泛洪 ─▶ 距离场（线性插值，消除阶梯）
 *                                            │
 *   横向灯管 + 圆形光源（面光源） ── 多点采样的软阴影 ──▶ 光照（低分辨率，天然柔和）
 *                                            │
 *   移动的灯管 ── 扫掠光晕 + 反馈衰减 ──▶ 体积光拖尾
 *
 * 文字（平涂剪影）与灯管本体在合成阶段以全分辨率绘制。
 */

export const MAX_TUBES = 8;

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

const lightFrag = (samples: number) => /* glsl */ `
  #define MAX_TUBES ${MAX_TUBES}
  #define SAMPLES ${samples}
  uniform sampler2D uDist;
  uniform float uAspect;
  uniform vec4 uSeg[MAX_TUBES];
  uniform vec3 uCol[MAX_TUBES];
  uniform float uInt[MAX_TUBES];
  uniform float uRad[MAX_TUBES];
  uniform int uCount;
  uniform float uRadius;
  uniform float uAmbient;
  uniform float uTheme;
  uniform vec3 uBgL, uBgD, uShadowL;
  varying vec2 vUv;

  ${SEGMENT_GLSL}

  vec2 asp(vec2 v) { return v * vec2(uAspect, 1.0); }
  float sdf(vec2 uv) { return texture2D(uDist, uv).r; }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  // 软阴影：半影宽度随「遮挡物 → 像素」距离线性增大
  float softShadow(vec2 p, vec2 l) {
    vec2 d = asp(l - p);
    float dist = length(d);
    vec2 dir = d / max(dist, 1e-5);
    float res = 1.0;
    // 起点抖动：把步进产生的条纹打散成不可见的细噪
    float t = 0.004 + hash(p * 917.0) * 0.005;
    for (int i = 0; i < 28; i++) {
      if (t >= dist - 0.004) break;
      float h = sdf(p + (dir * t) / vec2(uAspect, 1.0));
      res = min(res, h / (t * 0.5));
      if (res < 0.002) return 0.0;
      t += max(h, 0.005);
    }
    res = clamp(res, 0.0, 1.0);
    return res * res * (3.0 - 2.0 * res);
  }

  float falloff(float r) {
    return exp(-r * r / (uRadius * uRadius)) * 0.75 + 0.25 / (1.0 + r * r * 40.0);
  }

  void main() {
    vec2 p = vUv;
    bool inside = sdf(p) < 0.0008;

    vec3 lit = vec3(0.0);
    vec3 litLin = vec3(0.0);
    float L = 0.0;
    for (int i = 0; i < MAX_TUBES; i++) {
      if (i >= uCount) break;
      vec2 a = uSeg[i].xy, b = uSeg[i].zw;
      vec2 c = closestOnSeg(p, a, b, uAspect);
      float f = falloff(length(asp(p - c))) * uInt[i];
      if (f < 0.01) continue;
      // 文字内部取半遮挡：上采样后字缘只留一圈很淡的接触阴影
      float sh = 0.5;
      if (!inside) {
        #if SAMPLES == 1
          sh = softShadow(p, c);
        #else
          vec2 c1, c2;
          if (uRad[i] > 0.0) {
            // 圆形光源：在圆盘上垂直于视线方向取两侧边缘点
            vec2 toP = normalize(asp(p - c));
            vec2 perp = vec2(-toP.y, toP.x) * uRad[i] * 1.6 / vec2(uAspect, 1.0);
            c1 = c - perp;
            c2 = c + perp;
          } else {
            // 灯管：在管身上 c 两侧再各取一点，长灯管 → 宽半影
            vec2 along = (b - a) * 0.4;
            c1 = clamp(c - along, min(a, b), max(a, b));
            c2 = clamp(c + along, min(a, b), max(a, b));
          }
          sh = (softShadow(p, c) * 2.0 + softShadow(p, c1) + softShadow(p, c2)) * 0.25;
        #endif
      }
      lit += uCol[i] * f * sh;
      litLin += pow(uCol[i], vec3(2.2)) * f * sh;
      L += f * sh;
    }

    // ── 深色：黑底被彩色灯管的漫射光铺满
    // 在线性空间累加再转回 sRGB：粉彩色光也能保持饱和，灯管之间留出暗部。
    // uAmbient 是不受遮挡的环境底色：阴影最深处与字内封闭空隙呈深灰而非纯黑，与纯黑字身区分
    vec3 dark = pow(1.0 - exp(-(uBgD + litLin + uAmbient) * 0.8), vec3(1.0 / 2.2));

    // ── 浅色：白纸被彩光照亮，被遮挡处落入深影；远离文字处由环境光补亮
    vec3 tint = lit / max(L, 1e-3);
    float fill = smoothstep(0.02, 0.5, sdf(p)) * 0.55;
    vec3 base = mix(uShadowL, uBgL, max(smoothstep(0.0, 0.45, L), fill));
    vec3 light = base * mix(vec3(1.0), tint, clamp(L, 0.0, 1.0) * 0.22);

    gl_FragColor = vec4(mix(light, dark, uTheme), 1.0);
  }
`;

const TRAIL_FRAG = /* glsl */ `
  uniform sampler2D uPrev;
  uniform float uAspect, uDecay;
  uniform vec4 uCur[2];
  uniform vec4 uPrevSeg[2];
  uniform vec3 uCol[2];
  uniform float uInt[2];
  uniform float uMove[2];
  varying vec2 vUv;

  ${SEGMENT_GLSL}

  void main() {
    vec3 acc = texture2D(uPrev, vUv).rgb * uDecay;
    for (int i = 0; i < 2; i++) {
      // 在上一帧与当前帧之间插值 4 段，得到扫掠形状（运动模糊）
      float g = 0.0;
      for (int k = 0; k < 4; k++) {
        vec4 seg = mix(uPrevSeg[i], uCur[i], float(k) / 3.0);
        float d = segDist(vUv, seg.xy, seg.zw, uAspect);
        g = max(g, exp(-d * d / 0.0006));
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
  intensity: number;
  /** 圆形光源半径（屏高为单位）；灯管为 0 */
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
  /** 需要拖尾的两根移动灯管（鼠标灯管、游走灯管）及其上一帧端点 */
  moving: { cur: Tube; prevA: THREE.Vector2; prevB: THREE.Vector2 }[];
  theme: number;
  radius: number;
  bgL: THREE.Vector3;
  bgD: THREE.Vector3;
  shadowL: THREE.Vector3;
  trailDecay: number;
}

const rt = (w: number, h: number, filter: THREE.MagnificationTextureFilter) =>
  new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: false,
    generateMipmaps: false,
  });

const vec4s = (n: number) => Array.from({ length: n }, () => new THREE.Vector4());
const vec3s = (n: number) => Array.from({ length: n }, () => new THREE.Vector3());

export class LightField {
  readonly maskCanvas = document.createElement('canvas');
  readonly maskTexture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private scratch = document.createElement('canvas');

  private seedA = rt(4, 4, THREE.NearestFilter);
  private seedB = rt(4, 4, THREE.NearestFilter);
  private distRT = rt(4, 4, THREE.LinearFilter);
  readonly lightRT = rt(4, 4, THREE.LinearFilter);
  private trailA = rt(4, 4, THREE.LinearFilter);
  private trailB = rt(4, 4, THREE.LinearFilter);
  trailTexture = this.trailA.texture;

  private quad = new FullScreenQuad();
  private seedMat: THREE.ShaderMaterial;
  private jfaMat: THREE.ShaderMaterial;
  private distMat: THREE.ShaderMaterial;
  private lightMat: THREE.ShaderMaterial;
  private trailMat: THREE.ShaderMaterial;

  private simW = 4;
  private simH = 4;
  private aspect = 1;
  private dirty = true;
  private fontSize = 100;
  private twoLines = false;
  /** 文字外框（uv，按最宽的名字组合计算，轮播时保持稳定） */
  textRect: Rect = { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 };

  constructor(private renderer: THREE.WebGLRenderer, private simScale: number, samples: 1 | 3) {
    this.ctx = this.maskCanvas.getContext('2d')!;
    this.maskTexture = new THREE.CanvasTexture(this.maskCanvas);
    this.maskTexture.minFilter = THREE.LinearFilter;
    this.maskTexture.generateMipmaps = false;

    const mat = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });

    this.seedMat = mat(SEED_FRAG, { uMask: { value: this.maskTexture } });
    this.jfaMat = mat(JFA_FRAG, { uSeed: { value: null }, uStep: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
    this.distMat = mat(DIST_FRAG, { uSeed: { value: null }, uAspect: { value: 1 } });
    this.lightMat = mat(lightFrag(samples), {
      uDist: { value: this.distRT.texture },
      uAspect: { value: 1 },
      uSeg: { value: vec4s(MAX_TUBES) },
      uCol: { value: vec3s(MAX_TUBES) },
      uInt: { value: new Array(MAX_TUBES).fill(0) },
      uRad: { value: new Array(MAX_TUBES).fill(0) },
      uCount: { value: 0 },
      uRadius: { value: 0.5 },
      uAmbient: { value: 0.0075 },
      uTheme: { value: 0 },
      uBgL: { value: new THREE.Vector3() },
      uBgD: { value: new THREE.Vector3() },
      uShadowL: { value: new THREE.Vector3() },
    });
    this.trailMat = mat(TRAIL_FRAG, {
      uPrev: { value: null },
      uAspect: { value: 1 },
      uDecay: { value: 0.9 },
      uCur: { value: vec4s(2) },
      uPrevSeg: { value: vec4s(2) },
      uCol: { value: vec3s(2) },
      uInt: { value: [0, 0] },
      uMove: { value: [0, 0] },
    });
  }

  setSize(cssW: number, cssH: number, dpr: number) {
    this.aspect = cssW / cssH;
    const fullScale = Math.min(dpr, 2560 / cssW);
    this.maskCanvas.width = Math.round(cssW * fullScale);
    this.maskCanvas.height = Math.round(cssH * fullScale);
    this.scratch.width = this.maskCanvas.width;
    this.scratch.height = this.maskCanvas.height;
    // 画布尺寸变化后必须重新分配 GPU 纹理，否则会按旧尺寸做子区域拷贝
    this.maskTexture.dispose();

    this.simW = Math.max(64, Math.round(Math.min(cssW * this.simScale, 1100)));
    this.simH = Math.max(64, Math.round(this.simW / this.aspect));
    for (const t of [this.seedA, this.seedB, this.distRT, this.lightRT, this.trailA, this.trailB]) t.setSize(this.simW, this.simH);

    this.twoLines = this.aspect < 1.15;
    this.dirty = true;
  }

  private font(size: number) {
    return `500 ${size}px "Outfit", "Noto Sans SC", sans-serif`;
  }

  private ampFont(size: number) {
    return `400 ${size}px "Outfit", sans-serif`;
  }

  private setFont(f: string) {
    this.ctx.font = f;
    // 收紧字距，得到 Akari 字标般的紧凑块面
    if ('letterSpacing' in this.ctx) (this.ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '-0.02em';
  }

  /** 以所有候选名字中最宽的组合计算字号，轮播时字号稳定不跳动 */
  layout(candidatesA: string[], candidatesB: string[]) {
    const W = this.maskCanvas.width;
    const H = this.maskCanvas.height;
    const ctx = this.ctx;
    this.setFont(this.ampFont(100));
    const amp = ctx.measureText(' & ').width;
    this.setFont(this.font(100));
    let widest = 0;
    for (const a of candidatesA) {
      for (const b of candidatesB) {
        const wa = ctx.measureText(a).width;
        const wb = ctx.measureText(b).width;
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

    this.setFont(this.ampFont(size));
    const amp = ctx.measureText(' & ').width;
    this.setFont(this.font(size));
    const wa = ctx.measureText(a).width;
    const wb = ctx.measureText(b).width;
    const cy = H * 0.5;

    const drawAmp = (x: number, y: number) => {
      this.setFont(this.ampFont(size));
      ctx.fillText(' & ', x, y);
      this.setFont(this.font(size));
    };

    if (this.twoLines) {
      const y1 = cy - size * 0.12;
      const y2 = cy + size * 0.92;
      const x1 = (W - (wa + amp)) / 2;
      ctx.fillText(a, x1, y1);
      drawAmp(x1 + wa, y1);
      ctx.fillText(b, (W - wb) / 2, y2);
    } else {
      const x = (W - (wa + amp + wb)) / 2;
      const y = cy + size * 0.33;
      ctx.fillText(a, x, y);
      drawAmp(x + wa, y);
      ctx.fillText(b, x + wa + amp, y);
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
    const steps: number[] = [];
    for (let s = 1 << Math.ceil(Math.log2(Math.max(this.simW, this.simH)) - 1); s >= 1; s >>= 1) steps.push(s);
    steps.push(1); // 1+JFA：额外一轮修正误差
    for (const s of steps) {
      this.jfaMat.uniforms.uSeed.value = read.texture;
      this.jfaMat.uniforms.uStep.value.set(s / this.simW, s / this.simH);
      this.pass(this.jfaMat, write);
      [read, write] = [write, read];
    }
    this.distMat.uniforms.uSeed.value = read.texture;
    this.distMat.uniforms.uAspect.value = this.aspect;
    this.pass(this.distMat, this.distRT);
  }

  render(s: LightState) {
    if (this.dirty) {
      this.computeDistanceField();
      this.dirty = false;
    }

    const u = this.lightMat.uniforms;
    u.uAspect.value = this.aspect;
    u.uCount.value = Math.min(s.tubes.length, MAX_TUBES);
    s.tubes.slice(0, MAX_TUBES).forEach((t, i) => {
      u.uSeg.value[i].set(t.a.x, t.a.y, t.b.x, t.b.y);
      u.uCol.value[i].copy(t.color);
      u.uInt.value[i] = t.intensity;
      u.uRad.value[i] = t.radius;
    });
    u.uTheme.value = s.theme;
    u.uRadius.value = s.radius;
    u.uBgL.value.copy(s.bgL);
    u.uBgD.value.copy(s.bgD);
    u.uShadowL.value.copy(s.shadowL);
    this.pass(this.lightMat, this.lightRT);

    const tu = this.trailMat.uniforms;
    tu.uPrev.value = this.trailA.texture;
    tu.uAspect.value = this.aspect;
    tu.uDecay.value = s.trailDecay;
    s.moving.forEach((m, i) => {
      tu.uCur.value[i].set(m.cur.a.x, m.cur.a.y, m.cur.b.x, m.cur.b.y);
      tu.uPrevSeg.value[i].set(m.prevA.x, m.prevA.y, m.prevB.x, m.prevB.y);
      tu.uCol.value[i].copy(m.cur.color);
      tu.uInt.value[i] = m.cur.intensity;
      // 只有移动时才留下拖尾：位移越大越亮
      const moved = Math.hypot(m.cur.a.x - m.prevA.x, m.cur.a.y - m.prevA.y);
      tu.uMove.value[i] = Math.min(1, moved * 60);
    });
    this.pass(this.trailMat, this.trailB);
    [this.trailA, this.trailB] = [this.trailB, this.trailA];
    this.trailTexture = this.trailA.texture;

    this.renderer.setRenderTarget(null);
  }
}
