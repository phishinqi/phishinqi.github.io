import { siteConfig, isFilled, type LinkItem } from '../config/site.config';
import { tl } from '../core/i18n';
import type { NameRotator } from '../core/nameRotator';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** 渲染链接列表；未填写（占位符）的条目自动隐藏 */
export function linksHtml(links: LinkItem[], email?: string): string {
  const items = links
    .filter((l) => isFilled(l.url))
    .map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`);
  if (isFilled(email)) items.unshift(`<li><a href="mailto:${esc(email)}">Email</a></li>`);
  return items.join('');
}

export function renderStatic() {
  const people = siteConfig.people;
  $('#nav-logo').textContent = tl(siteConfig.title);
  $('#hero-title').textContent = `${people[0].names.join(' / ')} & ${people[1].names.join(' / ')}`;

  // 标语：逐行包裹，供滚动时逐行显现
  const tagline = $('#tagline');
  tagline.innerHTML = tl(siteConfig.tagline)
    .split('\n')
    .map((line) => `<span class="line"><span>${esc(line)}</span></span>`)
    .join('');

  // 页脚联系方式
  const { email, links } = siteConfig.contact;
  const mail = $<HTMLAnchorElement>('#contact-email');
  $('#contact-email-col').hidden = !isFilled(email);
  if (isFilled(email)) {
    mail.href = `mailto:${email}`;
    mail.textContent = email;
  }
  const linkList = $('#contact-links');
  linkList.innerHTML = linksHtml(links);
  $('#contact-links-col').hidden = linkList.innerHTML === '';

  const names = people.map((p) => p.names[p.names.length - 1]).join(' & ');
  $('#footer-copy').textContent = `© ${new Date().getFullYear()} ${names}`;
}

/** 只调用一次；语言相关文字通过 data-i18n 由 applyLang 更新 */
export function renderPlates(rotators: NameRotator[]) {
  const root = $('#plates');
  root.innerHTML = siteConfig.people
    .map((p, i) => {
      const aliases =
        p.names.length > 1
          ? `<ul class="plate-aliases" data-i18n-aria="us.aliases">${p.names
              .map((n, k) => `<li data-k="${k}">${esc(n)}</li>`)
              .join('')}</ul>`
          : '';
      return `
      <article class="plate glass" data-person="${i}">
        <div class="plate-top">
          <span class="plate-orb"></span>
          <span data-i18n="${i === 0 ? 'us.lightA' : 'us.lightB'}"></span>
          <span class="plate-idx">${i === 0 ? 'A' : 'B'}</span>
        </div>
        <h3 class="display plate-name">${esc(p.names[0])}</h3>
        ${aliases}
        <ul class="link-list">${linksHtml(p.links, p.email)}</ul>
      </article>`;
    })
    .join('');

  root.querySelectorAll<HTMLElement>('.plate').forEach((plate, i) => {
    const nameEl = plate.querySelector<HTMLElement>('.plate-name')!;
    const items = plate.querySelectorAll<HTMLElement>('.plate-aliases li');
    const rot = rotators[i];
    rot.subscribe((s) => {
      nameEl.textContent = s;
      items.forEach((li) => li.classList.toggle('is-active', Number(li.dataset.k) === rot.index));
    });
  });
}
