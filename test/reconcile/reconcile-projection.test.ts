import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyProjection,
  parseGroundedRegions,
  planProjection,
  projectSourcePage,
  reconcilePage,
  slugMapsFromManifest,
  type PriorState,
} from '../../src/reconcile/reconcile-projection';
import { parseRegions, regionBody } from '../../src/reconcile/region-core';

// A projected page as the real transform emits it: markdown `##` heading sections.
const PROJECTED_V1 = [
  '## Definition',
  '',
  'Stat arb exploits temporary mispricings while market-neutral.',
  '',
  '## Key Levels',
  '',
  'Sharpe 0.5–2.0. Positions 200–5,000.',
  '',
].join('\n');

const bodyOf = (c: string, id: string) => regionBody(c, parseRegions(c, 'p').find((r) => r.id === id)!).trim();
const seedPrior = (content: string): PriorState => applyProjection(content, content, {}).newPrior;

describe('projectSourcePage — real transform on a LogSeq body', () => {
  test('de-bullets `- ## Heading` and strips the page-property block', () => {
    const raw = [
      'title:: Stat Arb',
      'type:: concept',
      '',
      '- ## Definition',
      '  - Real definition body.',
      '- ## Key Levels',
      '  - Sharpe 0.5–2.0.',
    ].join('\n');
    const projected = projectSourcePage(raw);
    expect(projected).toContain('## Definition');
    expect(projected).not.toContain('title:: Stat Arb'); // frontmatter stripped
    expect(projected).not.toMatch(/^- ## /m); // de-bulleted
    const ids = parseRegions(projected, 'p').map((r) => r.id);
    expect(ids).toEqual(['definition', 'key-levels']);
  });
});

describe('slugMapsFromManifest — resolve wikilinks from the publish manifest (6ji.3 item 1)', () => {
  test('published entries build the slug set/map; excluded entries are omitted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-manifest-'));
    const mf = join(dir, 'm.json');
    writeFileSync(mf, JSON.stringify({ entries: [{ title: 'Mean Reversion' }, { title: 'Secret Page', exclude: true }] }), 'utf8');
    const { publishedSlugs, titleToSlug } = slugMapsFromManifest(mf);
    expect(publishedSlugs.has('mean-reversion')).toBe(true);
    expect(titleToSlug.get('Mean Reversion')).toBe('mean-reversion');
    expect([...publishedSlugs]).not.toContain('secret-page'); // excluded
    rmSync(dir, { recursive: true, force: true });
  });

  test('projectSourcePage with resolved maps turns a published [[wikilink]] into a /kb/ link', () => {
    const raw = '- ## See Also\n  - Related: [[Mean Reversion]]';
    const { publishedSlugs, titleToSlug } = { publishedSlugs: new Set(['mean-reversion']), titleToSlug: new Map([['Mean Reversion', 'mean-reversion']]) };
    const projected = projectSourcePage(raw, publishedSlugs, titleToSlug);
    expect(projected).toContain('[Mean Reversion](/kb/mean-reversion/)');
    // without the maps it would be an unresolved span
    expect(projectSourcePage(raw)).toContain('kb-unresolved');
  });
});

describe('planProjection — three-way on real-shaped projected pages', () => {
  const prior = seedPrior(PROJECTED_V1);

  test('unchanged when the page equals the projection', () => {
    expect(planProjection(PROJECTED_V1, PROJECTED_V1, prior).filter((i) => i.verdict !== 'unchanged')).toEqual([]);
  });

  test('update when the projection changed and the page is clean', () => {
    const v2 = PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'Sharpe 0.5–1.0 now (crowded).');
    const items = planProjection(v2, PROJECTED_V1, prior);
    expect(items.find((i) => i.id === 'key-levels')!.verdict).toBe('update');
  });

  test('drifted when the page section was hand-edited', () => {
    const handEdited = PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'HUMAN NOTE: capacity ~$2B.');
    const items = planProjection(PROJECTED_V1, handEdited, prior);
    expect(items.find((i) => i.id === 'key-levels')!.verdict).toBe('drifted');
  });

  test('orphan when the page has a section the projection dropped', () => {
    const withExtra = `${PROJECTED_V1}\n## Hand-Added\n\nPurely human section.\n`;
    const items = planProjection(PROJECTED_V1, withExtra, seedPrior(PROJECTED_V1));
    expect(items.find((i) => i.id === 'hand-added')!.verdict).toBe('orphan');
  });

  test('create when the projection adds a new section', () => {
    const v2 = `${PROJECTED_V1}## Risks\n\nCrowding, liquidity.\n`;
    const items = planProjection(v2, PROJECTED_V1, prior);
    expect(items.find((i) => i.id === 'risks')!.verdict).toBe('create');
  });
});

describe('applyProjection — drift preserved, clean updates applied, sections created', () => {
  const prior = seedPrior(PROJECTED_V1);

  test('clean update applied; hand-edited section preserved in the SAME run', () => {
    // page: key-levels hand-edited; definition still pristine. projection: definition changed.
    const handEdited = PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'HUMAN NOTE: capacity ~$2B.');
    const v2 = PROJECTED_V1.replace(
      'Stat arb exploits temporary mispricings while market-neutral.',
      'Stat arb: PCA residual mean-reversion, market-neutral.',
    );
    const res = applyProjection(v2, handEdited, prior);
    expect(res.applied).toContain('definition'); // clean projection change lands
    expect(res.preserved).toContain('key-levels'); // hand-edit survives
    expect(bodyOf(res.content, 'key-levels')).toContain('HUMAN NOTE: capacity ~$2B.');
    expect(bodyOf(res.content, 'definition')).toContain('PCA residual mean-reversion');
  });

  test('a new projected section is created and round-trips', () => {
    const v2 = `${PROJECTED_V1}## Risks\n\nCrowding, liquidity.\n`;
    const res = applyProjection(v2, PROJECTED_V1, prior);
    expect(res.created).toContain('risks');
    expect(bodyOf(res.content, 'risks')).toContain('Crowding, liquidity.');
  });

  test('idempotent: reconciling an already-converged page is a no-op', () => {
    const res = applyProjection(PROJECTED_V1, PROJECTED_V1, prior);
    expect(res.applied).toEqual([]);
    expect(res.created).toEqual([]);
    expect(res.content).toBe(PROJECTED_V1);
  });
});

describe('section deletion — provenance-gated pruning (6ji.3 item 5)', () => {
  // baseline projection owns both sections
  const prior = seedPrior(PROJECTED_V1);
  // source later drops "Key Levels" — desired is definition-only
  const V2_DROPPED = ['## Definition', '', 'Stat arb exploits temporary mispricings while market-neutral.', ''].join('\n');

  test('a projection-owned section dropped from source (unmodified) plans as delete', () => {
    const items = planProjection(V2_DROPPED, PROJECTED_V1, prior);
    expect(items.find((i) => i.id === 'key-levels')!.verdict).toBe('delete');
  });

  test('without prune, a delete candidate is preserved on disk', () => {
    const res = applyProjection(V2_DROPPED, PROJECTED_V1, prior, false);
    expect(res.preserved).toContain('key-levels');
    expect(res.deleted).toEqual([]);
    expect(res.content).toContain('## Key Levels');
  });

  test('with prune, the section is removed and drops out of the baseline', () => {
    const res = applyProjection(V2_DROPPED, PROJECTED_V1, prior, true);
    expect(res.deleted).toContain('key-levels');
    expect(res.content).not.toContain('## Key Levels');
    expect(res.newPrior['key-levels']).toBeUndefined();
    expect(res.content).toContain('## Definition'); // sibling intact
  });

  test('a dropped section that was HAND-EDITED is an orphan, preserved even with prune', () => {
    const handEdited = PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'HUMAN kept this.');
    const items = planProjection(V2_DROPPED, handEdited, prior);
    expect(items.find((i) => i.id === 'key-levels')!.verdict).toBe('orphan');
    const res = applyProjection(V2_DROPPED, handEdited, prior, true);
    expect(res.deleted).toEqual([]);
    expect(res.content).toContain('HUMAN kept this.');
  });
});

describe('grounded areas — faithfulness policy (6ji.4)', () => {
  const prior = seedPrior(PROJECTED_V1);

  test('parseGroundedRegions reads a LogSeq / YAML grounded-regions declaration', () => {
    expect([...parseGroundedRegions('title:: X\ngrounded-regions:: definition, key-levels\n')].sort()).toEqual(['definition', 'key-levels']);
    expect([...parseGroundedRegions('grounded-regions: [definition]')]).toEqual(['definition']);
    expect(parseGroundedRegions('no declaration here').size).toBe(0);
  });

  test('a hand-edit to a GROUNDED region is grounded-drift, not ordinary drift', () => {
    const handEdited = PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'HUMAN claim with no citation.');
    const grounded = new Set(['key-levels']);
    const items = planProjection(PROJECTED_V1, handEdited, prior, grounded);
    expect(items.find((i) => i.id === 'key-levels')!.verdict).toBe('grounded-drift');
    // same edit on a NON-grounded region is ordinary drift
    const items2 = planProjection(PROJECTED_V1, handEdited, prior, new Set());
    expect(items2.find((i) => i.id === 'key-levels')!.verdict).toBe('drifted');
  });

  test('grounded-drift is preserved on disk and reported in groundedDrift', () => {
    const handEdited = PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'HUMAN claim with no citation.');
    const res = applyProjection(PROJECTED_V1, handEdited, prior, false, new Set(['key-levels']));
    expect(res.groundedDrift).toContain('key-levels');
    expect(res.preserved).toContain('key-levels');
    expect(res.content).toContain('HUMAN claim with no citation.'); // edit kept (flag, not overwrite)
  });

  test('grounded-drift keeps the baseline stale so it re-alarms until re-grounded', () => {
    const handEdited = PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'HUMAN claim.');
    const res = applyProjection(PROJECTED_V1, handEdited, prior, false, new Set(['key-levels']));
    // baseline NOT advanced to the human text → a second run still flags it
    const again = planProjection(PROJECTED_V1, res.content, res.newPrior, new Set(['key-levels']));
    expect(again.find((i) => i.id === 'key-levels')!.verdict).toBe('grounded-drift');
  });

  test('reconcilePage surfaces groundedDrift via opts.groundedRegions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-grounded-'));
    const pageFile = join(dir, 'g.md');
    const sidecar = join(dir, 'g.json');
    reconcilePage({ desiredContent: PROJECTED_V1, pageFile, sidecarFile: sidecar }); // seed
    writeFileSync(pageFile, PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'HUMAN edit.'), 'utf8');
    const res = reconcilePage({ desiredContent: PROJECTED_V1, pageFile, sidecarFile: sidecar, groundedRegions: new Set(['key-levels']) });
    expect(res.groundedDrift).toContain('key-levels');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('reconcilePage — file + sidecar lifecycle (the real on-disk loop)', () => {
  test('first run seeds page + sidecar; a later hand-edit survives re-projection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-reconcile-'));
    const pageFile = join(dir, 'stat-arb.md');
    const sidecar = join(dir, 'stat-arb.reconcile.json');

    // 1. First projection — seeds the page and prior sidecar.
    const first = reconcilePage({ desiredContent: PROJECTED_V1, pageFile, sidecarFile: sidecar });
    expect(first.firstRun).toBe(true);
    expect(readFileSync(pageFile, 'utf8')).toBe(PROJECTED_V1);
    expect(Object.keys(JSON.parse(readFileSync(sidecar, 'utf8')))).toContain('definition');

    // 2. A human refines a projected section on disk.
    writeFileSync(pageFile, PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'HUMAN: capacity ~$2B, Sharpe ~1.'), 'utf8');

    // 3. Re-project with the SAME source → the hand-edit is DRIFTED and preserved.
    const second = reconcilePage({ desiredContent: PROJECTED_V1, pageFile, sidecarFile: sidecar });
    expect(second.firstRun).toBe(false);
    expect(second.preserved).toContain('key-levels');
    expect(readFileSync(pageFile, 'utf8')).toContain('HUMAN: capacity ~$2B');

    // 4. Now the source itself changes that same section → conflict, still preserved.
    const v2 = PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'Sharpe compressed to 0.5–1.0.');
    const third = reconcilePage({ desiredContent: v2, pageFile, sidecarFile: sidecar });
    expect(third.items.find((i) => i.id === 'key-levels')!.verdict).toBe('conflict');
    expect(readFileSync(pageFile, 'utf8')).toContain('HUMAN: capacity ~$2B'); // human wins until resolved

    rmSync(dir, { recursive: true, force: true });
  });

  test('--plan (dryRun) computes verdicts without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-reconcile-'));
    const pageFile = join(dir, 'p.md');
    const sidecar = join(dir, 'p.json');
    writeFileSync(pageFile, PROJECTED_V1, 'utf8');
    writeFileSync(sidecar, JSON.stringify(seedPrior(PROJECTED_V1)), 'utf8');
    const before = readFileSync(pageFile, 'utf8');
    const v2 = PROJECTED_V1.replace('Sharpe 0.5–2.0. Positions 200–5,000.', 'changed.');
    const res = reconcilePage({ desiredContent: v2, pageFile, sidecarFile: sidecar, dryRun: true });
    expect(res.items.find((i) => i.id === 'key-levels')!.verdict).toBe('update');
    expect(readFileSync(pageFile, 'utf8')).toBe(before); // untouched
    rmSync(dir, { recursive: true, force: true });
  });
});
