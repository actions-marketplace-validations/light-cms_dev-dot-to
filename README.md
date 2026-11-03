## rss/atom feed to dev.to cross-posting

```yaml
name: Publish new posts to dev.to
on:
  # workflow_run:
    # workflows: ["Upstream Workflow (Workflow A)"]
    # types:
      # - completed    
# workflow run on build success in your blog repo
  workflow_dispatch:
  schedule:
    - cron: '0 9 * * *' ## check daily 

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Publish new feed items
        uses: ./
        with:
          rss_url: https://blogs.lightcms.me/atom.xml
          devto_token: ${{ secrets.DEVTO_TOKEN }}
          published: 'true'
          max_posts: '10'
```

`DEVTO_TOKEN` is a repository secret.

![devto_token](https://kappa.lol/JHLini)

![token](https://kappa.lol/1OcFkq)
