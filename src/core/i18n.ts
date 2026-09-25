import { siteConfig, type Localized } from '../config/site.config';

export type Lang = 'zh' | 'en';

const dict = {
  'nav.home': { zh: '首页', en: 'Home' },
  'nav.us': { zh: '我们', en: 'Us' },
  'nav.work': { zh: '作品', en: 'Work' },
  'nav.contact': { zh: '联系', en: 'Contact' },
  'loader.label': { zh: '正在点亮', en: 'Igniting light' },
  'hero.kicker': { zh: '追光实验 — 两个人的主页', en: 'Tracing light — a home for two' },
  'hero.hint': { zh: '移动光标，投下光影', en: 'Move to cast light' },
  'hero.hintTouch': { zh: '触摸屏幕，投下光影', en: 'Touch to cast light' },
  'hero.scroll': { zh: '向下滚动', en: 'Scroll to explore' },
  'scene.kicker': { zh: '体积光 · 深影', en: 'Volumetric light · deep shadow' },
  'us.kicker': { zh: '我们', en: 'Us' },
  'us.lightA': { zh: '跟随光标的光', en: 'The light that follows you' },
  'us.lightB': { zh: '四处游走的光', en: 'The light that wanders' },
  'us.aliases': { zh: '名字', en: 'Names' },
  'work.kicker': { zh: '作品', en: 'Work' },
  'work.title': { zh: '手中的牌', en: 'Cards on the table' },
  'work.hint': { zh: '悬停倾斜 · 点击打开', en: 'Hover to tilt · Click to open' },
  'work.hintTouch': { zh: '轻触牌面打开', en: 'Tap a card to open' },
  'contact.kicker': { zh: '联系', en: 'Contact' },
  'contact.title1': { zh: '打个招呼，', en: 'Say hello,' },
  'contact.title2': { zh: '随时都在。', en: 'anytime.' },
  'contact.email': { zh: '邮箱', en: 'Email' },
  'contact.elsewhere': { zh: '别处', en: 'Elsewhere' },
  'footer.built': { zh: '以光与影构建', en: 'Built with light & shadow' },
  'footer.top': { zh: '回到顶部', en: 'Back to top' },
  'ui.theme': { zh: '切换明暗', en: 'Toggle theme' },
  'ui.lang': { zh: 'Switch to English', en: '切换到中文' },
  'fallback.webgl': { zh: '当前浏览器不支持 WebGL，已显示静态版本。', en: 'WebGL is unavailable — showing a static version.' },
} satisfies Record<string, Localized>;

export type DictKey = keyof typeof dict;

const STORAGE_KEY = 'lang';
const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
let lang: Lang = saved ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');

type Listener = (l: Lang) => void;
const listeners = new Set<Listener>();

export const getLang = () => lang;
export const t = (key: DictKey) => dict[key][lang];
export const tl = (v: Localized) => v[lang];
export const onLangChange = (l: Listener) => listeners.add(l);

export const applyLang = () => {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = tl(siteConfig.title);
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as DictKey);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria as DictKey));
  });
  listeners.forEach((l) => l(lang));
};

export const toggleLang = () => {
  lang = lang === 'zh' ? 'en' : 'zh';
  localStorage.setItem(STORAGE_KEY, lang);
  applyLang();
};
