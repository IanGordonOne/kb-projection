import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditDrift } from '../../src/manifest/audit-drift';
import type { PublishManifest } from '../../src/manifest/schema';

let tmp: string;
let graph: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'audit-test-'));
  graph = join(tmp, 'graph');
  mkdirSync(join(graph, 'pages'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makePage(title: string, content = '- body\n'): void {
  writeFileSync(join(graph, 'pages', title + '.md'), content);
}

describe('auditDrift — clean state', () => {
  test('no findings when manifest matches LogSeq exactly', () => {
    makePage('Alpha');
    makePage('Beta');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'Alpha', tier: 'seed' },
        { title: 'Beta', tier: 'seed' },
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    expect(report.findings).toHaveLength(0);
    expect(report.counts.error).toBe(0);
  });
});

describe('auditDrift — source-missing', () => {
  test('flags entries whose source page no longer exists', () => {
    makePage('Alpha');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'Alpha', tier: 'seed' },
        { title: 'Beta', tier: 'seed' },
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    expect(report.counts.error).toBe(1);
    const f = report.findings.find((x) => x.kind === 'source-missing');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.ref.title).toBe('Beta');
    expect(f!.ref.entryIndex).toBe(1);
    expect(f!.id).toBe('source-missing:Beta');
  });

  test('graphPath/pages does not exist → single error', () => {
    const manifest: PublishManifest = {
      graphPath: '/nonexistent/path',
      entries: [{ title: 'X', tier: 'seed' }],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    expect(report.counts.error).toBe(1);
    expect(report.findings[0].kind).toBe('source-missing');
  });
});

describe('auditDrift — candidate-page detection', () => {
  test('finds LogSeq pages wikilinked from manifest entries but not in manifest', () => {
    makePage('Alpha', '- A links to [[Beta]] and [[Gamma]]\n');
    makePage('Beta', '- standalone\n');
    makePage('Gamma', '- standalone\n');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [{ title: 'Alpha', tier: 'seed' }],
    };
    const report = auditDrift(manifest, { hops: 1 });

    const candidates = report.findings.filter((f) => f.kind === 'candidate-page');
    expect(candidates).toHaveLength(2);
    const titles = candidates.map((c) => c.ref.title).sort();
    expect(titles).toEqual(['Beta', 'Gamma']);
  });

  test('does not flag pages already in manifest as candidates', () => {
    makePage('Alpha', '- links to [[Beta]]\n');
    makePage('Beta', '- standalone\n');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'Alpha', tier: 'seed' },
        { title: 'Beta', tier: '1-hop' },
      ],
    };
    const report = auditDrift(manifest, { hops: 1 });
    expect(report.findings.filter((f) => f.kind === 'candidate-page')).toHaveLength(0);
  });

  test('does not flag wikilinks that do not resolve to actual pages', () => {
    makePage('Alpha', '- references [[NonExistent]]\n');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [{ title: 'Alpha', tier: 'seed' }],
    };
    const report = auditDrift(manifest, { hops: 1 });
    expect(report.findings.filter((f) => f.kind === 'candidate-page')).toHaveLength(0);
  });

  test('respects --no-candidates (detectCandidates: false)', () => {
    makePage('Alpha', '- links to [[Beta]]\n');
    makePage('Beta');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [{ title: 'Alpha', tier: 'seed' }],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    expect(report.findings.filter((f) => f.kind === 'candidate-page')).toHaveLength(0);
  });

  test('respects maxCandidates cap and emits truncation marker', () => {
    let body = '- links\n';
    for (let i = 0; i < 5; i++) {
      makePage(`Page${i}`);
      body += `- [[Page${i}]]\n`;
    }
    makePage('Alpha', body);
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [{ title: 'Alpha', tier: 'seed' }],
    };
    const report = auditDrift(manifest, { hops: 1, maxCandidates: 2 });
    const candidates = report.findings.filter((f) => f.kind === 'candidate-page');
    // 2 actual + 1 truncation marker
    expect(candidates).toHaveLength(3);
    expect(candidates.some((c) => c.id.includes('__truncation_marker__'))).toBe(true);
  });

  test('hops 0 disables candidate detection (frontier never expands)', () => {
    makePage('Alpha', '- [[Beta]]\n');
    makePage('Beta');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [{ title: 'Alpha', tier: 'seed' }],
    };
    const report = auditDrift(manifest, { hops: 0 });
    expect(report.findings.filter((f) => f.kind === 'candidate-page')).toHaveLength(0);
  });

  test('multi-hop expansion finds 2-hop candidates', () => {
    makePage('Alpha', '- links to [[Beta]]\n');
    makePage('Beta', '- links to [[Gamma]]\n');
    makePage('Gamma');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [{ title: 'Alpha', tier: 'seed' }],
    };
    const report = auditDrift(manifest, { hops: 2 });
    const candidates = report.findings.filter((f) => f.kind === 'candidate-page');
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const titles = candidates.map((c) => c.ref.title);
    expect(titles).toContain('Beta');
    expect(titles).toContain('Gamma');
  });
});

describe('auditDrift — file-title-mismatch', () => {
  test('flags entry whose explicit file resolves but to a different filename', () => {
    makePage('My Real Page');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        // file says one thing, but only the title-derived path actually exists
        { title: 'My Real Page', tier: 'seed', file: 'wrong.md' },
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    // file 'wrong.md' won't resolve → source-missing (since file is explicit)
    expect(report.findings.some((f) => f.kind === 'source-missing')).toBe(true);
  });
});

describe('auditDrift — unknown-field forward-roll', () => {
  test('forward-rolled fields surface as info findings', () => {
    makePage('Alpha');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        // section is a forward-rolled field (kyber-3fh.6 phase 4)
        { title: 'Alpha', tier: 'seed', section: 'engineering' } as any,
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    const f = report.findings.find((x) => x.kind === 'unknown-field');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
    expect(f!.message).toContain('section');
  });
});

describe('auditDrift — ranking', () => {
  test('errors before warnings before info', () => {
    makePage('Alpha', '- [[Candidate]]\n');
    makePage('Candidate');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'Alpha', tier: 'seed' },
        { title: 'Missing', tier: 'seed' }, // → error
        { title: 'Alpha', tier: 'seed', tag: 'x' } as any, // duplicate via title — but skip; here we want unknown-field
      ],
    };
    const report = auditDrift(manifest, { hops: 1 });

    // Errors should come first.
    const sevSeen = report.findings.map((f) => f.severity);
    let i = 0;
    while (i < sevSeen.length && sevSeen[i] === 'error') i++;
    while (i < sevSeen.length && sevSeen[i] === 'warn') i++;
    while (i < sevSeen.length && sevSeen[i] === 'info') i++;
    expect(i).toBe(sevSeen.length);
  });
});

describe('auditDrift — filter findings (kyber-3fh.13)', () => {
  test('filter-reference-broken when prepend target is not in manifest', () => {
    makePage('Host');
    makePage('Glossary');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        {
          title: 'Host',
          tier: 'seed',
          filters: [{ prepend: 'Glossary' }],
        },
        // Glossary intentionally NOT in manifest
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    const f = report.findings.find((x) => x.kind === 'filter-reference-broken');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.message).toContain('Glossary');
  });

  test('filter-reference-broken when append target is exclude:true', () => {
    makePage('Host');
    makePage('Hidden');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'Host', tier: 'seed', filters: [{ append: 'Hidden' }] },
        { title: 'Hidden', tier: '1-hop', exclude: true },
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    const f = report.findings.find((x) => x.kind === 'filter-reference-broken');
    expect(f).toBeDefined();
    expect(f!.message).toContain('exclude');
  });

  test('clean filter ref → no findings', () => {
    makePage('Host');
    makePage('Glossary');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'Host', tier: 'seed', filters: [{ prepend: 'Glossary' }] },
        { title: 'Glossary', tier: '1-hop' },
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    const filterFindings = report.findings.filter((f) =>
      f.kind.startsWith('filter-')
    );
    expect(filterFindings).toHaveLength(0);
  });

  test('filter-self-reference detected', () => {
    makePage('Host');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'Host', tier: 'seed', filters: [{ prepend: 'Host' }] },
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    const f = report.findings.find((x) => x.kind === 'filter-self-reference');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.ref.title).toBe('Host');
  });

  test('filter-cycle detected for two-entry mutual reference', () => {
    makePage('A');
    makePage('B');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'A', tier: 'seed', filters: [{ append: 'B' }] },
        { title: 'B', tier: '1-hop', filters: [{ append: 'A' }] },
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    const cycles = report.findings.filter((f) => f.kind === 'filter-cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].severity).toBe('warn');
    // Cycle message includes both members.
    expect(cycles[0].message).toContain('A');
    expect(cycles[0].message).toContain('B');
  });

  test('filter-cycle detected for three-entry chain A→B→C→A', () => {
    makePage('A');
    makePage('B');
    makePage('C');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'A', tier: 'seed', filters: [{ append: 'B' }] },
        { title: 'B', tier: '1-hop', filters: [{ append: 'C' }] },
        { title: 'C', tier: '1-hop', filters: [{ append: 'A' }] },
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    const cycles = report.findings.filter((f) => f.kind === 'filter-cycle');
    expect(cycles).toHaveLength(1);
  });

  test('filter-redact-mode-unknown for an unsupported mode', () => {
    makePage('Host');
    const manifest = {
      graphPath: graph,
      entries: [
        // bypass the schema (audit accepts the runtime shape directly)
        { title: 'Host', tier: 'seed', filters: [{ redact: 'medium' }] },
      ],
    } as unknown as PublishManifest;
    const report = auditDrift(manifest, { detectCandidates: false });
    const f = report.findings.find((x) => x.kind === 'filter-redact-mode-unknown');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
  });

  test('filter-redact-conflict when both top-level redact and filters[].redact present', () => {
    makePage('Host');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        {
          title: 'Host',
          tier: 'seed',
          redact: 'light',
          filters: [{ redact: 'light' }],
        },
      ],
    };
    const report = auditDrift(manifest, { detectCandidates: false });
    const f = report.findings.find((x) => x.kind === 'filter-redact-conflict');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
  });

  test('filter findings rank above candidate-page', () => {
    makePage('Host', '- has wikilink to [[Other]]\n');
    makePage('Other');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'Host', tier: 'seed', filters: [{ prepend: 'Missing' }] },
      ],
    };
    const report = auditDrift(manifest, { hops: 1 });
    const broken = report.findings.findIndex((f) => f.kind === 'filter-reference-broken');
    const cand = report.findings.findIndex((f) => f.kind === 'candidate-page');
    expect(broken).toBeGreaterThanOrEqual(0);
    expect(cand).toBeGreaterThanOrEqual(0);
    expect(broken).toBeLessThan(cand);
  });
});

describe('auditDrift — finding IDs are stable', () => {
  test('same drift state → same finding IDs', () => {
    makePage('Alpha');
    const manifest: PublishManifest = {
      graphPath: graph,
      entries: [
        { title: 'Alpha', tier: 'seed' },
        { title: 'Missing', tier: 'seed' },
      ],
    };
    const r1 = auditDrift(manifest, { detectCandidates: false });
    const r2 = auditDrift(manifest, { detectCandidates: false });
    const ids1 = r1.findings.map((f) => f.id).sort();
    const ids2 = r2.findings.map((f) => f.id).sort();
    expect(ids1).toEqual(ids2);
  });
});
