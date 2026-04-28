import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest, validateManifest, validateReferences, resolveEntryFile } from '../../src/manifest/validate';

let tmp: string;
let graph: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'manifest-test-'));
  graph = join(tmp, 'graph');
  mkdirSync(join(graph, 'pages'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makePage(title: string, content = '- body\n'): string {
  const file = title + '.md';
  writeFileSync(join(graph, 'pages', file), content);
  return file;
}

describe('parseManifest — happy path', () => {
  test('accepts a minimal valid manifest', () => {
    const result = parseManifest({
      graphPath: '/some/path',
      entries: [{ title: 'Foo', tier: 'seed' }],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest!.entries).toHaveLength(1);
    expect(result.manifest!.entries[0].title).toBe('Foo');
  });

  test('accepts all schema v1 fields', () => {
    const result = parseManifest({
      $schema: 'https://example.com/schema.json',
      generatedAt: '2026-04-26T00:00:00Z',
      graphPath: '/g',
      entries: [
        {
          title: 'Foo',
          tier: '1-hop',
          backlinks: ['Bar', 'Baz'],
          exclude: false,
          redact: 'light',
          file: 'Foo.md',
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('parseManifest — schema-shape errors', () => {
  test('non-object root', () => {
    const r = parseManifest('not an object');
    expect(r.valid).toBe(false);
    expect(r.errors[0].path).toBe('$');
    expect(r.manifest).toBeNull();
  });

  test('missing graphPath', () => {
    const r = parseManifest({ entries: [] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '$.graphPath')).toBe(true);
  });

  test('missing entries', () => {
    const r = parseManifest({ graphPath: '/g' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '$.entries')).toBe(true);
  });

  test('entries not an array', () => {
    const r = parseManifest({ graphPath: '/g', entries: 'oops' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '$.entries')).toBe(true);
  });

  test('entry missing title', () => {
    const r = parseManifest({ graphPath: '/g', entries: [{ tier: 'seed' }] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '$.entries[0].title')).toBe(true);
  });

  test('entry has unknown tier value', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'foo' }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '$.entries[0].tier')).toBe(true);
  });

  test('entry has unknown redact value', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', redact: 'heavy' }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '$.entries[0].redact')).toBe(true);
  });

  test('entry exclude must be boolean', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', exclude: 'yes' }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '$.entries[0].exclude')).toBe(true);
  });

  test('entry backlinks must be array of strings', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', backlinks: ['ok', 42] }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.startsWith('$.entries[0].backlinks'))).toBe(true);
  });

  test('unknown manifest field is warned, not error', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [],
      futureField: 'meh',
    });
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.path === '$.futureField')).toBe(true);
  });

  test('unknown entry field is warned, not error', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', section: 'engineering' }],
    });
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.path === '$.entries[0].section')).toBe(true);
  });

  test('duplicate titles produce a single combined error', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [
        { title: 'X', tier: 'seed' },
        { title: 'X', tier: '1-hop' },
        { title: 'Y', tier: 'seed' },
      ],
    });
    expect(r.valid).toBe(false);
    const dup = r.errors.find((e) => e.message.includes('duplicate title'));
    expect(dup).toBeDefined();
    expect(dup!.message).toContain('"X"');
    expect(dup!.path).toContain('0');
    expect(dup!.path).toContain('1');
  });
});

describe('parseManifest — filters (kyber-3fh.13)', () => {
  test('accepts an entry with valid prepend/append/redact filters', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [
        {
          title: 'X',
          tier: 'seed',
          filters: [
            { prepend: 'Glossary' },
            { redact: 'light' },
            { append: 'Notice' },
          ],
        },
      ],
    });
    expect(r.valid).toBe(true);
    expect(r.manifest!.entries[0].filters).toHaveLength(3);
  });

  test('accepts redact: "none" no-op filter', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', filters: [{ redact: 'none' }] }],
    });
    expect(r.valid).toBe(true);
  });

  test('rejects filters that is not an array', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', filters: 'oops' }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '$.entries[0].filters')).toBe(true);
  });

  test('rejects a filter element that has multiple keys', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [
        { title: 'X', tier: 'seed', filters: [{ prepend: 'A', append: 'B' }] },
      ],
    });
    expect(r.valid).toBe(false);
    expect(
      r.errors.some(
        (e) => e.path === '$.entries[0].filters[0]' && e.message.includes('exactly one key')
      )
    ).toBe(true);
  });

  test('rejects an empty filter element', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', filters: [{}] }],
    });
    expect(r.valid).toBe(false);
  });

  test('rejects a filter with unknown key', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', filters: [{ summarize: 'short' }] }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes('unknown filter key'))).toBe(true);
  });

  test('rejects prepend/append with non-string title', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', filters: [{ prepend: 123 }] }],
    });
    expect(r.valid).toBe(false);
  });

  test('rejects empty-string prepend title', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', filters: [{ prepend: '' }] }],
    });
    expect(r.valid).toBe(false);
  });

  test('accepts arbitrary string redact mode (host-supplied)', () => {
    // Mode validity is host-known; the engine accepts any non-empty
    // string at the schema layer. cli-audit-drift's --known-redact-modes
    // option does host-aware checking.
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', filters: [{ redact: 'host-defined' }] }],
    });
    expect(r.valid).toBe(true);
  });

  test('rejects empty-string redact mode', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', filters: [{ redact: '' }] }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === '$.entries[0].filters[0].redact')).toBe(true);
  });

  test('rejects entry with both legacy redact and filters[].redact (mutual exclusion)', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [
        {
          title: 'X',
          tier: 'seed',
          redact: 'light',
          filters: [{ redact: 'light' }],
        },
      ],
    });
    expect(r.valid).toBe(false);
    expect(
      r.errors.some(
        (e) => e.path === '$.entries[0].redact' && e.message.includes('both legacy')
      )
    ).toBe(true);
  });

  test('legacy redact alone still works', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', redact: 'light' }],
    });
    expect(r.valid).toBe(true);
  });

  test('filters[].redact alone still works', () => {
    const r = parseManifest({
      graphPath: '/g',
      entries: [{ title: 'X', tier: 'seed', filters: [{ redact: 'light' }] }],
    });
    expect(r.valid).toBe(true);
  });
});

describe('resolveEntryFile', () => {
  test('resolves explicit file field', () => {
    makePage('My Page');
    const path = resolveEntryFile(graph, { title: 'My Page', file: 'My Page.md' });
    expect(path).toBe(join(graph, 'pages', 'My Page.md'));
  });

  test('returns null when explicit file is missing', () => {
    const path = resolveEntryFile(graph, { title: 'Missing', file: 'Missing.md' });
    expect(path).toBeNull();
  });

  test('falls back to title-derived filename', () => {
    makePage('My Page');
    const path = resolveEntryFile(graph, { title: 'My Page' });
    expect(path).toBe(join(graph, 'pages', 'My Page.md'));
  });

  test('handles slash in title via ___', () => {
    makePage('A___B');
    const path = resolveEntryFile(graph, { title: 'A/B' });
    expect(path).toBe(join(graph, 'pages', 'A___B.md'));
  });
});

describe('validateReferences', () => {
  test('all entries resolve → no errors', () => {
    makePage('Alpha');
    makePage('Beta');
    const result = validateManifest({
      graphPath: graph,
      entries: [
        { title: 'Alpha', tier: 'seed' },
        { title: 'Beta', tier: '1-hop' },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('entry whose page is missing → error', () => {
    makePage('Alpha');
    const result = validateManifest({
      graphPath: graph,
      entries: [
        { title: 'Alpha', tier: 'seed' },
        { title: 'Gamma', tier: '1-hop' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Gamma'))).toBe(true);
  });

  test('skipRefIntegrity bypasses filesystem check', () => {
    const result = validateManifest(
      {
        graphPath: '/nonexistent',
        entries: [{ title: 'Whatever', tier: 'seed' }],
      },
      { skipRefIntegrity: true }
    );
    expect(result.valid).toBe(true);
  });

  test('graphPathOverride takes precedence', () => {
    makePage('Alpha');
    const result = validateManifest(
      {
        graphPath: '/nonexistent',
        entries: [{ title: 'Alpha', tier: 'seed' }],
      },
      { graphPathOverride: graph }
    );
    expect(result.valid).toBe(true);
  });

  test('missing graphPath/pages dir → error', () => {
    const result = validateManifest({
      graphPath: '/nonexistent/path',
      entries: [{ title: 'X', tier: 'seed' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('does not exist'))).toBe(true);
  });
});
