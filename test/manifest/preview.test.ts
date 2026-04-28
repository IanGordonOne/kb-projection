import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview, previewToMarkdown } from '../../src/manifest/preview';
import type { ManifestPatch } from '../../src/manifest/patch';
import type { PublishManifest } from '../../src/manifest/schema';

let tmp: string;
let graph: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'preview-test-'));
  graph = join(tmp, 'graph');
  mkdirSync(join(graph, 'pages'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makePage(title: string): void {
  writeFileSync(join(graph, 'pages', title + '.md'), '- body\n');
}

function manifestWith(graphPath: string): PublishManifest {
  return {
    graphPath,
    entries: [
      { title: 'Alpha', tier: 'seed' },
      { title: 'Beta', tier: '1-hop', backlinks: ['Alpha'] },
    ],
  };
}

describe('buildPreview — happy path', () => {
  test('clean add → validation passes', () => {
    makePage('Alpha');
    makePage('Beta');
    makePage('Gamma');
    const patch: ManifestPatch = {
      operations: [
        { op: 'add', entry: { title: 'Gamma', tier: 'seed' }, rationale: 'promoted from drift' },
      ],
    };
    const r = buildPreview(manifestWith(graph), patch);
    expect(r.applyErrors).toHaveLength(0);
    expect(r.validation.valid).toBe(true);
    expect(r.changes).toHaveLength(1);
    expect(r.affected.direct.map((e) => e.title)).toEqual(['Gamma']);
    expect(r.manifest.after.entries).toHaveLength(3);
  });

  test('add of a non-existent LogSeq page → validation fails (ref-integrity)', () => {
    makePage('Alpha');
    makePage('Beta');
    const patch: ManifestPatch = {
      operations: [
        { op: 'add', entry: { title: 'Phantom', tier: 'seed' }, rationale: 'oops' },
      ],
    };
    const r = buildPreview(manifestWith(graph), patch);
    expect(r.applyErrors).toHaveLength(0); // patch applied cleanly
    expect(r.validation.valid).toBe(false); // but result fails ref-check
    expect(r.validation.errors.some((e) => e.message.includes('Phantom'))).toBe(true);
  });
});

describe('buildPreview — backlink ripple', () => {
  test('changing an entry surfaces backlink-dependent entries as indirect', () => {
    makePage('Alpha');
    makePage('Beta');
    const patch: ManifestPatch = {
      operations: [
        { op: 'set', title: 'Alpha', field: 'exclude', value: true, rationale: 'privacy' },
      ],
    };
    const r = buildPreview(manifestWith(graph), patch);
    expect(r.affected.direct.map((e) => e.title)).toEqual(['Alpha']);
    expect(r.affected.indirect.map((e) => e.title)).toEqual(['Beta']);
  });
});

describe('buildPreview — apply errors', () => {
  test('rationale-less op surfaces in applyErrors; not in changes', () => {
    makePage('Alpha');
    makePage('Beta');
    const patch: ManifestPatch = {
      operations: [
        { op: 'set', title: 'Alpha', field: 'exclude', value: true, rationale: '' },
      ],
    };
    const r = buildPreview(manifestWith(graph), patch);
    expect(r.applyErrors).toHaveLength(1);
    expect(r.changes).toHaveLength(0);
  });
});

describe('previewToMarkdown', () => {
  test('renders status, op summaries, rationale, and indirect ripple', () => {
    makePage('Alpha');
    makePage('Beta');
    const patch: ManifestPatch = {
      operations: [
        { op: 'set', title: 'Alpha', field: 'exclude', value: true, rationale: 'privacy review' },
      ],
    };
    const r = buildPreview(manifestWith(graph), patch);
    const md = previewToMarkdown(r, { manifestPath: '/some/manifest.json' });

    expect(md).toContain('# Manifest Patch Preview');
    expect(md).toContain('PATCH WOULD APPLY CLEANLY');
    expect(md).toContain('/some/manifest.json');
    expect(md).toContain('### [set] Alpha');
    expect(md).toContain('privacy review');
    expect(md).toContain('## Indirectly Affected');
    expect(md).toContain('**Beta**');
  });

  test('failure status when validation invalid', () => {
    makePage('Alpha');
    makePage('Beta');
    const patch: ManifestPatch = {
      operations: [
        { op: 'add', entry: { title: 'Phantom', tier: 'seed' }, rationale: 'oops' },
      ],
    };
    const r = buildPreview(manifestWith(graph), patch);
    const md = previewToMarkdown(r);
    expect(md).toContain('PATCH WOULD FAIL VALIDATION');
    expect(md).toContain('## Validation Errors');
  });
});
