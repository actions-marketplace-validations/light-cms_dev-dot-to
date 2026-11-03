// Smoke test: fetch a real feed and show what the action would parse,
// without touching the dev.to API. Usage: node tools/smoke.js [feed-url]
import { itemsFromFeed, toArticle } from '../src/index.js';

const feedUrl = process.argv[2] ?? 'https://blogs.lightcms.me/atom.xml';
const response = await fetch(feedUrl);
if (!response.ok) throw new Error(`feed fetch failed: ${response.status}`);
const items = itemsFromFeed(await response.text());

console.log(`parsed ${items.length} entries from ${feedUrl}\n`);
for (const item of items.slice(0, 3)) {
  console.log(`title: ${item.title}`);
  console.log(`link:  ${item.link}`);
  console.log(`body:  ${(item.body ?? '').slice(0, 140).replace(/\s+/g, ' ')}…`);
  console.log();
}

const article = toArticle(items[0], true);
console.log('article ready to POST:');
console.log(JSON.stringify({
  ...article,
  body_markdown: article.body_markdown.slice(0, 200),
}, null, 2));
