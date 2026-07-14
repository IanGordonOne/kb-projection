import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractOutlinks, selectSubgraph } from '../../src/lib/subgraph';

describe('extractOutlinks', () => {
  test('related:: weight 2, body [[..]] weight 1, deduped to max, self dropped', () => {
    const content = ['title:: Me', 'related:: [[A]] [[B]]', '', '- body links [[B]] and [[C]] and [[Me]]'].join('\n');
    const links = extractOutlinks(content, 'Me').sort((x, y) => x.title.localeCompare(y.title));
    expect(links).toEqual([
      { title: 'A', weight: 2 },
      { title: 'B', weight: 2 }, // in related (2) AND body (1) → max 2
      { title: 'C', weight: 1 },
    ]);
  });
});

describe('selectSubgraph', () => {
  function graph(): string {
    const g = mkdtempSync(join(tmpdir(), 'kbsub-'));
    mkdirSync(join(g, 'pages'), { recursive: true });
    const page = (t: string, body: string) => writeFileSync(join(g, 'pages', `${t}.md`), body);
    page('Seed', 'title:: Seed\nrelated:: [[Near]]\n\n- links [[Near]] and [[Hub]] and [[Ghost]]');
    page('Near', 'title:: Near\n\n- back to [[Seed]], out to [[Far]]');
    page('Far', 'title:: Far\n\n- terminal');
    // Hub: 50 outlinks → should be hub-demoted below minScore.
    page('Hub', 'title:: Hub\n\n' + Array.from({ length: 50 }, (_, i) => `- [[H${i}]]`).join('\n'));
    // Ghost has NO page file → concept-stub → boundary, exists:false.
    return g;
  }

  test('expands by co-citation, includes near neighbors, hub-demotes the index page', () => {
    const g = graph();
    try {
      const sel = selectSubgraph({ graphDir: g, seeds: ['Seed'], maxPages: 25, maxHops: 2, hubOutdegree: 40, minScore: 1 });
      const titles = sel.pages.map((p) => p.title);
      expect(titles).toContain('Seed'); // seed, hop 0
      expect(titles).toContain('Near'); // strongly co-cited (related+body), hop 1
      expect(titles).toContain('Far'); // hop 2 via Near
      expect(titles).not.toContain('Hub'); // out-degree 50 > 40 → demoted below minScore
      const seed = sel.pages.find((p) => p.title === 'Seed')!;
      expect(seed.hop).toBe(0);
      expect(sel.pages.find((p) => p.title === 'Near')!.hop).toBe(1);
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });

  test('boundary reports out-of-slice links: Ghost (no page) + Hub (demoted, referenced)', () => {
    const g = graph();
    try {
      const sel = selectSubgraph({ graphDir: g, seeds: ['Seed'], maxHops: 2, hubOutdegree: 40 });
      const boundaryTitles = sel.boundary.map((b) => b.title);
      expect(boundaryTitles).toContain('Ghost');
      expect(sel.boundary.find((b) => b.title === 'Ghost')!.exists).toBe(false); // concept-stub
      expect(boundaryTitles).toContain('Hub');
      expect(sel.boundary.find((b) => b.title === 'Hub')!.exists).toBe(true); // real page, just excluded
      expect(sel.boundary.find((b) => b.title === 'Ghost')!.referencedBy).toContain('Seed');
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });

  test('maxPages caps the slice', () => {
    const g = graph();
    try {
      const sel = selectSubgraph({ graphDir: g, seeds: ['Seed'], maxPages: 2, maxHops: 2 });
      expect(sel.pages.length).toBe(2); // Seed + the single best neighbor
      expect(sel.pages.map((p) => p.title)).toContain('Seed');
    } finally {
      rmSync(g, { recursive: true, force: true });
    }
  });
});
