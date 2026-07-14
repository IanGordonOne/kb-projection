import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildObsidianFrontmatter,
  buildProvenanceCallout,
  cleanLogseqBody,
  deOutlineSections,
  projectToObsidian,
  rewriteAssetsToObsidian,
  rewriteWikilinksToObsidian,
  sanitizeObsidianTitle,
  transformPageToObsidian,
} from '../../src/targets/obsidian';

describe('sanitizeObsidianTitle', () => {
  test('spaced slashes become commas (matches the vault convention)', () => {
    expect(sanitizeObsidianTitle('Hands / head / authority — where an AI coach runs')).toBe(
      'Hands, head, authority — where an AI coach runs',
    );
  });
  test('remaining slashes and path-hostile chars are neutralised', () => {
    expect(sanitizeObsidianTitle('TCP/IP')).toBe('TCP-IP');
    expect(sanitizeObsidianTitle('Wanix + ser: why they sign')).toBe('Wanix + ser - why they sign');
    expect(sanitizeObsidianTitle('a*b?c"d<e>f|g')).toBe('abcdefg');
  });
  test('a clean title is unchanged', () => {
    expect(sanitizeObsidianTitle('Confidential Computing')).toBe('Confidential Computing');
  });
});

describe('cleanLogseqBody (de-outline core)', () => {
  test('strips LogSeq-only lines', () => {
    const out = cleanLogseqBody(['- a', '  collapsed:: true', '  id:: 0a1b2c3d-dead-beef-0000-111122223333', '- b'].join('\n'));
    expect(out).not.toContain('collapsed::');
    expect(out).not.toContain('id::');
  });
  test('promotes bullet-indented headings and dedents implicit root', () => {
    const out = cleanLogseqBody(['  - ## Visual', '    - some text', '  - ## Body', '    - more'].join('\n'));
    expect(out).toContain('## Visual');
    expect(out).toMatch(/^## Visual/m); // heading is flush-left, not "- ## Visual"
    expect(out).not.toMatch(/- ## Visual/);
  });
});

describe('deOutlineSections', () => {
  test('promotes bare section-label bullets to ### and dedents their block', () => {
    const out = deOutlineSections(['- Decision', '  - the actual prose here', '- Observation', '  - another point'].join('\n'));
    expect(out).toContain('### Decision');
    expect(out).toContain('### Observation');
    expect(out).toContain('the actual prose here');
    expect(out).not.toMatch(/- Decision/);
  });
  test('does NOT promote bullets containing markdown (links, images, code)', () => {
    const body = ['- See [[Other Page]] for detail', '- ![img](x.png)'].join('\n');
    expect(deOutlineSections(body)).toBe(body);
  });
});

describe('rewriteAssetsToObsidian', () => {
  test('rewrites relative asset embeds to ![[basename]]', () => {
    expect(rewriteAssetsToObsidian('![alt](../assets/x.jpg)')).toBe('![[x.jpg]]');
    expect(rewriteAssetsToObsidian('![](./assets/y.png)')).toBe('![[y.png]]');
    expect(rewriteAssetsToObsidian('![](assets/z.webp)')).toBe('![[z.webp]]');
  });
  test('leaves remote and absolute images alone', () => {
    expect(rewriteAssetsToObsidian('![](https://x/y.jpg)')).toBe('![](https://x/y.jpg)');
    expect(rewriteAssetsToObsidian('![](/assets/kb/a.jpg)')).toBe('![](/assets/kb/a.jpg)');
  });
});

describe('rewriteWikilinksToObsidian', () => {
  test('preserves links; rewrites in-slice sanitized targets; keeps display', () => {
    const map = new Map([['Hands / head / authority', 'Hands, head, authority']]);
    expect(rewriteWikilinksToObsidian('see [[Confidential Computing]]', map)).toBe('see [[Confidential Computing]]');
    expect(rewriteWikilinksToObsidian('see [[Hands / head / authority]]', map)).toBe('see [[Hands, head, authority]]');
    expect(rewriteWikilinksToObsidian('[[Hands / head / authority|the split]]', map)).toBe('[[Hands, head, authority|the split]]');
  });
});

describe('buildObsidianFrontmatter + provenance', () => {
  test('emits clean YAML with provenance keys', () => {
    const fm = buildObsidianFrontmatter('Foo', { type: 'knowledge', created: '[[2026-07-14]]' }, {
      source_ssot_logseq: 'pages/Foo.md',
      source_thought_agent_kb: 'sess-123',
    });
    expect(fm).toContain('title: "Foo"');
    expect(fm).toContain('type: "knowledge"');
    expect(fm).toContain('created: "2026-07-14"'); // [[ ]] stripped
    expect(fm).toContain('source_ssot_logseq: "pages/Foo.md"');
    expect(fm).toContain('source_thought_agent_kb: "sess-123"');
    expect(fm.startsWith('---\n')).toBe(true);
  });
  test('callout records source, not editable', () => {
    const c = buildProvenanceCallout({ source_ssot_logseq: 'pages/Foo.md' });
    expect(c).toContain('[!info] Provenance');
    expect(c).toContain('pages/Foo.md');
  });
});

describe('transformPageToObsidian (end-to-end string)', () => {
  test('property block → frontmatter + callout; body de-outlined; embed rewritten', () => {
    const raw = [
      'title:: Foo',
      'type:: knowledge',
      'source_session:: sess-9',
      '',
      '- ## Visual',
      '  - ![alt](../assets/foo.jpg)',
      '- Decision',
      '  - we chose X because Y.',
    ].join('\n');
    const out = transformPageToObsidian(raw, 'Foo', new Map(), { source_ssot_logseq: 'pages/Foo.md' });
    expect(out).toContain('title: "Foo"');
    expect(out).toContain('source_thought_agent_kb: "sess-9"'); // pulled from source_session
    expect(out).toContain('[!info] Provenance');
    expect(out).toContain('## Visual');
    expect(out).toContain('![[foo.jpg]]');
    expect(out).toContain('### Decision');
    expect(out).toContain('we chose X because Y.');
    expect(out).not.toContain('title:: Foo'); // property block consumed
  });
});

describe('projectToObsidian (dry-run + apply)', () => {
  function fixtureGraph(): string {
    const g = mkdtempSync(join(tmpdir(), 'kbproj-graph-'));
    mkdirSync(join(g, 'pages'), { recursive: true });
    mkdirSync(join(g, 'assets'), { recursive: true });
    writeFileSync(join(g, 'pages', 'Alpha.md'), 'title:: Alpha\ntype:: knowledge\n\n- Decision\n  - alpha links to [[Beta]] and shows ![a](../assets/a.jpg)\n');
    writeFileSync(join(g, 'pages', 'Beta.md'), 'title:: Beta\n\n- just beta\n');
    writeFileSync(join(g, 'assets', 'a.jpg'), 'JPEGBYTES');
    return g;
  }

  test('dry-run returns the plan and writes nothing', () => {
    const g = fixtureGraph();
    const vault = mkdtempSync(join(tmpdir(), 'kbproj-vault-'));
    try {
      const r = projectToObsidian({
        graphDir: g,
        vaultDir: vault,
        pages: [{ title: 'Alpha', tier: 'a' }, { title: 'Beta', tier: 'a' }],
      });
      expect(r.applied).toBe(false);
      expect(r.pages.map((p) => p.title).sort()).toEqual(['Alpha', 'Beta']);
      expect(r.assets.copied).toEqual(['a.jpg']);
      expect(existsSync(join(vault, 'Alpha.md'))).toBe(false); // nothing written
    } finally {
      rmSync(g, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test('apply writes pages + copies assets + MOC', () => {
    const g = fixtureGraph();
    const vault = mkdtempSync(join(tmpdir(), 'kbproj-vault-'));
    try {
      const r = projectToObsidian({
        graphDir: g,
        vaultDir: vault,
        apply: true,
        pages: [{ title: 'Alpha', tier: 'a', group: 'core' }, { title: 'Beta', tier: 'a', group: 'core' }],
        moc: { title: 'Fixture MOC', groupTitles: { core: 'Core' } },
      });
      expect(r.applied).toBe(true);
      expect(existsSync(join(vault, 'Alpha.md'))).toBe(true);
      expect(existsSync(join(vault, 'Beta.md'))).toBe(true);
      expect(existsSync(join(vault, 'assets', 'a.jpg'))).toBe(true);
      expect(existsSync(join(vault, 'Fixture MOC.md'))).toBe(true);
      const alpha = readFileSync(join(vault, 'Alpha.md'), 'utf8');
      expect(alpha).toContain('![[a.jpg]]');
      expect(alpha).toContain('[[Beta]]');
      const moc = readFileSync(join(vault, 'Fixture MOC.md'), 'utf8');
      expect(moc).toContain('## Core');
      expect(moc).toContain('- [[Alpha]]');
    } finally {
      rmSync(g, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test('a missing page is reported, not fatal', () => {
    const g = fixtureGraph();
    const vault = mkdtempSync(join(tmpdir(), 'kbproj-vault-'));
    try {
      const r = projectToObsidian({ graphDir: g, vaultDir: vault, pages: [{ title: 'Nope', tier: 'a' }] });
      expect(r.pages[0].missing).toBe(true);
    } finally {
      rmSync(g, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
