import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WIKILINK_RE,
  decodeHtml,
  escapeHtml,
  slugify,
  logseqFilenameCandidates,
  resolveTitleToPage,
  extractWikilinks,
  parseProperties,
  stripLeadingPropertyBlock,
} from '../../src/lib/logseq-primitives';

// The lib-side path also re-exports these; both names must be the SAME symbol.
import * as astro from '../../src/lib/logseqToAstro';
// The manifest-side extractor + resolver, exercised end-to-end below.
import { resolveEntryFile } from '../../src/manifest/validate';

describe('decodeHtml (canonical superset)', () => {
  test('decodes the 4 base entities', () => {
    expect(decodeHtml('a &amp; b &sect; c &mdash; d &ndash; e')).toBe('a & b § c — d – e');
  });
  test('decodes the superset entities (&nbsp; &lt; &gt; &middot; &hellip;)', () => {
    expect(decodeHtml('A &lt; B &gt; C &nbsp;D &middot; E &hellip;')).toBe('A < B > C  D · E …');
  });
});

describe('extractWikilinks', () => {
  test('deduped, decoded, first-seen order', () => {
    const out = extractWikilinks('[[Foo]] text [[Bar|display]] [[Foo]] [[A &amp; B]]');
    expect(out).toEqual(['Foo', 'Bar', 'A & B']);
  });
  test('drops empty and pathologically long titles', () => {
    const long = 'x'.repeat(250);
    expect(extractWikilinks(`[[${long}]] [[Keep]]`)).toEqual(['Keep']);
  });
  test('is idempotent across calls (shared /g WIKILINK_RE lastIndex is reset)', () => {
    const input = '[[One]] [[Two]] [[Three]]';
    const a = extractWikilinks(input);
    const b = extractWikilinks(input);
    expect(a).toEqual(['One', 'Two', 'Three']);
    expect(b).toEqual(a);
  });
});

describe('logseqFilenameCandidates', () => {
  test('emits the 5 canonical encodings in order', () => {
    expect(logseqFilenameCandidates('a/b:c?d"e')).toEqual([
      'a/b:c?d"e',
      'a___b:c?d"e',
      'a/b%3Ac?d"e',
      'a/b:c%3Fd"e',
      'a/b:c?d%22e',
    ]);
  });
});

describe('slugify / escapeHtml / parseProperties (relocated, unchanged)', () => {
  test('slugify keeps underscores, maps §, slices to 80', () => {
    expect(slugify('Hello §World_x')).toBe('hello-sectionworld_x');
  });
  test('escapeHtml escapes & < > "', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });
  test('parseProperties splits leading block from body', () => {
    const { props, body } = parseProperties('type:: note\nsource_session:: s1\n\n- body');
    expect(props.type).toBe('note');
    expect(props.source_session).toBe('s1');
    expect(body.trim()).toBe('- body');
  });
  test('stripLeadingPropertyBlock drops the leading block', () => {
    expect(stripLeadingPropertyBlock('a:: 1\nb:: 2\n\nbody').trim()).toBe('body');
  });
});

describe('re-export identity: logseqToAstro shares the exact primitive symbols', () => {
  test('decodeHtml / slugify / escapeHtml / parseProperties / WIKILINK_RE are the same reference', () => {
    expect(astro.decodeHtml).toBe(decodeHtml);
    expect(astro.slugify).toBe(slugify);
    expect(astro.escapeHtml).toBe(escapeHtml);
    expect(astro.parseProperties).toBe(parseProperties);
    expect(astro.WIKILINK_RE).toBe(WIKILINK_RE);
  });
});

// ISC-31/32: the finding-B guard. A `[[wikilink]]` title carrying `&lt;` must
// resolve to the SAME on-disk page whether the manifest path or the lib path
// touches it. Before consolidation, the manifest decodeHtml handled `&lt;` and
// the lib one did not, so the two paths could diverge. One shared decodeHtml
// (+ one shared resolver) locks that closed.
describe('finding-B equivalence: &lt; resolves identically on both paths', () => {
  let tmp: string;
  let graph: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'logseq-prim-eq-'));
    graph = join(tmp, 'graph');
    mkdirSync(join(graph, 'pages'), { recursive: true });
    // The real page whose title, decoded, is "A < B".
    writeFileSync(join(graph, 'pages', 'A < B.md'), 'type:: note\n- content\n');
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test('both paths decode + resolve the same file (non-null)', () => {
    const raw = 'A &lt; B';

    // Manifest path: shared extractWikilinks decodes, resolveEntryFile resolves.
    const [manifestTitle] = extractWikilinks(`[[${raw}]]`);
    expect(manifestTitle).toBe('A < B');
    const manifestResolved = resolveEntryFile(graph, { title: manifestTitle });

    // Lib path: re-exported decodeHtml decodes, resolveLogseqPath resolves.
    const libTitle = astro.decodeHtml(raw.trim());
    expect(libTitle).toBe('A < B');
    const libResolved = astro.resolveLogseqPath({ title: libTitle, tier: '' }, join(graph, 'pages'));

    expect(manifestResolved).not.toBeNull();
    expect(libResolved).not.toBeNull();
    expect(manifestResolved).toBe(libResolved!);
  });
});

// ISC-36: recurrence guard. The primitives that were consolidated must have
// exactly ONE definition under src/ — if a future edit re-inlines a copy (the
// pattern that caused the original drift), this test fails.
describe('recurrence guard: one definition per consolidated primitive', () => {
  const SRC = join(import.meta.dir, '..', '..', 'src');

  function allTs(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) out.push(...allTs(p));
      else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  const files = allTs(SRC);

  test('exactly one decodeHtml definition project-wide', () => {
    const defs = files.filter((f) =>
      /(?:export\s+)?function decodeHtml\s*\(/.test(readFileSync(f, 'utf8')),
    );
    expect(defs.map((f) => f.replace(SRC, 'src'))).toEqual(['src/lib/logseq-primitives.ts']);
  });

  test('exactly one 5-encoding candidate array (the %3A/%3F/%22 probe)', () => {
    const hits = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return src.includes("%3A") && src.includes("%3F") && src.includes("%22");
    });
    expect(hits.map((f) => f.replace(SRC, 'src'))).toEqual(['src/lib/logseq-primitives.ts']);
  });
});
