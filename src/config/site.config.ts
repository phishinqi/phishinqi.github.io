/**
 * ─────────────────────────────────────────────────────────────
 *  站点配置 / Site configuration
 * ─────────────────────────────────────────────────────────────
 *  所有可变内容都在这里：名字、项目、社交链接、邮箱、标语。
 *
 *  占位符规则：
 *    - 任何值写成 '{{...}}' 形式（或空字符串 ''）视为「未填写」，
 *      对应的链接 / 邮箱会自动隐藏，不会渲染出坏链接。
 *    - 填写真实值后即可显示，例如：
 *        url: 'https://github.com/your-id'
 *        email: 'hello@example.com'
 *
 *  新增项目：在 projects 数组里追加一条即可，会自动多一张牌。
 */

export type Localized = { zh: string; en: string };

export interface LinkItem {
  /** 显示文字，例如 GitHub / X / 小红书 */
  label: string;
  /** 链接地址；'{{...}}' 占位符或空字符串会被隐藏 */
  url: string;
}

export interface Person {
  id: string;
  /** 名字列表：多个时会以频闪 / 乱码过渡轮播 */
  names: string[];
  /** 个人邮箱（可选） */
  email: string;
  /** 个人社交链接 */
  links: LinkItem[];
}

export interface Project {
  /** 牌面标题（建议大写英文） */
  title: string;
  /** 牌背徽章与牌面像素字母，单个 A–Z 字母 */
  monogram: string;
  url: string;
  /** 4 条左右的要点，简约优先 */
  points: { zh: string[]; en: string[] };
}

export const siteConfig = {
  /** 浏览器标签页标题 */
  title: { zh: '鱼七 & astraRuri', en: 'Elarais & astraRuri' } as Localized,

  /** 名字轮播间隔（毫秒） */
  nameRotateInterval: 4000,

  /** 首屏光场 */
  hero: {
    /**
     * 光源与文字之间的安全距离（CSS 像素）。
     * 鼠标光、游走光和背景灯管都不会进入「文字外框 + 该距离」的范围。
     */
    lightSafeDistance: 100,
  },

  /** 两个人。顺序决定光源：第一个人 = 鼠标光，第二个人 = 游走光 */
  people: [
    {
      id: 'elarais',
      names: ['鱼七', '凉空桐鱼', '鱼七乐', 'Elarais'],
      email: 'anonnagasakiko@gmail.com',
      links: [
        { label: 'GitHub', url: 'https://github.com/phishinqi' },
        { label: 'X', url: 'https://x.com/Ryokoukiryu' },
        { label: 'Bilibili', url: 'https://space.bilibili.com/325126747' },
      ],
    },
    {
      id: 'astraruri',
      names: ['astraRuri'],
      email: '{{ASTRARURI_EMAIL}}',
      links: [
        { label: 'GitHub', url: 'https://github.com/astraruri' },
        { label: 'X', url: 'https://x.com/astraruri' },
      ],
    },
  ] as Person[],

  /** 3D 场景上的衬线标语 */
  tagline: {
    zh: '两束光，\n同一个房间。',
    en: 'Two lights,\none room.',
  } as Localized,

  /** 页脚联系方式（共同） */
  contact: {
    email: '{{SHARED_EMAIL}}',
    links: [
      { label: 'GitHub', url: 'https://github.com/AnonHebei' },
      { label: 'X', url: '{{SHARED_X_URL}}' },
      { label: 'RSS', url: '{{SHARED_RSS_URL}}' },
    ] as LinkItem[],
  },

  /** 项目牌。牌背颜色按顺序在品牌色中轮流分配 */
  projects: [
    {
      title: 'SOYOMAIL',
      monogram: 'S',
      url: 'https://mail.soyonagasaki.com/',
      points: {
        zh: ['10 分钟自动销毁', '自定义地址前缀', '扫码手机接力', '沙箱安全渲染'],
        en: ['10-minute self-destruct', 'Custom address prefix', 'QR handoff to mobile', 'Sandboxed rendering'],
      },
    },
    {
      title: 'PAGECLIP',
      monogram: 'P',
      url: 'https://pageclip.soyonagasaki.com/',
      points: {
        zh: ['本地优先收藏', 'AES-256 加密备份', '稍后读 Inbox', '开源 · 无追踪'],
        en: ['Local-first collection', 'AES-256 encrypted backup', 'Read-later inbox', 'Open source, no tracking'],
      },
    },
  ] as Project[],
};

/** 值是否已填写（非空且不是 {{占位符}}） */
export function isFilled(value: string | undefined | null): value is string {
  if (!value) return false;
  const v = value.trim();
  return v.length > 0 && !/^\{\{.*\}\}$/.test(v);
}
