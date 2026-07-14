import { describe, expect, test } from 'bun:test';
import { transformBody } from '../../src/lib/logseqToAstro';

/**
 * Golden-file / characterization coverage for transformBody (bd kb-projection-s6h).
 *
 * transformBody's output is byte-sensitive for real Astro consumer sites, and
 * its historical guardrail — the kyber/scripts/regression/777westwood-astro.ts
 * byte-equivalence test — was retired in v0.2.0. These tests FREEZE the current
 * output of each transform step so that any future change (notably bd
 * kb-projection-nk3.1, which will make transformBody emit data-block-id attrs)
 * shows up as a diff here rather than silently altering published pages.
 *
 * Each `expect(...).toBe(...)` is a golden value: if transformBody's output
 * changes, the exact before/after is visible in the failure.
 */

const NO_SLUGS = new Set<string>();
const NO_MAP = new Map<string, string>();

describe('transformBody — step 1: strip LogSeq-only lines', () => {
  test('drops collapsed::, id:: <uuid>, and logseq.*:: lines', () => {
    const input = [
      'Real content',
      'collapsed:: true',
      'id:: 64fa1234-5678-9abc-def0-123456789abc',
      'logseq.order-list-type:: number',
      'More content',
    ].join('\n');
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('Real content\nMore content');
  });

  test('keeps ordinary key:: value property lines (only the three markers are stripped)', () => {
    const input = 'type:: note\nkept content';
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('type:: note\nkept content');
  });
});

describe('transformBody — step 2: strip block refs ((uuid))', () => {
  test('removes the ref and the whitespace around it', () => {
    const input = 'Point one ((64fa1234-5678-9abc-def0-1234))';
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('Point one');
  });
});

describe('transformBody — step 3: strip {{query}} / {{embed}} blocks', () => {
  test('removes a query macro (surrounding spaces are left)', () => {
    const input = 'Before {{query (and something)}} after';
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('Before  after');
  });
  test('removes an embed macro', () => {
    const input = 'See {{embed [[Some Page]]}} here';
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('See  here');
  });
});

describe('transformBody — step 3b: rewrite graph asset refs to /assets/kb/', () => {
  test('rewrites ../, ./ and bare assets/ refs; leaves leading-slash /assets/ alone', () => {
    const input = [
      '![a](../assets/pic.png)',
      '![b](./assets/y.png)',
      '![c](assets/z.png)',
      '![d](/assets/w.png)',
    ].join('\n');
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe(
      [
        '![a](/assets/kb/pic.png)',
        '![b](/assets/kb/y.png)',
        '![c](/assets/kb/z.png)',
        '![d](/assets/w.png)',
      ].join('\n'),
    );
  });
});

describe('transformBody — step 4: normalize bullet-indented headings', () => {
  test('"- ## Heading" becomes a real heading with a preceding blank line', () => {
    const input = 'Intro\n- ## Heading';
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('Intro\n\n## Heading');
  });
});

describe('transformBody — step 5: dedent implicit page-root indent', () => {
  test('subtracts the minimum indent across content lines', () => {
    const input = '  Line A\n    Line B\n  Line C';
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('Line A\n  Line B\nLine C');
  });

  test('tabs become two spaces, then dedent', () => {
    const input = '\t- Item\n\t- Item2';
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('- Item\n- Item2');
  });

  test('flush-left content is left undedented (no negative indent)', () => {
    const input = 'flush\n  indented';
    // minIndent over indent>0 lines = 2; flush line untouched, indented dedented to 0
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('flush\nindented');
  });
});

describe('transformBody — step 6: wikilink rewriting', () => {
  const published = new Set(['foo-bar']);
  const map = new Map([['Foo Bar', 'foo-bar']]);

  test('published title → route link', () => {
    expect(transformBody('[[Foo Bar]]', published, map)).toBe('[Foo Bar](/kb/foo-bar/)');
  });
  test('published title with display alias → route link with alias text', () => {
    expect(transformBody('[[Foo Bar|see here]]', published, map)).toBe('[see here](/kb/foo-bar/)');
  });
  test('unpublished title → unresolved span', () => {
    expect(transformBody('[[Nope]]', published, map)).toBe(
      '<span class="kb-unresolved" title="Not published">Nope</span>',
    );
  });
  test('title absent from map falls back to slugify(); links when that slug is published', () => {
    // "Foo Bar" is not in the map here, but slugify("Foo Bar") === "foo-bar" ∈ published
    expect(transformBody('[[Foo Bar]]', published, NO_MAP)).toBe('[Foo Bar](/kb/foo-bar/)');
  });
});

describe('transformBody — step 7 + trim: blank-line collapse and edge trimming', () => {
  test('collapses 3+ blank lines to one and trims the whole result', () => {
    const input = '\n\nA\n\n\n\nB\n\n';
    expect(transformBody(input, NO_SLUGS, NO_MAP)).toBe('A\n\nB');
  });
  test('empty input → empty string', () => {
    expect(transformBody('', NO_SLUGS, NO_MAP)).toBe('');
  });
});

describe('transformBody — integration: a representative LogSeq page', () => {
  test('combines strip + dedent + heading + wikilink + asset rewrite', () => {
    const input = [
      '- ## Overview',
      '\tid:: 64fa1234-5678-9abc-def0-123456789abc',
      '\tThis links to [[Foo Bar]] and [[Missing]].',
      '\tcollapsed:: true',
      '\t![diagram](../assets/d.png)',
    ].join('\n');
    const published = new Set(['foo-bar']);
    const map = new Map([['Foo Bar', 'foo-bar']]);
    expect(transformBody(input, published, map)).toBe(
      [
        '## Overview',
        'This links to [Foo Bar](/kb/foo-bar/) and <span class="kb-unresolved" title="Not published">Missing</span>.',
        '![diagram](/assets/kb/d.png)',
      ].join('\n'),
    );
  });
});
