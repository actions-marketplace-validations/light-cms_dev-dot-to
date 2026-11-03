// Publishes articles to dev.to from GitHub Actions.
//
// Two modes:
// - feed mode  (`rss_url`): takes the newest items from an RSS/Atom feed and
//   posts them to dev.to. Each item is assigned the feed link as its
//   `canonical_url`, so later runs can skip whatever was already published.
// - single mode (`title` + `body_markdown`): posts one article verbatim.
//
// Zero dependencies: runs on the runner's bundled Node with global `fetch`.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEVTO_API = 'https://dev.to/api/articles';
const ITEMS_PER_PAGE = 50;
const MAX_PUBLISHED_PAGES = 5;

// --- actions-core-style plumbing (we are the runtime, no @actions/core) ------

export const getInput = (name, required = false) => {
  const key = `INPUT_${name.toUpperCase().replace(/ /g, '_')}`;
  const value = (process.env[key] ?? '').trim();
  if (required && !value) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return value || undefined;
};

export const setOutput = (name, value) => {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    appendFileSync(file, `${name}=${value}\n`);
  } else if (value) {
    console.log(`=> ${name}: ${value}`);
  }
  return value;
};

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exitCode = 1;
};

// --- tiny RSS/Atom parsing ---------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

// Single-pass unescape: XML feeds escape both their own markup and the HTML
// they carry, so one pass turns `&lt;p&gt;` back into `<p>` without rescanning.
const decodeEntities = (text) =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, code) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    }
    if (code.startsWith('#')) {
      return String.fromCodePoint(parseInt(code.slice(1), 10));
    }
    return ENTITIES[code] ?? match;
  });

const unwrapCdata = (value) =>
  value.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();

const clean = (value) => decodeEntities(unwrapCdata(value));

const readTag = (block, tag) => {
  const match = block.match(new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\s?${tag}\\s*>`,
    'i',
  ));
  return match ? clean(match[1]) : undefined;
};

// Atom puts the target in `href` (usually rel="alternate"), RSS 2.0 in text.
export const readLink = (block) => {
  const alternate = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)
    ?? block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i);
  return alternate
    ? alternate[1]
    : readTag(block, 'link')
      ?? block.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i)?.[1];
};

export const itemsFromFeed = (xml) => {
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/g) ?? [];
  return blocks.map((block) => ({
    title: readTag(block, 'title'),
    link: readLink(block),
    body:
      readTag(block, 'content:encoded') ??
      readTag(block, 'content') ??
      readTag(block, 'description') ??
      readTag(block, 'summary'),
  }));
};

// --- dev.to API ---------------------------------------------------------------

const apiHeaders = (token) => ({
  'api-key': token,
  Accept: 'application/vnd.forem.api-v1+json',
});

export const normalizeUrl = (url) =>
  url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

const publishArticle = async (token, article) => {
  const response = await fetch(DEVTO_API, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ article }),
  });

  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).error ?? text;
    } catch {
      // keep the raw body as the error detail
    }
    throw new Error(`dev.to API responded ${response.status}: ${detail}`);
  }
  return JSON.parse(text);
};

// Feed items published by this action carry the feed link as `canonical_url`,
// so later runs can avoid reposting them.
const previouslyPublishedUrls = async (token) => {
  const urls = new Set();
  for (let page = 1; page <= MAX_PUBLISHED_PAGES; page++) {
    const response = await fetch(
      `https://dev.to/api/articles/me/all?per_page=${ITEMS_PER_PAGE}&page=${page}`,
      { headers: apiHeaders(token) },
    );
    if (!response.ok) {
      throw new Error(`Failed to list published articles (${response.status})`);
    }
    const batch = await response.json();
    for (const article of batch) {
      if (article.canonical_url) {
        urls.add(normalizeUrl(article.canonical_url));
      }
    }
    if (batch.length < ITEMS_PER_PAGE) break;
  }
  return urls;
};

// --- assembling articles --------------------------------------------------------

export const toArticle = ({ title, link, body }, published, fallbackTitle = 'Untitled') => {
  let markdown = body ?? '';
  let mainImage;

  const img = markdown.match(/<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/i);
  if (img) {
    mainImage = img[1];
    markdown = markdown.replace(img[0], ' ').trim();
  }

  if (markdown && link) {
    markdown = `${markdown}\n\n> [Originally published at](${link})`;
  } else if (link) {
    markdown = `[Originally published at](${link})`;
  }

  const article = {
    title: (title ?? fallbackTitle).slice(0, 128),
    body_markdown: markdown,
    published,
  };
  if (link) article.canonical_url = link;
  if (mainImage) article.main_image = mainImage;
  return article;
};

// --- main ------------------------------------------------------------------------

export const main = async () => {
  const token = getInput('devto_token', true);
  const rssUrl = getInput('rss_url');
  const title = getInput('title');
  const bodyMarkdown = getInput('body_markdown');
  const published = (getInput('published') ?? 'true') === 'true';

  let items;
  if (rssUrl) {
    const response = await fetch(rssUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch feed ${rssUrl} (${response.status})`);
    }
    items = itemsFromFeed(await response.text());

    if ((getInput('skip_existing') ?? 'true') === 'true') {
      const alreadyPublished = await previouslyPublishedUrls(token);
      const eligible = items.filter(
        (item) => !item.link || !alreadyPublished.has(normalizeUrl(item.link)),
      );
      if (eligible.length < items.length) {
        console.log(`Skipping ${items.length - eligible.length} already published item(s).`);
      }
      items = eligible;
    }

    const maxPosts = Math.max(1, parseInt(getInput('max_posts') ?? '1', 10) || 1);
    items = items.slice(0, maxPosts);

    if (items.length === 0) {
      console.log('Nothing new in the feed — nothing to publish.');
    }
  } else if (title && bodyMarkdown) {
    items = [{ title, body: bodyMarkdown, link: undefined }];
  } else {
    throw new Error('Either provide `rss_url`, or both `title` and `body_markdown`.');
  }

  const createdIds = [];
  const createdUrls = [];
  for (const item of items) {
    const created = await publishArticle(token, toArticle(item, published));
    console.log(`Published to dev.to: ${created.url}`);
    createdIds.push(String(created.id));
    createdUrls.push(created.url);
  }

  setOutput('id', createdIds[0] ?? '');
  setOutput('url', createdUrls[0] ?? '');
  setOutput('ids', createdIds.join(','));
  setOutput('urls', createdUrls.join(','));

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const lines = ['## dev.to publish'];
    lines.push(...(createdUrls.length > 0
      ? createdUrls.map((url) => `- [${url}](${url})`)
      : ['_Nothing new to publish._']));
    appendFileSync(summaryFile, `${lines.join('\n')}\n`);
  }
};

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryHref) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
