# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A two-person homepage (鱼七 & astraRuri), in the style of lusion.co and akari.lusion.co. Built with Vite + Three.js + TypeScript and Lenis for smooth scroll. The output is a static site deployed to Cloudflare Pages (build command `npm run build`, output `dist`, Node 20+). Code comments and the README are in Chinese.

## Commands

```bash
npm run dev       # Vite dev server, http://localhost:5173
npm run build     # tsc --noEmit (type check) + vite build → dist/
npm run preview
```

There is no test suite and no linter. `npm run build` is the only check. tsconfig has `strict`, `noUnusedLocals`, and `noUnusedParameters`, so an unused import or parameter fails the build.

## Architecture

Entry: `index.html` (static DOM skeleton, plus an inline script that sets the theme and language before first paint) → `src/main.ts`, which wires everything together and owns the **single rAF loop**. That loop drives Lenis, the name rotators, the loader counter, `deck.update`, and `stage.render`. It also mirrors the WebGL light intensities into the CSS vars `--ia`/`--ib`, so DOM light dots flicker in sync with the canvas.

**Rendering (`src/gl/`)**: there is one fixed full-screen canvas under the content.
- `Stage.ts` owns the `WebGLRenderer`, animates the two round lights (A = pointer-driven, B = wandering) and the 12 Akari-style neon bars (`makeBars`: length, color owner, direction, speed, on/off phase on a 16 s `bounceIn(sin)` envelope, same-hue HSL offset). It cross-fades the hero into the 3D scene using `heroMix`/`sceneProgress` (computed from scroll in `main.ts`). It runs the final composite shader: ink silhouettes, bar and light bodies, trails, vignette, dither/grain, and tone mapping. `topInset` keeps bars below the nav.
- `LightField.ts`: the hero's 2D lighting, modelled on akari.lusion.co. Global illumination: the names (black occluders) and the lit bars (emitters) are drawn into a half-res scene, JFA'd every frame, and ray-marched in 16 directions per pixel, then padded/blurred 3×. The two round lights are computed analytically with soft shadows off a separate name distance field (JFA'd only when the names change). The names are drawn to a canvas mask in Playfair Display (Latin) / Noto Serif SC (CJK). It exports shared GLSL (`FULLSCREEN_VERT`, `SEGMENT_GLSL`, `MAX_TUBES`) that Stage reuses.
- `Scene3D.ts`: a volumetric-light 3D scene with its own composer. Light theme shows paper lanterns and dark theme shows glass geometry. `Stage` uses its output as a texture.
- If `new Stage()` throws (no WebGL), `main.ts` adds `.no-webgl` to `<html>` and the page falls back to a static CSS gradient. The rest of the page (deck, content) must keep working with `stage === null`.

**Core (`src/core/`)**: small shared modules with module-level state and listener sets. `theme.ts` follows the system theme with a manual override; it holds `palettes` and `cardColors`. `i18n.ts` handles zh/en: the `dict` holds UI copy, `t(key)` looks it up, and `tl(localized)` reads config values. `env.ts` provides the device `tier` ('high'/'low') and `motion.reduced`. Also here: `flicker.ts` (round-light flicker), `nameRotator.ts` (glitch name rotation), and `math.ts` (`damp`, `smoothstep`, `range`, `bounceIn`, …). Low tier lowers GI resolution/ray count, shadows, particles, and glass quality. Reduced motion freezes the bars and turns off flicker, glitch, and trails. New effects should respect both.

**UI (`src/ui/`)**: `deck.ts` renders projects as playing cards. They flip on scroll, tilt on hover, and cast shadows based on the light positions passed from the main loop. `cardBack.ts` draws a procedural Art Deco card back, `pixelFont.ts` renders the monogram, and `content.ts` renders the name plates and contact info.

## Content & configuration conventions

- **All site content lives in `src/config/site.config.ts`**: people's names (several names rotate with a glitch effect), links/emails, tagline, projects (`monogram` is a single A–Z letter), and `hero.lightSafeDistance`. Keep content there and never hardcode it in components.
- A link or email whose value is empty or a `'{{...}}'` placeholder is automatically hidden. Social links and emails must only come from config placeholders.
- By design there is no bio, job title, or tech stack anywhere. Project cards have no screenshots, logos, or author.
- Fonts: Outfit (Latin) and Noto Sans SC (Chinese) for the UI; the hero names on the canvas use Playfair Display and Noto Serif SC. All load from Google Fonts. Canvas text is drawn only after `document.fonts.load` resolves, with a 4s timeout. If you change fonts, update both `index.html` and the font loading in `main.ts`.
- The nav, loader, and hero overlay follow akari.lusion.co's chrome: a thin-ruled bar with outlined pill buttons (`.pill`), a full-width 1px progress line, and fade-in after load (`html.is-loaded`).
- `public/_headers` sets long-lived caching for hashed assets.

## Legacy files

Several root-level files are not part of the Vite build and are not referenced by `src/`: `assets/`, `Colab_Inference.ipynb`, `google*.html`, `CNAME`, `favicon.ico`, and `apple-touch-icon.png`. Only `public/` is copied to `dist`. Comments that mention `img/01.png` and `img/02.png` refer to design reference images that are not in the repo.
