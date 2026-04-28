import { describe, expect, test } from 'bun:test';
import { applyPatch, affectedEntries, type ManifestPatch } from '../../src/manifest/patch';
import type { PublishManifest } from '../../src/manifest/schema';

function baseManifest(): PublishManifest {
  return {
    graphPath: '/g',
    entries: [
      { title: 'Alpha', tier: 'seed' },
      { title: 'Beta', tier: '1-hop', backlinks: ['Alpha'] },
      { title: 'Gamma', tier: '1-hop', backlinks: ['Alpha', 'Beta'] },
    ],
  };
}

describe('applyPatch — add', () => {
  test('appends a new entry', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'add', entry: { title: 'Delta', tier: 'seed' }, rationale: 'new content' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(0);
    expect(r.manifest.entries).toHaveLength(4);
    expect(r.manifest.entries[3].title).toBe('Delta');
    expect(r.changes[0].op).toBe('add');
  });

  test('rejects duplicate title', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'add', entry: { title: 'Alpha', tier: 'seed' }, rationale: 'oops' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('already in manifest');
    expect(r.manifest.entries).toHaveLength(3);
  });

  test('rejects entry missing title', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'add', entry: { tier: 'seed' } as any, rationale: 'bad' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('entry.title is required');
  });
});

describe('applyPatch — remove', () => {
  test('removes by title; preserves order of survivors', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'remove', title: 'Beta', rationale: 'source deleted' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(0);
    expect(r.manifest.entries.map((e) => e.title)).toEqual(['Alpha', 'Gamma']);
    expect(r.changes[0].before?.title).toBe('Beta');
    expect(r.changes[0].after).toBeNull();
  });

  test('errors when title missing', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'remove', title: 'Nonexistent', rationale: 'gone' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('not in manifest');
  });
});

describe('applyPatch — set', () => {
  test('updates a known field', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'set', title: 'Alpha', field: 'exclude', value: true, rationale: 'privacy' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(0);
    expect(r.manifest.entries[0].exclude).toBe(true);
  });

  test('supports forward-rolled fields (e.g. section)', () => {
    const patch: ManifestPatch = {
      operations: [
        { op: 'set', title: 'Alpha', field: 'section', value: 'engineering', rationale: 'category match' },
      ],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(0);
    expect((r.manifest.entries[0] as any).section).toBe('engineering');
  });

  test('refuses to rename via set on title', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'set', title: 'Alpha', field: 'title', value: 'Renamed', rationale: 'oops' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('refusing to rename');
  });

  test('errors when title missing', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'set', title: 'Nonexistent', field: 'tier', value: 'seed', rationale: 'x' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(1);
  });
});

describe('applyPatch — unset', () => {
  test('removes optional field', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'unset', title: 'Beta', field: 'backlinks', rationale: 'recompute' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(0);
    expect((r.manifest.entries[1] as any).backlinks).toBeUndefined();
  });

  test('refuses to unset required fields', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'unset', title: 'Alpha', field: 'tier', rationale: 'no' }],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('cannot unset required field');
  });
});

describe('applyPatch — rationale enforcement', () => {
  test('every op requires non-empty rationale', () => {
    const patch: ManifestPatch = {
      operations: [
        { op: 'add', entry: { title: 'X', tier: 'seed' }, rationale: '' },
        { op: 'remove', title: 'Alpha', rationale: '   ' },
      ],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(2);
    expect(r.errors.every((e) => e.message.includes('rationale'))).toBe(true);
    // Neither op was applied.
    expect(r.manifest.entries.map((e) => e.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

describe('applyPatch — order + multi-op', () => {
  test('applies operations sequentially', () => {
    const patch: ManifestPatch = {
      operations: [
        { op: 'remove', title: 'Beta', rationale: 'r1' },
        { op: 'add', entry: { title: 'Beta', tier: '2-hop' }, rationale: 'r2 — different tier' },
      ],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(0);
    expect(r.manifest.entries.map((e) => e.title)).toEqual(['Alpha', 'Gamma', 'Beta']);
    expect(r.manifest.entries[2].tier).toBe('2-hop');
  });

  test('failed op does not abort the rest', () => {
    const patch: ManifestPatch = {
      operations: [
        { op: 'add', entry: { title: 'Alpha', tier: 'seed' }, rationale: 'will fail (dup)' },
        { op: 'set', title: 'Beta', field: 'exclude', value: true, rationale: 'still applies' },
      ],
    };
    const r = applyPatch(baseManifest(), patch);
    expect(r.errors).toHaveLength(1);
    expect(r.manifest.entries.find((e) => e.title === 'Beta')?.exclude).toBe(true);
  });
});

describe('applyPatch — purity', () => {
  test('does not mutate the input manifest', () => {
    const m = baseManifest();
    const before = JSON.stringify(m);
    applyPatch(m, {
      operations: [{ op: 'remove', title: 'Beta', rationale: 'r' }],
    });
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe('affectedEntries — backlink ripple', () => {
  test('directly-changed entries appear first', () => {
    const patch: ManifestPatch = {
      operations: [
        { op: 'set', title: 'Alpha', field: 'exclude', value: true, rationale: 'r' },
      ],
    };
    const r = applyPatch(baseManifest(), patch);
    const affected = affectedEntries(r.manifest, r.changes);
    expect(affected[0].title).toBe('Alpha');
  });

  test('entries with backlinks to changed titles surface as indirect', () => {
    const patch: ManifestPatch = {
      operations: [
        { op: 'set', title: 'Alpha', field: 'exclude', value: true, rationale: 'r' },
      ],
    };
    const r = applyPatch(baseManifest(), patch);
    const affected = affectedEntries(r.manifest, r.changes);
    const titles = affected.map((e) => e.title);
    expect(titles).toContain('Alpha');
    expect(titles).toContain('Beta');
    expect(titles).toContain('Gamma');
  });

  test('removed entry has no after; backlink-ripple still surfaces dependents', () => {
    const patch: ManifestPatch = {
      operations: [{ op: 'remove', title: 'Alpha', rationale: 'gone' }],
    };
    const r = applyPatch(baseManifest(), patch);
    const affected = affectedEntries(r.manifest, r.changes);
    const titles = affected.map((e) => e.title);
    // Beta + Gamma both backlink Alpha.
    expect(titles).toContain('Beta');
    expect(titles).toContain('Gamma');
    // Alpha is gone from postPatch so isn't in affected.
    expect(titles).not.toContain('Alpha');
  });
});
