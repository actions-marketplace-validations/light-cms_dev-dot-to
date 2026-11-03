// Publishes or updates articles to dev.to from GitHub Actions.
//
// Modes:
// - feed mode (`rss_url`): takes the newest items from an RSS/Atom feed and
//   posts them to dev.to. Each item is assigned the feed link as its `canonical_url`.
//   If `update_existing` is true, existing articles matching canonical_url or title
//   are updated; otherwise if `skip_existing` is true, existing ones are skipped.
// - single mode:
//   - with `article_id`: updates an existing post by ID.
//   - with `title` + `body_markdown`: publishes a new post (or updates if `update_existing` is true
//     and a post with matching canonical_url or title already exists).
//
// Zero dependencies: runs on the runner's bundled Node with global `fetch`.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEVTO_API = 'https://dev.to/api/articles';
const ITEMS_PER_PAGE = 1000;
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

export const normalizeTitle = (title) =>
  title.trim().toLowerCase().replace(/\s+/g, ' ');

export const publishArticle = async (token, article) => {
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

export const updateArticle = async (token, id, article) => {
  const response = await fetch(`${DEVTO_API}/${id}`, {
    method: 'PUT',
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

// Fetches all published and draft articles owned by the user, indexed by
// canonical_url and normalized title.
export const getExistingArticles = async (token) => {
  const byUrl = new Map();
  const byTitle = new Map();

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
        byUrl.set(normalizeUrl(article.canonical_url), article);
      }
      if (article.title) {
        byTitle.set(normalizeTitle(article.title), article);
      }
    }
    if (batch.length < ITEMS_PER_PAGE) break;
  }
  return { byUrl, byTitle };
};

// Backwards-compatible helper returning a Set of normalized canonical URLs.
export const previouslyPublishedUrls = async (token) => {
  const { byUrl } = await getExistingArticles(token);
  return new Set(byUrl.keys());
};

// --- assembling articles --------------------------------------------------------

export const toArticle = ({
  title,
  link,
  body,
  description,
  tags,
  series,
  main_image,
}, published, fallbackTitle = 'Untitled') => {
  let markdown = body ?? '';
  let mainImage = main_image;

  if (!mainImage && markdown) {
    const img = markdown.match(/<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/i);
    if (img) {
      mainImage = img[1];
      markdown = markdown.replace(img[0], ' ').trim();
    }
  }

  if (link) {
    const attribution = `[Originally published at](${link})`;
    if (markdown) {
      if (!markdown.includes(attribution)) {
        markdown = `${markdown}\n\n> ${attribution}`;
      }
    } else {
      markdown = attribution;
    }
  }

  const article = {
    title: (title ?? fallbackTitle).slice(0, 128),
    body_markdown: markdown,
    published,
  };
  if (link) article.canonical_url = link;
  if (mainImage) article.main_image = mainImage;
  if (description) article.description = description;
  if (series) article.series = series;
  if (tags) {
    article.tags = Array.isArray(tags)
      ? tags
      : tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return article;
};

// --- main ------------------------------------------------------------------------

export const main = async () => {
  const token = getInput('devto_token', true);
  const rssUrl = getInput('rss_url');
  const title = getInput('title');
  const bodyMarkdown = getInput('body_markdown');
  const articleId = getInput('article_id') ?? getInput('post_id');
  const canonicalUrl = getInput('canonical_url');
  const description = getInput('description');
  const tags = getInput('tags');
  const series = getInput('series');
  const mainImage = getInput('main_image');
  const published = (getInput('published') ?? 'true') === 'true';
  const updateExisting = (getInput('update_existing') ?? 'false') === 'true';
  const skipExisting = (getInput('skip_existing') ?? 'true') === 'true';

  const resultIds = [];
  const resultUrls = [];
  const actionTypes = [];

  if (rssUrl) {
    const response = await fetch(rssUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch feed ${rssUrl} (${response.status})`);
    }
    let items = itemsFromFeed(await response.text());

    if (updateExisting) {
      const maxPosts = Math.max(1, parseInt(getInput('max_posts') ?? '1', 10) || 1);
      items = items.slice(0, maxPosts);

      if (items.length === 0) {
        console.log('Nothing in the feed — nothing to publish or update.');
      } else {
        const { byUrl, byTitle } = await getExistingArticles(token);
        for (const item of items) {
          const articleData = toArticle(item, published);
          const existing = (item.link ? byUrl.get(normalizeUrl(item.link)) : undefined)
            ?? (item.title ? byTitle.get(normalizeTitle(item.title)) : undefined);

          if (existing) {
            console.log(`Found existing article for "${item.title}" (ID: ${existing.id}). Updating...`);
            const updated = await updateArticle(token, existing.id, articleData);
            console.log(`Updated on dev.to: ${updated.url ?? existing.url} (ID: ${existing.id})`);
            resultIds.push(String(existing.id));
            resultUrls.push(updated.url ?? existing.url);
            actionTypes.push('updated');
          } else {
            const created = await publishArticle(token, articleData);
            console.log(`Published to dev.to: ${created.url} (ID: ${created.id})`);
            resultIds.push(String(created.id));
            resultUrls.push(created.url);
            actionTypes.push('created');
          }
        }
      }
    } else {
      if (skipExisting) {
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
      } else {
        for (const item of items) {
          const created = await publishArticle(token, toArticle(item, published));
          console.log(`Published to dev.to: ${created.url}`);
          resultIds.push(String(created.id));
          resultUrls.push(created.url);
          actionTypes.push('created');
        }
      }
    }
  } else if (articleId) {
    const itemData = {
      title,
      link: canonicalUrl,
      body: bodyMarkdown,
      description,
      tags,
      series,
      main_image: mainImage,
    };
    const articleData = toArticle(itemData, published);

    const updated = await updateArticle(token, articleId, articleData);
    console.log(`Updated dev.to article ${articleId}: ${updated.url}`);
    resultIds.push(String(articleId));
    resultUrls.push(updated.url);
    actionTypes.push('updated');
  } else if (title && bodyMarkdown) {
    const itemData = {
      title,
      link: canonicalUrl,
      body: bodyMarkdown,
      description,
      tags,
      series,
      main_image: mainImage,
    };
    const articleData = toArticle(itemData, published);

    if (updateExisting) {
      const { byUrl, byTitle } = await getExistingArticles(token);
      const existing = (canonicalUrl ? byUrl.get(normalizeUrl(canonicalUrl)) : undefined)
        ?? byTitle.get(normalizeTitle(title));

      if (existing) {
        console.log(`Found existing article for "${title}" (ID: ${existing.id}). Updating...`);
        const updated = await updateArticle(token, existing.id, articleData);
        console.log(`Updated on dev.to: ${updated.url ?? existing.url} (ID: ${existing.id})`);
        resultIds.push(String(existing.id));
        resultUrls.push(updated.url ?? existing.url);
        actionTypes.push('updated');
      } else {
        const created = await publishArticle(token, articleData);
        console.log(`Published to dev.to: ${created.url} (ID: ${created.id})`);
        resultIds.push(String(created.id));
        resultUrls.push(created.url);
        actionTypes.push('created');
      }
    } else {
      const created = await publishArticle(token, articleData);
      console.log(`Published to dev.to: ${created.url} (ID: ${created.id})`);
      resultIds.push(String(created.id));
      resultUrls.push(created.url);
      actionTypes.push('created');
    }
  } else {
    throw new Error('Either provide `rss_url`, `article_id`, or both `title` and `body_markdown`.');
  }

  setOutput('id', resultIds[0] ?? '');
  setOutput('url', resultUrls[0] ?? '');
  setOutput('ids', resultIds.join(','));
  setOutput('urls', resultUrls.join(','));

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const lines = ['## dev.to publish'];
    if (resultUrls.length > 0) {
      lines.push(...resultUrls.map((url, i) => {
        const verb = actionTypes[i] === 'updated' ? 'Updated' : 'Published';
        return `- ${verb}: [${url}](${url})`;
      }));
    } else {
      lines.push('_Nothing new to publish or update._');
    }
    appendFileSync(summaryFile, `${lines.join('\n')}\n`);
  }
};

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryHref) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
