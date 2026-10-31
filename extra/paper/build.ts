import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import MarkdownIt, { type Token } from 'markdown-it';

// Builds README.md into a static site that looks like a paper, in extra/paper/dist.
// Upload: deploy.sh, nginx config: nginx.conf.
//   npm run paper

const ROOT = path.join(import.meta.dirname, '..', '..');
const OUT = path.join(import.meta.dirname, 'dist');
const SITE = 'https://paper.epsti.site/';
const REPO = 'https://github.com/Irenid/OSreboot';
const STAND = 'https://osreboot.epsti.site/';
const AUTHOR = 'Рыжов Иван';
const GROUP = 'группа ВПИ 26';

const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

const md = new MarkdownIt({ html: true, linkify: true });
md.linkify.set({ fuzzyLink: false }); // only full URLs, so "run-series.sh" stays text

const citation = (n: string) => `<a href="#ref-${n}">${n}</a>`;

// "[4, 5]" links to the sources. "¹²" becomes <sup>12</sup>: the font has only ¹²³.
md.renderer.rules['text'] = (tokens, i) =>
  md.utils
    .escapeHtml(tokens[i]!.content)
    .replace(/\[(\d+(?:, \d+)*)\]/g, (_, list: string) => `[${list.split(', ').map(citation).join(', ')}]`)
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (digits) => `<sup>${[...digits].map((d) => SUPERSCRIPTS.indexOf(d)).join('')}</sup>`);

// Long paths may wrap after / - _ instead of stretching a justified line.
md.renderer.rules['code_inline'] = (tokens, i) =>
  `<code>${md.utils.escapeHtml(tokens[i]!.content).replace(/[/_-]/g, '$&<wbr>')}</code>`;

const plainText =(inline: Token) => (inline.children ?? []).map((t) => t.content).join('');

// The same anchors as GitHub makes, so links like (#1-введение) keep working.
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');

function addAnchors(tokens: Token[]): void {
  for (const [i, token] of tokens.entries()) {
    if (token.type === 'heading_open') token.attrSet('id', slug(plainText(tokens[i + 1]!)));
  }
}

// Items of the list under "Источники" get ids ref-1, ref-2…, the targets of citations.
function markSources(tokens: Token[]): void {
  const heading = tokens.findIndex((t) => t.type === 'inline' && t.content === 'Источники');
  const list = tokens.findIndex((t, i) => i > heading && t.type === 'ordered_list_open');
  if (heading < 0 || list < 0) throw new Error('README.md: no list under "Источники"');
  tokens[list]!.attrSet('class', 'sources');
  for (const token of tokens.slice(heading)) {
    if (token.type === 'ordered_list_close' && token.level === tokens[list]!.level) break;
    if (token.type === 'list_item_open') token.attrSet('id', `ref-${token.info}`); // info = the number as written
    // README.md shrinks the sources with <sub> for GitHub; here style.css does it.
    for (const child of token.children ?? []) {
      if (child.type === 'html_inline' && /^<\/?sub>$/.test(child.content)) child.content = '';
    }
  }
}

// Captions, notes and scrolling for the HTML that markdown-it makes.
const finish = (html: string) =>
  html
    .replace(/ style="text-align:(left|center|right)"/g, ' class="$1"') // CSP allows no inline styles
    .replace(/<table>[^]*?<\/table>/g, '<div class="table">\n$&\n</div>')
    .replace(/<\/table>\n<\/div>\s*<ol>/g, '</table>\n</div>\n<ol class="notes">')
    .replace(/<p>(<strong>Таблица [^]*?)<\/p>\s*(<div class="table">[^]*?<\/div>)/g, '<figure>\n<figcaption>$1</figcaption>\n$2\n</figure>')
    .replace(/(<picture>[^]*?<\/picture>)\s*<p>(<strong>Рисунок [^]*?)<\/p>/g, '<figure>\n$1\n<figcaption>$2</figcaption>\n</figure>');

const source = await readFile(path.join(ROOT, 'README_PAPER.md'), 'utf8');
const tokens = md.parse(source, {});
addAnchors(tokens);
markSources(tokens);

// README.md starts with the title, the abstract as a quote and the contents list.
const quoteEnd = tokens.findIndex((t) => t.type === 'blockquote_close');
const bodyStart = tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h2');
if (tokens[0]?.tag !== 'h1' || tokens[3]?.type !== 'blockquote_open' || quoteEnd < 0 || bodyStart < 0) {
  throw new Error('README.md: expected a title, an abstract quote and sections');
}
const title = md.utils.escapeHtml(plainText(tokens[1]!));

// Drops the "**Аннотация.**" label: the page prints its own heading.
const abstractTokens = tokens.slice(4, quoteEnd);
const lead = abstractTokens[1]!.children!;
const label = lead.findIndex((t) => t.content === 'Аннотация.');
if (label < 0) throw new Error('README.md: the abstract must start with **Аннотация.**');
lead.splice(0, label + 2); // the label with its <strong> tags
lead[0]!.content = lead[0]!.content.trimStart();
const abstract = md.renderer.render(abstractTokens, md.options, {});

// Skips the "**Содержание**" paragraph before the list.
const contents = md.renderer.render(tokens.slice(quoteEnd + 4, bodyStart), md.options, {});
const body = finish(md.renderer.render(tokens.slice(bodyStart), md.options, {}));

const abstractText = abstract.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const description = md.utils.escapeHtml(abstractText.slice(0, abstractText.indexOf('.', 200) + 1));

const updated = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    .format((await stat(path.join(ROOT, 'README_PAPER.md'))).mtime);

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="author" content="${AUTHOR}">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${SITE}">
<link rel="canonical" href="${SITE}">
<link rel="preload" href="fonts/serif-roman.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="style.css">
</head>
<body>
<article>
<header>
<h1>${title}</h1>
<p class="author">${AUTHOR} · ${GROUP}</p>
<p class="meta"><a href="${REPO}">github.com/Irenid/OSreboot</a> · <a href="${STAND}">osreboot.epsti.site</a></p>
<p class="meta">${updated}</p>
</header>
<section class="abstract">
<h2>Аннотация</h2>
${abstract}</section>
<nav class="contents">
<h2>Содержание</h2>
${contents}</nav>
${body}</article>
</body>
</html>
`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'index.html'), page);
await cp(path.join(import.meta.dirname, 'style.css'), path.join(OUT, 'style.css'));
await cp(path.join(import.meta.dirname, 'fonts'), path.join(OUT, 'fonts'), { recursive: true });
await cp(path.join(ROOT, 'extra', 'figures'), path.join(OUT, 'extra', 'figures'), { recursive: true });
console.log(`${OUT}: ${Math.round(page.length / 1024)} KiB of HTML, updated ${updated}`);
