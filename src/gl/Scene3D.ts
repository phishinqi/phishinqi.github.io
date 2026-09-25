import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { lerp } from '../core/math';

/**
 * 滚动后的 3D 体积光场景
 *  - 浅色主题：和纸灯笼（光透过纸面柔和扩散）
 *  - 深色主题：玻璃几何体（冷光折射）
 *  两盏聚光灯 = 两个人；带体积光锥、飘浮尘埃、深阴影。
 */

export interface SceneState {
  theme: number; // 0 浅 → 1 深
  pointer: THREE.Vector2; // -1..1
  progress: number; // 场景段滚动进度 0..1
  colorA: THREE.Color; // 线性空间
  colorB: THREE.Color;
  bg: THREE.Color;
  ia: number;
  ib: number;
}

const CONE_VERT = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vAlong;
  void main() {
    vAlong = position.z;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const CONE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vAlong;

  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  void main() {
    vec3 v = normalize(cameraPosition - vWorld);
    float ndv = abs(dot(normalize(vNormalW), v));
    float edge = pow(ndv, 3.5);
    float z = clamp(vAlong, 0.0, 1.0);
    float along = smoothstep(0.0, 0.1, z) * (1.0 - smoothstep(0.7, 1.0, z)) * mix(1.0, 0.5, z);
    float haze = 0.65 + 0.35 * noise(vWorld * 1.3 + vec3(0.0, -uTime * 0.25, uTime * 0.1));
    float a = edge * along * haze * uIntensity;
    gl_FragColor = vec4(uColor, a);
  }
`;

const LANTERN_VERT = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = -mv.xyz;
    vNormalV = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

const LANTERN_FRAG = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uEdge;
  uniform float uGlow;
  uniform float uRibs;
  varying vec3 vNormalV;
  varying vec3 vViewPos;
  varying vec2 vUv;
  void main() {
    float ndv = clamp(dot(normalize(vNormalV), normalize(vViewPos)), 0.0, 1.0);
    // 光从内部透过和纸：正对视线处最亮（光穿过的纸层最薄），边缘偏向纸色
    float trans = pow(ndv, 1.4);
    vec3 col = mix(uEdge * 0.7, uCore * 1.25, trans) * uGlow;
    // 横向竹骨
    float rib = abs(fract(vUv.y * uRibs) - 0.5);
    col *= mix(0.55, 1.0, smoothstep(0.0, 0.12, rib));
    // 纸的纤维
    float fiber = fract(sin(dot(floor(vUv * vec2(220.0, 90.0)), vec2(12.99, 78.23))) * 43758.5);
    col *= 0.94 + fiber * 0.06;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const DUST_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  attribute float aSeed;
  varying float vTwinkle;
  void main() {
    vec3 p = position;
    p.y = mod(p.y + uTime * (0.05 + aSeed * 0.08), 8.0) - 0.5;
    p.x += sin(uTime * 0.3 + aSeed * 40.0) * 0.25;
    p.z += cos(uTime * 0.25 + aSeed * 30.0) * 0.25;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vTwinkle = 0.45 + 0.55 * sin(uTime * (1.0 + aSeed * 2.0) + aSeed * 60.0);
    gl_PointSize = uSize * (0.5 + aSeed) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vTwinkle;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vTwinkle * uOpacity;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

interface Floater {
  mesh: THREE.Object3D;
  base: THREE.Vector3;
  speed: number;
  phase: number;
  spin: THREE.Vector3;
}

export class Scene3D {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;

  private lanternGroup = new THREE.Group();
  private glassGroup = new THREE.Group();
  private lanterns: Floater[] = [];
  private glass: Floater[] = [];
  private lanternMats: THREE.ShaderMaterial[] = [];
  private lanternLights: THREE.PointLight[] = [];

  private spots: THREE.SpotLight[] = [];
  private cones: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>[] = [];
  private floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private hemi: THREE.HemisphereLight;
  private dust: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private fog: THREE.Fog;
  private camTarget = new THREE.Vector3(0, 1.5, 0);
  private lookPointer = new THREE.Vector2();

  constructor(private renderer: THREE.WebGLRenderer, private low: boolean) {
    this.fog = new THREE.Fog(0x000000, 11, 30);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x000000);

    // ── 地面：无限延伸的影棚地面，雾化到背景色
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
    this.scene.add(this.hemi);

    this.buildSpots();
    this.buildLanterns();
    this.buildGlass();
    this.dust = this.buildDust();
    this.scene.add(this.lanternGroup, this.glassGroup, this.dust);

    this.composer = new EffectComposer(renderer);
    this.composer.renderToScreen = false;
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.65, 0.8);
    this.composer.addPass(this.bloom);
  }

  private buildSpots() {
    const positions = [new THREE.Vector3(-4.5, 7.5, 3.5), new THREE.Vector3(5, 7, 2.5)];
    const coneGeo = new THREE.ConeGeometry(Math.tan(0.42), 1, 48, 1, true);
    coneGeo.translate(0, -0.5, 0);
    coneGeo.rotateX(-Math.PI / 2);

    positions.forEach((p, i) => {
      const spot = new THREE.SpotLight(0xffffff, 80, 40, 0.42, 0.75, 1.4);
      spot.position.copy(p);
      spot.castShadow = !this.low || i === 0;
      spot.shadow.mapSize.setScalar(this.low ? 512 : 1024);
      spot.shadow.bias = -0.0004;
      spot.shadow.radius = 6;
      spot.shadow.camera.near = 1;
      spot.shadow.camera.far = 30;
      this.scene.add(spot, spot.target);
      this.spots.push(spot);

      const cone = new THREE.Mesh(
        coneGeo,
        new THREE.ShaderMaterial({
          vertexShader: CONE_VERT,
          fragmentShader: CONE_FRAG,
          uniforms: { uColor: { value: new THREE.Color() }, uIntensity: { value: 0.3 }, uTime: { value: 0 } },
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        }),
      );
      cone.position.copy(p);
      cone.renderOrder = 10;
      this.scene.add(cone);
      this.cones.push(cone);
    });
  }

  private buildLanterns() {
    // 灯笼轮廓：扁球形，上下留开口
    const pts: THREE.Vector2[] = [];
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const y = lerp(-0.92, 0.92, t);
      const r = Math.pow(Math.max(0, 1 - y * y), 0.62) * 0.95 + 0.08;
      pts.push(new THREE.Vector2(r, y * 1.1));
    }
    const bodyGeo = new THREE.LatheGeometry(pts, this.low ? 32 : 64);
    const capGeo = new THREE.CylinderGeometry(0.28, 0.3, 0.12, 32);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x1a1214, roughness: 0.6 });
    const stringGeo = new THREE.CylinderGeometry(0.006, 0.006, 10, 6);
    stringGeo.translate(0, 5, 0);

    const layout = [
      { p: [-3.6, 2.9, -1.2], s: 0.9 },
      { p: [-1.2, 3.4, -2.6], s: 0.75 },
      { p: [0.6, 2.4, 0.2], s: 1.05 },
      { p: [2.7, 3.1, -1.4], s: 0.8 },
      { p: [4.4, 2.2, -3.0], s: 0.65 },
    ];

    layout.forEach((l, i) => {
      const g = new THREE.Group();
      const mat = new THREE.ShaderMaterial({
        vertexShader: LANTERN_VERT,
        fragmentShader: LANTERN_FRAG,
        uniforms: {
          uCore: { value: new THREE.Color() },
          uEdge: { value: new THREE.Color() },
          uGlow: { value: 1 },
          uRibs: { value: 14 + (i % 3) * 3 },
        },
      });
      this.lanternMats.push(mat);
      const body = new THREE.Mesh(bodyGeo, mat);
      body.castShadow = true;
      const top = new THREE.Mesh(capGeo, capMat);
      top.position.y = 1.08;
      const bottom = top.clone();
      bottom.position.y = -1.08;
      top.castShadow = bottom.castShadow = true;
      const string = new THREE.Mesh(stringGeo, capMat);
      string.position.y = 1.1;
      g.add(body, top, bottom, string);
      g.scale.setScalar(l.s);
      g.position.set(l.p[0], l.p[1], l.p[2]);

      if (!this.low || i % 2 === 0) {
        const pl = new THREE.PointLight(0xffcc88, 0, 7, 1.6);
        g.add(pl);
        this.lanternLights.push(pl);
      }

      this.lanternGroup.add(g);
      this.lanterns.push({
        mesh: g,
        base: g.position.clone(),
        speed: 0.4 + Math.random() * 0.4,
        phase: Math.random() * 10,
        spin: new THREE.Vector3(0, 0.15 + Math.random() * 0.2, 0),
      });
    });
  }

  private buildGlass() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const glassMat = this.low
      ? new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          metalness: 0.1,
          roughness: 0.05,
          transparent: true,
          opacity: 0.35,
          envMap: env,
          envMapIntensity: 1.4,
          clearcoat: 1,
        })
      : new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          metalness: 0,
          roughness: 0.08,
          transmission: 1,
          thickness: 1.4,
          ior: 1.5,
          dispersion: 4,
          iridescence: 0.35,
          iridescenceIOR: 1.3,
          envMap: env,
          envMapIntensity: 0.55,
          attenuationColor: new THREE.Color(0.85, 0.9, 1),
          attenuationDistance: 3,
          clearcoat: 1,
          clearcoatRoughness: 0.05,
        });
    const matte = new THREE.MeshStandardMaterial({ color: 0x0b0b0e, roughness: 0.55, metalness: 0.2 });

    const shapes: { g: THREE.BufferGeometry; p: number[]; s: number; m?: THREE.Material }[] = [
      { g: new THREE.IcosahedronGeometry(1, 0), p: [-3.4, 2.4, -1], s: 0.95 },
      { g: new THREE.TorusGeometry(0.8, 0.28, 32, 96), p: [0.4, 2.9, -0.2], s: 1.1 },
      { g: new THREE.OctahedronGeometry(1, 0), p: [3.2, 2.1, -1.5], s: 0.9 },
      { g: new RoundedBoxGeometry(1.3, 1.3, 1.3, 4, 0.18), p: [-1.2, 1.3, 1.4], s: 0.7 },
      { g: new THREE.DodecahedronGeometry(1, 0), p: [1.9, 3.8, -3.2], s: 0.7 },
      { g: new THREE.CapsuleGeometry(0.45, 1.2, 8, 24), p: [-4.8, 3.6, -3.4], s: 0.8 },
      { g: new THREE.SphereGeometry(0.8, 48, 32), p: [4.6, 1.2, 0.6], s: 0.75, m: matte },
      { g: new THREE.TorusKnotGeometry(0.55, 0.18, 128, 16), p: [-2.2, 3.9, -2.6], s: 0.75, m: matte },
    ];

    for (const sh of shapes) {
      const mesh = new THREE.Mesh(sh.g, sh.m ?? glassMat);
      mesh.castShadow = true;
      mesh.position.set(sh.p[0], sh.p[1], sh.p[2]);
      mesh.scale.setScalar(sh.s);
      this.glassGroup.add(mesh);
      this.glass.push({
        mesh,
        base: mesh.position.clone(),
        speed: 0.3 + Math.random() * 0.4,
        phase: Math.random() * 10,
        spin: new THREE.Vector3(Math.random() * 0.3, 0.2 + Math.random() * 0.3, Math.random() * 0.2),
      });
    }
  }

  private buildDust() {
    const count = this.low ? 260 : 700;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 16;
      pos[i * 3 + 1] = Math.random() * 8;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 10;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    return new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uSize: { value: 60 * Math.min(devicePixelRatio, 2) },
          uColor: { value: new THREE.Color() },
          uOpacity: { value: 0.6 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
  }

  setSize(w: number, h: number, dpr: number) {
    this.camera.aspect = w / h;
    // 超宽屏时拉远视野，保持构图
    this.camera.fov = w / h > 2 ? 28 : w / h < 0.8 ? 48 : 34;
    this.camera.updateProjectionMatrix();
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
  }

  update(t: number, dt: number, s: SceneState) {
    const light = 1 - s.theme;
    const dark = s.theme;

    // ── 背景 / 雾 / 地面
    (this.scene.background as THREE.Color).copy(s.bg);
    this.fog.color.copy(s.bg);
    this.floor.material.color.setRGB(lerp(1, 0.028, dark), lerp(0.97, 0.028, dark), lerp(0.98, 0.036, dark));
    this.floor.material.roughness = lerp(0.85, 0.35, dark);
    this.hemi.intensity = lerp(3.0, 0.08, dark);
    this.hemi.color.setRGB(1, lerp(0.97, 0.9, dark), lerp(0.97, 1, dark));
    this.hemi.groundColor.copy(s.bg).multiplyScalar(0.6);
    this.bloom.threshold = lerp(1.05, 0.55, dark);
    this.bloom.strength = lerp(0.55, 0.9, dark);

    // ── 两盏聚光灯：方向跟随指针
    this.lookPointer.x = lerp(this.lookPointer.x, s.pointer.x, 1 - Math.exp(-3 * dt));
    this.lookPointer.y = lerp(this.lookPointer.y, s.pointer.y, 1 - Math.exp(-3 * dt));
    const lp = this.lookPointer;
    const targets = [
      new THREE.Vector3(lp.x * 3.5 - 0.6, 0, -lp.y * 2 - 0.2),
      new THREE.Vector3(-lp.x * 2 + 1.4 + Math.sin(t * 0.3) * 1.2, 0, -0.8 + Math.cos(t * 0.23) * 1.2),
    ];
    const cols = [s.colorA, s.colorB];
    const ints = [s.ia, s.ib];
    this.spots.forEach((spot, i) => {
      spot.target.position.copy(targets[i]);
      spot.color.copy(cols[i]);
      spot.intensity = lerp(150, 320, dark) * ints[i];
      const cone = this.cones[i];
      const dist = spot.position.distanceTo(targets[i]) * 1.05;
      cone.scale.setScalar(dist);
      cone.lookAt(targets[i]);
      const cu = cone.material.uniforms;
      cu.uColor.value.copy(cols[i]);
      cu.uIntensity.value = lerp(0.16, 0.22, dark) * ints[i];
      cu.uTime.value = t;
      cone.material.blending = dark > 0.5 ? THREE.AdditiveBlending : THREE.NormalBlending;
    });

    // ── 主题形态过渡：灯笼 ↔ 玻璃
    const lScale = easeScale(light);
    const gScale = easeScale(dark);
    this.lanternGroup.visible = lScale > 0.001;
    this.glassGroup.visible = gScale > 0.001;
    this.lanternGroup.scale.setScalar(lScale);
    this.glassGroup.scale.setScalar(gScale);
    this.lanternGroup.rotation.y = (1 - lScale) * 1.2;
    this.glassGroup.rotation.y = (1 - gScale) * -1.2;
    this.lanternGroup.position.y = (1 - lScale) * 3;
    this.glassGroup.position.y = (1 - gScale) * -1.5;

    this.lanterns.forEach((f, i) => {
      const m = f.mesh;
      m.position.y = f.base.y + Math.sin(t * f.speed + f.phase) * 0.12;
      m.rotation.z = Math.sin(t * f.speed * 0.8 + f.phase) * 0.05;
      m.rotation.y += f.spin.y * dt;
      const mat = this.lanternMats[i];
      const warm = i % 2 === 0 ? s.colorB : s.colorA;
      const flick = i % 2 === 0 ? ints[1] : ints[0];
      mat.uniforms.uCore.value.copy(warm).lerp(new THREE.Color(1, 0.95, 0.85), 0.2);
      mat.uniforms.uEdge.value.copy(i % 2 === 0 ? s.colorA : s.colorB).multiplyScalar(0.8);
      mat.uniforms.uGlow.value = 1.35 * flick;
    });
    this.lanternLights.forEach((pl, i) => {
      pl.color.copy(i % 2 === 0 ? s.colorB : s.colorA);
      pl.intensity = 5 * lScale;
    });

    this.glass.forEach((f) => {
      const m = f.mesh;
      m.position.y = f.base.y + Math.sin(t * f.speed + f.phase) * 0.25;
      m.rotation.x += f.spin.x * dt;
      m.rotation.y += f.spin.y * dt;
      m.rotation.z += f.spin.z * dt;
    });

    // ── 尘埃
    const du = this.dust.material.uniforms;
    du.uTime.value = t;
    du.uColor.value.copy(s.colorA).lerp(s.colorB, 0.5);
    du.uOpacity.value = lerp(0.9, 0.7, dark);
    this.dust.material.blending = dark > 0.5 ? THREE.AdditiveBlending : THREE.NormalBlending;

    // ── 相机：随滚动推近，指针视差
    const p = s.progress;
    const cam = this.camera;
    const tx = lp.x * 0.6;
    const ty = lerp(2.6, 1.9, p) + lp.y * 0.3;
    const tz = lerp(12, 8.2, p);
    cam.position.x = lerp(cam.position.x, tx, 1 - Math.exp(-2.5 * dt));
    cam.position.y = lerp(cam.position.y, ty, 1 - Math.exp(-2.5 * dt));
    cam.position.z = lerp(cam.position.z, tz, 1 - Math.exp(-2.5 * dt));
    this.camTarget.set(lp.x * 0.3, lerp(1.9, 2.1, p), 0);
    cam.lookAt(this.camTarget);
  }

  render(): THREE.Texture {
    this.composer.render();
    return this.composer.readBuffer.texture;
  }
}

function easeScale(x: number) {
  const t = Math.min(1, Math.max(0, (x - 0.15) / 0.85));
  return t * t * (3 - 2 * t);
}
