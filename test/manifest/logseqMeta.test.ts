import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPageMetadata, readPageMetadataBulk } from '../../src/manifest/logseqMeta';

let tmp: string;
let graph: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'logseqmeta-test-'));
  graph = join(tmp, 'graph');
  mkdirSync(join(graph, 'pages'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makePage(title: string, content: string): void {
  writeFileSync(join(graph, 'pages', title + '.md'), content);
}

describe('readPageMetadata', () => {
  test('parses category, type, project, and tags', () => {
    makePage(
      'Foo',
      `type:: knowledge
category:: Engineering
project:: My Project
tags:: [[Tag One]], [[Tag Two]]
- body content
`
    );
    const m = readPageMetadata(graph, 'Foo');
    expect(m).not.toBeNull();
    expect(m!.category).toBe('Engineering');
    expect(m!.type).toBe('knowledge');
    expect(m!.project).toBe('My Project');
    expect(m!.tags.sort()).toEqual(['Tag One', 'Tag Two']);
    expect(m!.file).toBe('Foo.md');
  });

  test('extracts wikilinks from body (excluding tag wikilinks)', () => {
    makePage(
      'Bar',
      `category:: X
- references [[Alpha]] and [[Beta]]
- and [[Gamma]]
`
    );
    const m = readPageMetadata(graph, 'Bar');
    expect(m!.wikilinks.sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  test('handles missing properties (returns null on absent ones)', () => {
    makePage('Empty', '- just body\n');
    const m = readPageMetadata(graph, 'Empty');
    expect(m).not.toBeNull();
    expect(m!.category).toBeNull();
    expect(m!.type).toBeNull();
    expect(m!.project).toBeNull();
    expect(m!.tags).toEqual([]);
  });

  test('returns null for non-existent page', () => {
    const m = readPageMetadata(graph, 'Nonexistent');
    expect(m).toBeNull();
  });

  test('respects explicit file override', () => {
    makePage('A___B', 'category:: Slash\n');
    const m = readPageMetadata(graph, 'A/B', 'A___B.md');
    expect(m).not.toBeNull();
    expect(m!.category).toBe('Slash');
  });

  test('parses comma-separated plain tags when no wikilinked tags', () => {
    makePage('Plain', 'tags:: alpha, beta, gamma\n');
    const m = readPageMetadata(graph, 'Plain');
    expect(m!.tags).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('readPageMetadataBulk', () => {
  test('returns map keyed by title for resolvable pages; skips unresolvable', () => {
    makePage('A', 'category:: X\n');
    makePage('B', 'category:: Y\n');
    const result = readPageMetadataBulk(graph, [
      { title: 'A' },
      { title: 'B' },
      { title: 'Missing' },
    ]);
    expect(result.size).toBe(2);
    expect(result.get('A')!.category).toBe('X');
    expect(result.get('B')!.category).toBe('Y');
    expect(result.has('Missing')).toBe(false);
  });
});
