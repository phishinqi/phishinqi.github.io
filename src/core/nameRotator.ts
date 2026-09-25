import { motion } from './env';

const NOISE = '@&%$!?|▓▒░/\<>#*+=_¦';

/**
 * 名字轮播：切换时逐字「解码」，未解出的字符用随机字形 → 乱码 + 频闪过渡。
 * 订阅者每一帧收到当前显示字符串与 glitch 强度（0–1）。
 */
export class NameRotator {
  index = 0;
  display: string;
  glitch = 0;
  private pool: string;
  private from = '';
  private start = -1;
  private lastTick = 0;
  private listeners = new Set<(s: string, glitch: number) => void>();
  private duration = 0.9;
  private frame = -1;

  constructor(private names: string[], private interval: number) {
    this.display = names[0];
    this.pool = Array.from(new Set(names.join('').replace(/\s/g, ''))).join('') + NOISE;
  }

  get current() {
    return this.names[this.index];
  }

  subscribe(fn: (s: string, glitch: number) => void) {
    this.listeners.add(fn);
    fn(this.display, 0);
  }

  update(t: number) {
    if (this.names.length < 2) return;
    if (this.lastTick === 0) this.lastTick = t;

    if (this.start < 0 && t - this.lastTick > this.interval / 1000) {
      this.from = this.current;
      this.index = (this.index + 1) % this.names.length;
      this.start = t;
      this.lastTick = t;
    }
    if (this.start < 0) return;

    const p = (t - this.start) / this.duration;
    if (p >= 1) {
      this.start = -1;
      this.glitch = 0;
      this.emit(this.current);
      return;
    }

    if (motion.reduced) {
      this.glitch = 0;
      this.emit(p < 0.5 ? this.from : this.current);
      return;
    }

    // 限制乱码刷新频率 ~22fps，避免刺眼
    const frame = Math.floor(p * 20);
    if (frame === this.frame) return;
    this.frame = frame;

    const target = Array.from(this.current);
    const src = Array.from(this.from);
    const len = Math.round(src.length + (target.length - src.length) * Math.min(1, p * 1.6));
    const resolved = Math.floor(Math.max(0, p - 0.25) / 0.75 * target.length);
    let s = '';
    for (let i = 0; i < len; i++) {
      if (i < resolved) s += target[i] ?? '';
      else s += this.pool[(Math.random() * this.pool.length) | 0];
    }
    this.glitch = Math.sin(Math.PI * p);
    this.emit(s);
  }

  private emit(s: string) {
    this.display = s;
    this.listeners.forEach((l) => l(s, this.glitch));
  }
}
