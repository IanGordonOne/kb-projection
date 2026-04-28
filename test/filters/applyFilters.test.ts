import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFilters, type FilterContext } from '../../src/filters/applyFilters';

let tmp: string;
let graph: string;
let cache: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'filters-test-'));
  graph = join(tmp, 'graph');
  cache = join(tmp, 'cache');
  mkdirSync(join(graph, 'pages'), { recursive: true });
  mkdirSync(cache, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makePage(title: string, content: string): void {
  writeFileSync(join(graph, 'pages', title + '.md'), content);
}

function ctxFor(entryTitle: string, manifestEntries: { title: string; exclude?: boolean }[]): FilterContext {
  return {
    entryTitle,
    graphPages: join(graph, 'pages'),
    hydrationCacheDir: cache,
    manifest: { entries: manifestEntries.map((e) => ({ title: e.title, exclude: e.exclude })) },
    watchedAdditionPaths: [],
  };
}

describe('applyFilters — prepend/append data filters', () => {
  test('prepend splices the addition body before the host body', () => {
    makePage('Host', '- host body\n');
    makePage('Glossary', '- glossary body\n');
    const ctx = ctxFor('Host', [{ title: 'Host' }, { title: 'Glossary' }]);
    const out = applyFilters('host body', [{ prepend: 'Glossary' }], ctx);
    expect(out).toContain('glossary body');
    expect(out.indexOf('glossary body')).toBeLessThan(out.indexOf('host body'));
  });

  test('append splices the addition body after the host body', () => {
    makePage('Host', '- host body\n');
    makePage('Notice', '- notice body\n');
    const ctx = ctxFor('Host', [{ title: 'Host' }, { title: 'Notice' }]);
    const out = applyFilters('host body', [{ append: 'Notice' }], ctx);
    expect(out).toContain('notice body');
    expect(out.indexOf('host body')).toBeLessThan(out.indexOf('notice body'));
  });

  test('multiple filters apply in declared order', () => {
    makePage('Host', '- host\n');
    makePage('Pre', '- pre\n');
    makePage('Post', '- post\n');
    const ctx = ctxFor('Host', [
      { title: 'Host' },
      { title: 'Pre' },
      { title: 'Post' },
    ]);
    const out = applyFilters(
      'host',
      [{ prepend: 'Pre' }, { append: 'Post' }],
      ctx,
    );
    expect(out.indexOf('pre')).toBeLessThan(out.indexOf('host'));
    expect(out.indexOf('host')).toBeLessThan(out.indexOf('post'));
  });

  test('addition source path appended to watchedAdditionPaths', () => {
    makePage('Host', '- host\n');
    makePage('Glossary', '- glossary\n');
    const ctx = ctxFor('Host', [{ title: 'Host' }, { title: 'Glossary' }]);
    applyFilters('host', [{ prepend: 'Glossary' }], ctx);
    expect(ctx.watchedAdditionPaths.length).toBeGreaterThan(0);
    expect(ctx.watchedAdditionPaths.some((p) => p.endsWith('Glossary.md'))).toBe(true);
  });

  test('missing addition source returns host body unchanged + does not throw', () => {
    makePage('Host', '- host\n');
    const ctx = ctxFor('Host', [{ title: 'Host' }]);
    const out = applyFilters('host body', [{ prepend: 'Nonexistent' }], ctx);
    expect(out).toBe('host body');
  });

  test('self-reference skips silently (no recursion, no throw)', () => {
    makePage('Host', '- host\n');
    const ctx = ctxFor('Host', [{ title: 'Host' }]);
    const out = applyFilters('host body', [{ prepend: 'Host' }], ctx);
    expect(out).toBe('host body');
  });

  test('strips leading property block from spliced addition body', () => {
    makePage(
      'Glossary',
      'type:: anchor\ncategory:: glossary-entry\n\n- glossary actual content\n',
    );
    const ctx = ctxFor('Host', [{ title: 'Host' }, { title: 'Glossary' }]);
    const out = applyFilters('host', [{ prepend: 'Glossary' }], ctx);
    expect(out).not.toContain('type::');
    expect(out).not.toContain('category::');
    expect(out).toContain('glossary actual content');
  });

  test('uses hydration cache when addition is a TG-backed anchor', () => {
    makePage(
      'Glossary',
      'type:: anchor\ntg-doc:: doc-deadbeef\n\n- thin stub\n',
    );
    writeFileSync(
      join(cache, 'Glossary.md'),
      'type:: anchor\ntg-doc:: doc-deadbeef\n\n- hydrated rich content\n',
    );
    const ctx = ctxFor('Host', [{ title: 'Host' }, { title: 'Glossary' }]);
    const out = applyFilters('host', [{ prepend: 'Glossary' }], ctx);
    expect(out).toContain('hydrated rich content');
    expect(out).not.toContain('thin stub');
    // Cache file path should be in watchedAdditionPaths.
    expect(ctx.watchedAdditionPaths.some((p) => p.endsWith('Glossary.md') && p.includes('cache'))).toBe(true);
  });

  test('falls back to LogSeq body when TG anchor has no cache file', () => {
    makePage(
      'Glossary',
      'type:: anchor\ntg-doc:: doc-deadbeef\n\n- fallback stub\n',
    );
    const warns: string[] = [];
    const ctx: FilterContext = {
      ...ctxFor('Host', [{ title: 'Host' }, { title: 'Glossary' }]),
      logger: { warn: (m) => warns.push(m) },
    };
    const out = applyFilters('host', [{ prepend: 'Glossary' }], ctx);
    expect(out).toContain('fallback stub');
    expect(warns.some((w) => w.includes('cache missing'))).toBe(true);
  });
});

describe('applyFilters — redact code filter (host-supplied rules)', () => {
  // Engine ships only `none` as a built-in mode. Tests use a stub
  // ruleset to verify the orchestrator delegates to applyRedact
  // correctly. Site-specific patterns belong to host sites, not
  // the engine.
  const stubRulesByMode = {
    'test-mask': {
      notice: '> **Notice:** stub-redacted.\n\n',
      rules: [
        { pattern: /SECRET-NUMBER/g, replacement: '[REDACTED]' },
        { pattern: /\bAlice\b/g, replacement: '[person]' },
      ],
    },
  };

  test('redact: <host-mode> applies host-supplied rules', () => {
    const ctx: FilterContext = {
      ...ctxFor('Host', [{ title: 'Host' }]),
      redactRulesByMode: stubRulesByMode,
    };
    const body = 'Value: SECRET-NUMBER paid to Alice\n';
    const out = applyFilters(body, [{ redact: 'test-mask' }], ctx);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('[person]');
    expect(out).toContain('stub-redacted');
    expect(out).not.toContain('SECRET-NUMBER');
    expect(out).not.toContain('Alice');
  });

  test('redact: none is a built-in no-op', () => {
    const ctx = ctxFor('Host', [{ title: 'Host' }]);
    const body = 'plain content';
    const out = applyFilters(body, [{ redact: 'none' }], ctx);
    expect(out).toBe(body);
  });

  test('redact: unknown mode (no rulesByMode entry) is a no-op', () => {
    const ctx = ctxFor('Host', [{ title: 'Host' }]);
    const body = 'sensitive content';
    const out = applyFilters(body, [{ redact: 'undefined-mode' }], ctx);
    expect(out).toBe(body);
  });

  test('redact runs after data splices', () => {
    makePage('Notice', '- spend SECRET-NUMBER fee\n');
    const ctx: FilterContext = {
      ...ctxFor('Host', [{ title: 'Host' }, { title: 'Notice' }]),
      redactRulesByMode: stubRulesByMode,
    };
    const out = applyFilters(
      'host body',
      [{ append: 'Notice' }, { redact: 'test-mask' }],
      ctx,
    );
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('SECRET-NUMBER');
  });
});
