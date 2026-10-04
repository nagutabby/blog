import { describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { createAtomFeed, createSitemap } from './feeds';
import type { Article, Review } from '$lib/types/blog';

const articles: Article[] = [
  { id: 'first-post', title: 'First post', body: 'Article body', image: '', publishedAt: new Date('2025-04-01') },
  { id: 'second-post', title: 'Second post', body: 'Another body', image: '', publishedAt: new Date('2025-04-02') }
];
const reviews: Review[] = [
  { id: 'book-review', title: 'Book review', body: 'Review body', image: '', description: '', jp_e_code: '', rating: 5, publishedAt: new Date('2025-03-01') }
];

describe('静的フィード', () => {
  it('記事とレビューを正規URLと公開日付きでサイトマップに含める', () => {
    const xml = createSitemap(articles, reviews);
    const result = new XMLParser().parse(xml);
    expect(result.urlset.url).toHaveLength(3);
    expect(result.urlset.url[0].loc).toBe('https://blog.app.nagutabby.uk/articles/first-post');
    expect(result.urlset.url[2].loc).toBe('https://blog.app.nagutabby.uk/reviews/book-review');
    expect(result.urlset.url[0].lastmod).toBe('2025-04-01T00:00:00.000Z');
  });

  it('Atomに記事・レビューと最新の更新日時を出力する', () => {
    const result = new XMLParser({ ignoreAttributes: false }).parse(createAtomFeed(articles, reviews));
    expect(result.feed.entry).toHaveLength(3);
    expect(result.feed.entry[0].title).toBe('First post');
    expect(result.feed.entry[0].link['@_href']).toBe('https://blog.app.nagutabby.uk/articles/first-post');
    expect(result.feed.entry[2].category['@_term']).toBe('review');
    expect(result.feed.updated).toBe('2025-04-02T00:00:00.000Z');
  });

  it('投稿がない場合に指定された日時で空のAtomを生成する', () => {
    const result = new XMLParser().parse(createAtomFeed([], [], new Date('2025-01-01')));
    expect(result.feed.entry).toBeUndefined();
    expect(result.feed.updated).toBe('2025-01-01T00:00:00.000Z');
  });
});
