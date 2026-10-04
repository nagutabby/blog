import type { Article, Review } from '$lib/types/blog';
import { generateDescriptionFromText } from '$lib/utils';

const site = 'https://blog.app.nagutabby.uk';

function sitemapEntry(path: string, lastmod: Date, type: 'articles' | 'reviews') {
  return `<url>\n    <loc>${new URL(`${type}/${path}`, `${site}/`).href}</loc>\n    <lastmod>${lastmod.toISOString()}</lastmod>\n  </url>`;
}

export function createSitemap(articles: Article[], reviews: Review[]) {
  const entries = [
    ...articles.map((post) => sitemapEntry(post.id, post.publishedAt, 'articles')),
    ...reviews.map((post) => sitemapEntry(post.id, post.publishedAt, 'reviews'))
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>`;
}

export function createAtomFeed(articles: Article[], reviews: Review[], now = new Date()) {
  let latestDate: Date | undefined;
  const createEntry = (post: Article | Review, type: 'articles' | 'reviews') => {
    const publishedAt = new Date(post.publishedAt);
    if (!latestDate || latestDate < publishedAt) latestDate = publishedAt;
    const publishedDate = publishedAt.toISOString().slice(0, 10);
    const category = type === 'articles'
      ? `<category term="article" label="記事" scheme="${site}" />`
      : `<category term="review" label="本のレビュー" scheme="${site}/reviews" />`;
    return `<entry>\n  <title>${post.title}</title>\n  <summary type="text"><![CDATA[${generateDescriptionFromText(post.body)}]]></summary>\n  <link href="${new URL(`/${type}/${post.id}`, site).href}" rel="alternate" />\n  <updated>${publishedAt.toISOString()}</updated>\n  <published>${publishedAt.toISOString()}</published>\n  <id>tag:blog.app.nagutabby.uk,${publishedDate}:/${type}/${post.id}</id>\n  ${category}\n  </entry>`;
  };
  const entries = [
    ...articles.map((post) => createEntry(post, 'articles')),
    ...reviews.map((post) => createEntry(post, 'reviews'))
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n<link rel="self" href="${site}/atom.xml" type="application/rss+xml" />\n<title>nagutabbyの考え事</title>\n<link href="${site}" />\n<updated>${(latestDate ?? now).toISOString()}</updated>\n<author><name>nagutabby</name></author>\n<id>tag:blog.app.nagutabby.uk,2023-01-01:/</id>\n${entries.join('\n')}\n</feed>`;
}
