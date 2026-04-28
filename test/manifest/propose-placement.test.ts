import { describe, expect, test } from 'bun:test';
import {
  buildSectionIndex,
  proposePlacement,
  proposalToMarkdown,
} from '../../src/manifest/propose-placement';
import type { PageMetadata } from '../../src/manifest/logseqMeta';
import type { PublishManifest } from '../../src/manifest/schema';

function meta(overrides: Partial<PageMetadata>): PageMetadata {
  return {
    file: 'placeholder.md',
    category: null,
    type: null,
    project: null,
    tags: [],
    wikilinks: [],
    ...overrides,
  };
}

function manifest(titles: string[]): PublishManifest {
  return {
    graphPath: '/g',
    entries: titles.map((t) => ({ title: t, tier: 'seed' as const })),
  };
}

describe('buildSectionIndex', () => {
  test('groups manifest entries by category', () => {
    const m = manifest(['A', 'B', 'C']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'Engineering' })],
      ['B', meta({ category: 'Engineering' })],
      ['C', meta({ category: 'Law' })],
    ]);
    const idx = buildSectionIndex(m, meta_);
    expect(idx.size).toBe(2);
    expect(idx.get('Engineering')!.titles.size).toBe(2);
    expect(idx.get('Law')!.titles.size).toBe(1);
  });

  test('entries without category go into "(uncategorized)"', () => {
    const m = manifest(['A', 'B']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: null })],
      ['B', meta({ category: 'X' })],
    ]);
    const idx = buildSectionIndex(m, meta_);
    expect(idx.has('(uncategorized)')).toBe(true);
    expect(idx.get('(uncategorized)')!.titles.size).toBe(1);
  });

  test('aggregates tag frequency across section pages', () => {
    const m = manifest(['A', 'B']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X', tags: ['alpha', 'beta'] })],
      ['B', meta({ category: 'X', tags: ['alpha', 'gamma'] })],
    ]);
    const idx = buildSectionIndex(m, meta_);
    const tags = idx.get('X')!.tagFrequency;
    expect(tags.get('alpha')).toBe(2);
    expect(tags.get('beta')).toBe(1);
    expect(tags.get('gamma')).toBe(1);
  });
});

describe('proposePlacement — category match', () => {
  test('candidate with matching category gets +20 score', () => {
    const m = manifest(['A']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'Engineering' })],
      ['Cand', meta({ category: 'Engineering' })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    expect(props[0].topSections).toHaveLength(1);
    expect(props[0].topSections[0].section).toBe('Engineering');
    expect(props[0].topSections[0].score).toBe(20);
    expect(props[0].topSections[0].evidence.categoryMatch).toBe(true);
    expect(props[0].topSections[0].rationale[0]).toContain('matches this section');
  });
});

describe('proposePlacement — wikilink scoring', () => {
  test('outbound wikilinks score (+5 each)', () => {
    const m = manifest(['A', 'B']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X' })],
      ['B', meta({ category: 'X' })],
      ['Cand', meta({ wikilinks: ['A', 'B'] })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    expect(props[0].topSections[0].score).toBe(10); // 2 outbound × 5
    expect(props[0].topSections[0].evidence.outboundLinks).toBe(2);
  });

  test('inbound wikilinks score (+3 each)', () => {
    const m = manifest(['A', 'B']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X', wikilinks: ['Cand'] })],
      ['B', meta({ category: 'X', wikilinks: ['Cand'] })],
      ['Cand', meta({ category: null })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    expect(props[0].topSections[0].score).toBe(6); // 2 inbound × 3
    expect(props[0].topSections[0].evidence.inboundLinks).toBe(2);
  });

  test('shared tags score (+1 each)', () => {
    const m = manifest(['A']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X', tags: ['alpha', 'beta', 'gamma'] })],
      ['Cand', meta({ tags: ['alpha', 'beta'] })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    expect(props[0].topSections[0].score).toBe(2); // 2 shared tags × 1
    expect(props[0].topSections[0].evidence.sharedTags).toBe(2);
  });

  test('all factors combine additively', () => {
    const m = manifest(['A', 'B']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X', tags: ['t1'], wikilinks: ['Cand'] })],
      ['B', meta({ category: 'X', tags: ['t2'] })],
      ['Cand', meta({ category: 'X', tags: ['t1', 't2'], wikilinks: ['A'] })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    // category-match: +20
    // outbound 1 (Cand→A): +5
    // inbound 1 (A→Cand): +3
    // shared tags 2 (t1, t2): +2
    expect(props[0].topSections[0].score).toBe(30);
  });
});

describe('proposePlacement — ranking', () => {
  test('top-N caps the result', () => {
    const m = manifest(['A', 'B', 'C', 'D']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X' })],
      ['B', meta({ category: 'Y' })],
      ['C', meta({ category: 'Z' })],
      ['D', meta({ category: 'W' })],
      // candidate links to all four → score 5 in each section
      ['Cand', meta({ wikilinks: ['A', 'B', 'C', 'D'] })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_, { topN: 2 });
    expect(props[0].topSections).toHaveLength(2);
  });

  test('higher score ranks first', () => {
    const m = manifest(['A', 'B', 'C']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'High' })],
      ['B', meta({ category: 'Low' })],
      ['C', meta({ category: 'Low' })],
      // category 'High' wins via category-match (+20)
      ['Cand', meta({ category: 'High', wikilinks: ['B', 'C'] })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    expect(props[0].topSections[0].section).toBe('High');
    expect(props[0].topSections[1].section).toBe('Low');
  });

  test('alphabetical tie-break for stable output', () => {
    const m = manifest(['A', 'B']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'Zebra' })],
      ['B', meta({ category: 'Apple' })],
      // candidate links one entry in each section → score 5 in each
      ['Cand', meta({ wikilinks: ['A', 'B'] })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    expect(props[0].topSections[0].section).toBe('Apple');
    expect(props[0].topSections[1].section).toBe('Zebra');
  });

  test('determinism: same inputs → same proposals', () => {
    const m = manifest(['A', 'B', 'C']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X' })],
      ['B', meta({ category: 'Y' })],
      ['C', meta({ category: 'X' })],
      ['Cand', meta({ category: 'X', wikilinks: ['A', 'B'] })],
    ]);
    const p1 = proposePlacement(['Cand'], m, meta_);
    const p2 = proposePlacement(['Cand'], m, meta_);
    expect(p1).toEqual(p2);
  });
});

describe('proposePlacement — honest empty', () => {
  test('candidate with no signal → empty topSections + emptyReason', () => {
    const m = manifest(['A']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X' })],
      ['Cand', meta({ category: null, wikilinks: [], tags: [] })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    expect(props[0].topSections).toHaveLength(0);
    expect(props[0].emptyReason).toContain('no category');
  });

  test('candidate with category but no neighborhood overlap', () => {
    const m = manifest(['A']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X', tags: [] })],
      ['Cand', meta({ category: 'Unique' })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    expect(props[0].topSections).toHaveLength(0);
    expect(props[0].emptyReason).toContain('"Unique"');
    expect(props[0].emptyReason).toContain('no neighborhood overlap');
  });

  test('candidate metadata missing → empty + emptyReason', () => {
    const m = manifest(['A']);
    const meta_ = new Map<string, PageMetadata>([['A', meta({ category: 'X' })]]);
    const props = proposePlacement(['MissingPage'], m, meta_);
    expect(props[0].topSections).toHaveLength(0);
    expect(props[0].emptyReason).toContain('metadata unavailable');
  });
});

describe('proposalToMarkdown', () => {
  test('renders candidate, top sections, scores, and rationale', () => {
    const m = manifest(['A']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'Engineering' })],
      ['Cand', meta({ category: 'Engineering' })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    const md = proposalToMarkdown(props);
    expect(md).toContain('# Placement Proposals');
    expect(md).toContain('## Cand');
    expect(md).toContain('Candidate category: Engineering');
    expect(md).toContain('### #1 — Engineering (score 20)');
    expect(md).toContain('matches this section');
  });

  test('renders empty proposals with reason', () => {
    const m = manifest(['A']);
    const meta_ = new Map<string, PageMetadata>([
      ['A', meta({ category: 'X' })],
      ['Cand', meta({ category: null })],
    ]);
    const props = proposePlacement(['Cand'], m, meta_);
    const md = proposalToMarkdown(props);
    expect(md).toContain('_No section proposals._');
  });
});
