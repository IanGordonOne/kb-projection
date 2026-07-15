import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyProjection,
  planProjection,
  projectSourcePage,
  projectedMarker,
  reconcileManifest,
  reconcilePage,
  reorderProjected,
  slugMapsFromManifest,
  sourceIsGrounded,
  stampProjected,
} from '../../src/reconcile/reconcile-projection';
import { parseRegions, regionBody } from '../../src/reconcile/region-core';

// A fresh projection: heading regions stamped as PROJECTED (source-owned).
const PROJECTED_V1 = [
  '## Definition',
  '<!-- projected: source="Stat Arb#definition" -->',
  '',
  'Projected definition v1.',
  '',
  '## Levels',
  '<!-- projected: source="Stat Arb#levels" -->',
  '',
  'Levels v1.',
  '',
].join('\n');

// A page mixing a projected region with a human-authored (non-projected) one.
const MIXED = [
  '## Definition',
  '<!-- projected: source="Stat Arb#definition" -->',
  '',
  'Projected definition v1.',
  '',
  '## My Notes',
  '',
  'Hand-written notes — not projected.',
  '',
].join('\n');

const region = (c: string, id: string) => parseRegions(c, 'p').find((r) => r.id === id)!;
const bodyOf = (c: string, id: string) => regionBody(c, region(c, id)).trim();

describe('projectedMarker — projected vs free regions', () => {
  test('a region with a projected comment is projected, with its source', () => {
    expect(projectedMarker(MIXED, region(MIXED, 'definition'))).toEqual({ projected: true, source: 'Stat Arb#definition' });
  });
  test('a region without a marker is free (non-projected)', () => {
    expect(projectedMarker(MIXED, region(MIXED, 'my-notes'))).toEqual({ projected: false });
  });
  test('attribute form on a SectionHeading anchor is detected', () => {
    const c = '<SectionHeading level="2" id="x" text="X" projected source="S#x" />\n\nbody';
    expect(projectedMarker(c, region(c, 'x'))).toEqual({ projected: true, source: 'S#x' });
  });
});

describe('stampProjected — mark a fresh projection', () => {
  test('inserts a projected marker as the first body line of each heading, idempotently', () => {
    const plain = '## Definition\n\nBody.\n\n## Levels\n\nMore.';
    const stamped = stampProjected(plain, 'Stat Arb');
    expect(projectedMarker(stamped, region(stamped, 'definition'))).toEqual({ projected: true, source: 'Stat Arb#definition' });
    expect(projectedMarker(stamped, region(stamped, 'levels'))).toEqual({ projected: true, source: 'Stat Arb#levels' });
    expect(stampProjected(stamped, 'Stat Arb')).toBe(stamped); // idempotent
  });
});

describe('planProjection — source-wins on projected regions only', () => {
  test('unchanged when the page matches the projection', () => {
    expect(planProjection(PROJECTED_V1, PROJECTED_V1).filter((i) => i.verdict !== 'unchanged')).toEqual([]);
  });

  test('a projected region hand-edited off-source → REGENERATE (not preserve)', () => {
    const handEdited = PROJECTED_V1.replace('Projected definition v1.', 'A HUMAN edited this projected region.');
    const prior = { definition: applyProjection(PROJECTED_V1, PROJECTED_V1).newPrior.definition, levels: applyProjection(PROJECTED_V1, PROJECTED_V1).newPrior.levels };
    const items = planProjection(PROJECTED_V1, handEdited, prior);
    const def = items.find((i) => i.id === 'definition')!;
    expect(def.verdict).toBe('regenerate');
    expect(def.drift).toBe('hand-edited');
  });

  test('a source change → regenerate', () => {
    const v2 = PROJECTED_V1.replace('Projected definition v1.', 'Projected definition v2.');
    const prior = applyProjection(PROJECTED_V1, PROJECTED_V1).newPrior;
    expect(planProjection(v2, PROJECTED_V1, prior).find((i) => i.id === 'definition')!.verdict).toBe('regenerate');
  });

  test('a NON-projected region is never in the plan (free surface, untouched)', () => {
    // MIXED has a hand-authored my-notes; the projection only knows about definition.
    const desired = [PROJECTED_V1.split('## Levels')[0]].join(''); // projection with only definition
    const items = planProjection(desired, MIXED);
    expect(items.some((i) => i.id === 'my-notes')).toBe(false);
  });

  test('a projected region dropped from source → remove; a free region absent from source is NOT removed', () => {
    const desiredDefOnly = PROJECTED_V1.split('## Levels')[0];
    // page = MIXED (projected definition + free my-notes). Source dropped nothing projected here,
    // but if the page had a projected 'levels' not in desired, it would be removed:
    const pageWithStaleProjected = MIXED.replace('## My Notes', '## Levels\n<!-- projected: source="Stat Arb#levels" -->\n\nstale\n\n## My Notes');
    const items = planProjection(desiredDefOnly, pageWithStaleProjected);
    expect(items.find((i) => i.id === 'levels')!.verdict).toBe('remove');
    expect(items.some((i) => i.id === 'my-notes')).toBe(false); // free region left alone
  });
});

describe('applyProjection — source-wins remedy', () => {
  test('regenerates a hand-edited projected region, overwriting the edit', () => {
    const handEdited = PROJECTED_V1.replace('Projected definition v1.', 'HUMAN off-source edit.');
    const prior = applyProjection(PROJECTED_V1, PROJECTED_V1).newPrior;
    const res = applyProjection(PROJECTED_V1, handEdited, prior);
    expect(res.regenerated).toContain('definition');
    expect(res.handEdited).toContain('definition'); // reported like hash-mismatch
    expect(bodyOf(res.content, 'definition')).toContain('Projected definition v1.'); // source won
    expect(bodyOf(res.content, 'definition')).not.toContain('HUMAN off-source edit.');
  });

  test('leaves a free (non-projected) region completely untouched', () => {
    const desiredDefOnly = PROJECTED_V1.split('## Levels')[0];
    const editedNotes = MIXED.replace('Hand-written notes — not projected.', 'Human rewrote their own notes.');
    const res = applyProjection(desiredDefOnly, editedNotes);
    expect(bodyOf(res.content, 'my-notes')).toContain('Human rewrote their own notes.'); // untouched
  });

  test('idempotent when the page already matches', () => {
    const res = applyProjection(PROJECTED_V1, PROJECTED_V1);
    expect(res.regenerated).toEqual([]);
    expect(res.content).toBe(PROJECTED_V1);
  });
});

describe('reconcilePage — on-disk lifecycle (source-wins)', () => {
  test('first run seeds; a later off-source hand-edit is regenerated, a free region survives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-reconcile-'));
    const pageFile = join(dir, 'p.md');
    const sidecar = join(dir, 'p.reconcile.json');

    // Seed with a page that has a projected region + a free region.
    const desiredDefOnly = PROJECTED_V1.split('## Levels')[0];
    reconcilePage({ desiredContent: MIXED, pageFile, sidecarFile: sidecar }); // first run writes MIXED

    // Human edits BOTH a projected region and their own free region on disk.
    let onDisk = readFileSync(pageFile, 'utf8')
      .replace('Projected definition v1.', 'HUMAN touched the projected region.')
      .replace('Hand-written notes — not projected.', 'Human updated their notes.');
    writeFileSync(pageFile, onDisk, 'utf8');

    // Re-project (definition only). Projected region regenerates; free notes survive.
    const res = reconcilePage({ desiredContent: desiredDefOnly, pageFile, sidecarFile: sidecar });
    expect(res.regenerated).toContain('definition');
    expect(res.handEdited).toContain('definition');
    const after = readFileSync(pageFile, 'utf8');
    expect(after).toContain('Projected definition v1.'); // source won on the projected region
    expect(after).not.toContain('HUMAN touched the projected region.');
    expect(after).toContain('Human updated their notes.'); // free region preserved
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('reorderProjected — projected regions to source order (6ji.5)', () => {
  // desired (source) order: definition, then levels.
  const desired = PROJECTED_V1;
  // page has them SWAPPED (levels before definition), plus a free region between.
  const swapped = [
    '## Levels',
    '<!-- projected: source="Stat Arb#levels" -->',
    '',
    'Levels v1.',
    '',
    '## My Notes',
    '',
    'Free human region.',
    '',
    '## Definition',
    '<!-- projected: source="Stat Arb#definition" -->',
    '',
    'Projected definition v1.',
    '',
  ].join('\n');

  test('reorders projected regions to match source order', () => {
    const { content, moved } = reorderProjected(swapped, desired);
    expect(content.indexOf('## Definition')).toBeLessThan(content.indexOf('## Levels'));
    expect(moved.length).toBeGreaterThan(0); // a projected region was repositioned
    // content of the reordered region is intact
    expect(content).toContain('Projected definition v1.');
  });

  test('does NOT move a free (non-projected) region', () => {
    const { content } = reorderProjected(swapped, desired);
    expect(content).toContain('Free human region.'); // survives
    // my-notes was never a reorder candidate (not projected)
    expect(reorderProjected(swapped, desired).moved).not.toContain('my-notes');
  });

  test('no-op when projected regions are already in source order', () => {
    const { content, moved } = reorderProjected(PROJECTED_V1, PROJECTED_V1);
    expect(moved).toEqual([]);
    expect(content).toBe(PROJECTED_V1);
  });

  test('applyProjection reorders projected regions and reports them', () => {
    const res = applyProjection(desired, swapped);
    expect(res.reordered.length).toBeGreaterThan(0);
    expect(res.content.indexOf('## Definition')).toBeLessThan(res.content.indexOf('## Levels'));
    expect(res.content).toContain('Free human region.'); // free region survives
  });
});

describe('sourceIsGrounded', () => {
  test('true iff the source carries citation-recall::', () => {
    expect(sourceIsGrounded('title:: X\ncitation-recall:: 0.82\n')).toBe(true);
    expect(sourceIsGrounded('title:: X\ntype:: note\n')).toBe(false);
  });
});

describe('projectSourcePage + slugMapsFromManifest', () => {
  test('de-bullets a LogSeq body and strips the property block', () => {
    const raw = ['title:: Stat Arb', '', '- ## Definition', '  - Real body.'].join('\n');
    const projected = projectSourcePage(raw);
    expect(projected).toContain('## Definition');
    expect(projected).not.toContain('title:: Stat Arb');
  });

  test('resolves wikilinks from the manifest slug maps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-manifest-'));
    const mf = join(dir, 'm.json');
    writeFileSync(mf, JSON.stringify({ entries: [{ title: 'Mean Reversion' }, { title: 'Secret', exclude: true }] }), 'utf8');
    const { publishedSlugs } = slugMapsFromManifest(mf);
    expect(publishedSlugs.has('mean-reversion')).toBe(true);
    expect(publishedSlugs.has('secret')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('reconcileManifest — batch source-wins into a config-driven out-dir', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'kb-batch-'));
    const pages = join(dir, 'graph', 'pages');
    mkdirSync(pages, { recursive: true });
    writeFileSync(join(pages, 'Stat Arb.md'), ['title:: Stat Arb', '- ## Definition', '  - Stat arb body.', '- ## Levels', '  - Levels body.'].join('\n'), 'utf8');
    writeFileSync(join(pages, 'Hidden.md'), ['title:: Hidden', '- ## Secret', '  - nope.'].join('\n'), 'utf8');
    const manifest = join(dir, 'm.json');
    writeFileSync(manifest, JSON.stringify({ graphPath: join(dir, 'graph'), entries: [{ title: 'Stat Arb' }, { title: 'Hidden', exclude: true }] }), 'utf8');
    return { dir, manifest, outDir: join(dir, 'out') };
  }

  test('projects + stamps + reconciles each published entry; excluded manifest entries skipped', () => {
    const { dir, manifest, outDir } = setup();
    const res = reconcileManifest({ manifestPath: manifest, outDir });
    expect(res.entries.map((e) => e.slug)).toEqual(['stat-arb']);
    expect(res.entries[0].firstRun).toBe(true);
    const page = readFileSync(join(outDir, 'stat-arb.md'), 'utf8');
    expect(page).toContain('## Definition');
    expect(page).toContain('<!-- projected: source="Stat Arb#definition" -->'); // stamped
    rmSync(dir, { recursive: true, force: true });
  });

  test('second batch run is idempotent (nothing regenerated)', () => {
    const { dir, manifest, outDir } = setup();
    reconcileManifest({ manifestPath: manifest, outDir });
    const res = reconcileManifest({ manifestPath: manifest, outDir });
    expect(res.entries[0].firstRun).toBe(false);
    expect(res.entries[0].regenerated).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
