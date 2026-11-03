## rss/atom feed to dev.to cross-posting

Publish and sync articles to [dev.to](https://dev.to) from an RSS/Atom feed or directly via workflow inputs.

### Automatic Feed Sync (Create and Update)

```yaml
name: Sync blog to dev.to
on:
  workflow_dispatch:
  schedule:
    - cron: '0 9 * * *' # Check daily

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Publish or update feed items
        uses: light-cms/dev-dot-to@1.0.0
        with:
          rss_url: https://blogs.lightcms.me/atom.xml
          devto_token: ${{ secrets.DEVTO_TOKEN }}
          published: 'true'
          max_posts: '10'
          update_existing: 'true' # Updates already published posts if they exist
```

### Update an Existing Post by ID (Single Mode)

```yaml
- name: Update specific dev.to article
  uses: light-cms/dev-dot-to@1.0.0
  with:
    devto_token: ${{ secrets.DEVTO_TOKEN }}
    article_id: '123456'
    title: 'Updated Post Title'
    body_markdown: 'Updated markdown content...'
    published: 'true'
```

