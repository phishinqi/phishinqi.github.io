# 鱼七 & astraRuri — Tracing Light

A two-person homepage inspired by [lusion.co](https://lusion.co/) / [akari.lusion.co](https://akari.lusion.co/).
Vite + Three.js + TypeScript, static output, deployable to Cloudflare Pages.

## 开发

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 类型检查 + 构建到 dist/
npm run preview
```

## 配置

**所有内容都在 `src/config/site.config.ts`：**

- `people[].names`：名字列表，多个时会以乱码 / 频闪方式轮播；`nameRotateInterval` 控制间隔
- `people[].email / links`、`contact.email / links`：社交链接与邮箱。
  值为 `'{{...}}'` 占位符或空字符串时**自动隐藏**，填写真实地址后才显示
- `tagline`：3D 场景上的标语（`\n` 换行）
- `projects`：项目牌，追加一条即多一张牌（`monogram` 为单个 A–Z 字母）

配色在 `src/core/theme.ts`（`palettes`、`cardColors`），界面文案在 `src/core/i18n.ts`。
背景灯管的长度、颜色归属、方向、速度与是否频闪在 `src/gl/Stage.ts` 的 `BG_TUBES`。

字体：英文 Outfit，中文 Noto Sans SC。

光源与文字的安全距离：`site.config.ts` → `hero.lightSafeDistance`（CSS 像素）。

## 部署到 Cloudflare Pages

| 项目 | 值 |
| --- | --- |
| Framework preset | None / Vite |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | 20+（环境变量 `NODE_VERSION=20`） |

`public/_headers` 为带哈希的静态资源设置了长期缓存。

## 结构

```
src/
  config/site.config.ts   站点内容配置
  core/                   数学/lerp、主题、i18n、频闪、名字轮播、设备分级
  gl/LightField.ts        首屏 2D 光线追踪：JFA 距离场 + 线形灯管（面光源）软阴影 + 光轨迹
  gl/Scene3D.ts           3D 体积光场景：纸灯笼（浅色）/ 玻璃几何体（深色）
  gl/Stage.ts             统一画布、光源运动、首屏 ↔ 3D 交叉淡化与最终合成
  ui/deck.ts              项目牌：滚动翻牌、悬停倾斜、随光源方向投影
  ui/cardBack.ts          程序化 Art Deco 牌背
  ui/content.ts           名牌、联系方式渲染
```

- 移动端 / 低性能设备自动降级（光追分辨率、阴影、粒子数、玻璃材质）
- `prefers-reduced-motion` 时关闭频闪、乱码与拖尾
- WebGL 不可用时显示静态渐变版本
