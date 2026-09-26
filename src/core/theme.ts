import { hexToRgb, type RGB } from './math';

export type ThemeName = 'light' | 'dark';

export interface Palette {
  bg: RGB;
  ink: RGB;
  /** 光源 A（第一个人，鼠标光） */
  a: RGB;
  /** 光源 B（第二个人，游走光） */
  b: RGB;
  /** 浅色主题下的阴影色 */
  shadow: RGB;
  hex: { bg: string; ink: string; a: string; b: string };
}

const make = (bg: string, ink: string, a: string, b: string, shadow: string): Palette => ({
  bg: hexToRgb(bg),
  ink: hexToRgb(ink),
  a: hexToRgb(a),
  b: hexToRgb(b),
  shadow: hexToRgb(shadow),
  hex: { bg, ink, a, b },
});

export const palettes: Record<ThemeName, Palette> = {
  light: make('#FFFFFF', '#15101A', '#FF8899', '#FFDD88', '#E9E0E7'),
  dark: make('#000000', '#F4F1F6', '#77BBDD', '#F2ABE1', '#000000'),
};

/** 项目牌背景轮流使用的品牌色 */
export const cardColors = ['#FF8899', '#77BBDD', '#FFDD88', '#F2ABE1'];

const STORAGE_KEY = 'theme-override';
const systemQuery = matchMedia('(prefers-color-scheme: dark)');
type Listener = (t: ThemeName) => void;
const listeners = new Set<Listener>();

let override = localStorage.getItem(STORAGE_KEY) as ThemeName | null;

export const getTheme = (): ThemeName => override ?? (systemQuery.matches ? 'dark' : 'light');

const apply = () => {
  const t = getTheme();
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palettes[t].hex.bg);
  listeners.forEach((l) => l(t));
};

export const onThemeChange = (l: Listener) => listeners.add(l);

export const toggleTheme = () => {
  const next: ThemeName = getTheme() === 'dark' ? 'light' : 'dark';
  // 切回与系统一致时取消覆盖，恢复「跟随系统」
  const system: ThemeName = systemQuery.matches ? 'dark' : 'light';
  override = next === system ? null : next;
  if (override) localStorage.setItem(STORAGE_KEY, override);
  else localStorage.removeItem(STORAGE_KEY);
  apply();
};

systemQuery.addEventListener('change', () => {
  if (!override) apply();
});

apply();
