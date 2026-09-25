import { motion } from './env';
import { rand } from './math';

/**
 * 克制的不规则频闪：像接触不良的灯管。
 * - 每个实例独立随机 → 两盏灯不对称
 * - 闪烁间隔 ≥ 350ms（< 3Hz），幅度温和，避免光敏风险
 * - prefers-reduced-motion 时始终返回 1
 */
export class Flicker {
  private next = rand(2.5, 6);
  private dips: { start: number; dur: number; depth: number }[] = [];
  private seed = Math.random() * 100;

  constructor(private minGap = 3, private maxGap = 9) {}

  value(t: number): number {
    if (motion.reduced) return 1;

    if (t >= this.next) {
      const count = Math.random() < 0.35 ? 1 : Math.random() < 0.7 ? 2 : 3;
      let s = t;
      this.dips = [];
      for (let i = 0; i < count; i++) {
        this.dips.push({ start: s, dur: rand(0.07, 0.16), depth: rand(0.18, 0.42) });
        s += rand(0.36, 0.62);
      }
      this.next = s + rand(this.minGap, this.maxGap);
    }

    let v = 1;
    for (const d of this.dips) {
      const x = (t - d.start) / d.dur;
      if (x > 0 && x < 1) v -= d.depth * Math.sin(Math.PI * x);
    }
    // 缓慢的呼吸脉冲 + 极轻微的电流嗡鸣
    const pulse = 0.035 * Math.sin(t * 0.9 + this.seed) + 0.015 * Math.sin(t * 2.3 + this.seed * 3);
    return Math.max(0.35, v + pulse);
  }
}

/**
 * Akari 式灯管频闪：平时稳定，偶尔一阵快速的明灭。
 * 每次明灭 90–200ms（≤ 5Hz），熄灭时保留约 20% 余光而非全黑，
 * 一阵最多 5 次；prefers-reduced-motion 时始终返回 1。
 */
export class Strobe {
  private next = rand(1.5, 5);
  private toggles: { t: number; on: boolean }[] = [];

  value(t: number): number {
    if (motion.reduced) return 1;
    if (t >= this.next) {
      const n = 2 + Math.floor(Math.random() * 4);
      let s = t;
      this.toggles = [];
      for (let i = 0; i < n; i++) {
        this.toggles.push({ t: s, on: i % 2 === 1 });
        s += rand(0.09, 0.2);
      }
      this.toggles.push({ t: s, on: true });
      this.next = s + rand(3, 10);
    }
    let on = true;
    for (const tg of this.toggles) if (t >= tg.t) on = tg.on;
    return on ? 1 : 0.2;
  }
}
