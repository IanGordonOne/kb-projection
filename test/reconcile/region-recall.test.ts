/**
 * region-recall.test.ts — RED tests for kb-projection-6ji.8 (P2 of the cross-vendor TDD
 * chain). One test per docs/6ji.8-spec.md §5 acceptance criterion (20 total), each named
 * to cite its criterion number. Fixtures are small hand-authored projected-page strings
 * per §3-4's grammar unless a live/snapshot page is named (§5 #20).
 *
 * P3 (GREEN) implements src/reconcile/region-recall.ts against these tests. Do NOT weaken
 * or add scope beyond what each criterion's probe specifies.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROOT_REGION_ID,
  resolveCitationMap,
  scoreRegionRecall,
  type PageRecall,
  type RegionRecall,
} from '../../src/reconcile/region-recall';
import {
  projectSourcePage,
  reconcileManifest,
  stampProjected,
  type ManifestEntrySummary,
} from '../../src/reconcile/reconcile-projection';
import { AI_AGENT_MEMORY_EXPECTED, AI_AGENT_MEMORY_PROJECTED } from './fixtures/ai-agent-memory-projected';

// A ManifestEntrySummary as it will look AFTER P3 wires regionRecall on (kb-projection-6ji.8
// §3.9). The current ManifestEntrySummary interface does not carry this field yet — that's
// exactly what §5 #17/#18 are testing.
type WiredEntry = ManifestEntrySummary & { regionRecall?: PageRecall };

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';

const rootOf = (page: PageRecall): RegionRecall => {
  const r = page.regions.find((x) => x.id === ROOT_REGION_ID);
  if (!r) throw new Error(`no ${ROOT_REGION_ID} region in page.regions`);
  return r;
};
const regionOf = (page: PageRecall, id: string): RegionRecall => {
  const r = page.regions.find((x) => x.id === id);
  if (!r) throw new Error(`no region '${id}' in page.regions`);
  return r;
};

describe('§5 #1 — ROOT id constant', () => {
  test('ROOT_REGION_ID === \':root\'', () => {
    expect(ROOT_REGION_ID).toBe(':root');
  });
});

describe('§5 #2 — ROOT attribution of heading-less findings', () => {
  const FIXTURE = [
    '- Top bullet',
    '  - Claim A _(well-supported)_ [^a]',
    '  - Claim B _(supported)_ [^b]',
    '  - Claim C _(grounded)_ [^c]',
    '- Citations',
    `- [^a]: A · finding:: ${UUID_A}`,
    `- [^b]: B · finding:: ${UUID_B}`,
    `- [^c]: C · finding:: ${UUID_C}`,
  ].join('\n');

  test('3 band bullets under top-level bullets, no heading, all attribute to :root', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(rootOf(page).total).toBe(3);
  });
});

describe('§5 #3 — innermost-heading attribution', () => {
  const FIXTURE = [
    '## Alpha',
    '- Claim _(well-supported)_ [^a]',
    '',
    '- Citations',
    `- [^a]: A · finding:: ${UUID_A}`,
  ].join('\n');

  test('a heading-body finding attributes to the heading, not ROOT', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(regionOf(page, 'alpha').total).toBe(1);
    expect(rootOf(page).total).toBe(0);
  });
});

describe('§5 #4 — nested regions attribute to innermost only (partition)', () => {
  const FIXTURE = [
    '## Parent',
    '### Child',
    '- Claim _(well-supported)_ [^a]',
    '',
    '- Citations',
    `- [^a]: A · finding:: ${UUID_A}`,
  ].join('\n');

  test('a finding under ### Child counts toward child, never toward the enclosing ## Parent', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(regionOf(page, 'child').total).toBe(1);
    expect(regionOf(page, 'parent').total).toBe(0);
  });
});

describe('§5 #5 — allowlist accepts the four band spellings', () => {
  const FIXTURE = [
    '- A _(well-supported)_ [^a]',
    '- B _(supported)_ [^b]',
    '- C _(grounded)_ [^c]',
    '- D _(unverified: unsupported by cited source)_',
    '- Citations',
    `- [^a]: A · finding:: ${UUID_A}`,
    `- [^b]: B · finding:: ${UUID_B}`,
    `- [^c]: C · finding:: ${UUID_C}`,
  ].join('\n');

  test('well-supported, supported, grounded, and unverified: ... all count as findings', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(page.total).toBe(4);
  });
});

describe('§5 #6 — _(repaired)_ does not inflate a finding', () => {
  const FIXTURE = [
    `- x _(well-supported)_ _(repaired)_ [^k]`,
    '- Citations',
    `- [^k]: x · finding:: ${UUID_A}`,
  ].join('\n');

  test('a line with one supported band plus a repaired mark is ONE finding, not two', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(rootOf(page).total).toBe(1);
  });
});

describe('§5 #7 — _(Manual annotation — …)_ excluded', () => {
  const FIXTURE = '- x _(Manual annotation — this page is research-generated and not independently verified.)_';

  test('a Manual annotation italic note is not a finding', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(page.total).toBe(0);
  });
});

describe('§5 #8 — free-form editorial italic excluded', () => {
  const FIXTURE = '- x _(Sequence now stale relative to the dealer path above.)_';

  test('an arbitrary editorial _(…)_ note is not a finding', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(page.total).toBe(0);
  });
});

describe('§5 #9 — unverified: colon+spaces spelling matches and is uncited', () => {
  const FIXTURE = '- x _(unverified: unsupported by cited source)_';

  test('the unverified band (with colon and spaces) counts as a finding, uncited', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(rootOf(page).total).toBe(1);
    expect(rootOf(page).cited).toBe(0);
  });
});

describe('§5 #10 — cited keys off trailing [^key]', () => {
  const FIXTURE = [
    '- A _(well-supported)_ [^a]',
    '- B _(unverified: unsupported by cited source)_',
    '- Citations',
    `- [^a]: A · finding:: ${UUID_A}`,
  ].join('\n');

  test('only the finding-line carrying a trailing [^key] counts as cited', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(rootOf(page).cited).toBe(1);
  });
});

describe('§5 #11 — recall = cited/total', () => {
  const FIXTURE = [
    '## Section',
    '- A _(well-supported)_ [^a]',
    '- B _(supported)_ [^b]',
    '- C _(grounded)_ [^c]',
    '- D _(unverified: unsupported by cited source)_',
    '',
    '- Citations',
    `- [^a]: A · finding:: ${UUID_A}`,
    `- [^b]: B · finding:: ${UUID_B}`,
    `- [^c]: C · finding:: ${UUID_C}`,
  ].join('\n');

  test('3 cited + 1 uncited finding in one region gives recall === 3/4', () => {
    const page = scoreRegionRecall(FIXTURE);
    const section = regionOf(page, 'section');
    expect(section.total).toBe(4);
    expect(section.cited).toBe(3);
    expect(section.recall).toBe(3 / 4);
  });
});

describe('§5 #12 — zero-findings → null recall (no divide-by-zero)', () => {
  const FIXTURE = ['## Empty', '- Just prose, no bands here.', '', '## Also Empty', '- More prose.'].join('\n');

  test('a grounded-style page body with 0 bands/0 refs never divides by zero', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(page.recall).toBeNull();
    for (const region of page.regions) {
      expect(region.recall).toBeNull();
      expect(Number.isNaN(region.recall)).toBe(false);
    }
  });
});

describe('§5 #13 — findings→region UUID mapping', () => {
  const FIXTURE = ['- Claim _(well-supported)_ [^k]', '- Citations', `- [^k]: Claim · finding:: ${UUID_A}`].join('\n');

  test('a cited bullet resolves its [^key] to the Citations-block UUID', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(rootOf(page).findingIds).toEqual([UUID_A]);
  });
});

describe('§5 #14 — uncited findings expose no UUID', () => {
  const FIXTURE = '- Claim _(unverified: unsupported by cited source)_';

  test('an uncited finding contributes to total but exposes no UUID in findingIds', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(rootOf(page).total).toBe(1);
    expect(rootOf(page).findingIds.length).toBe(0);
  });
});

describe('§5 #15 — Citations definition lines are not findings', () => {
  const FIXTURE = ['- Citations', `- [^a]: text a · finding:: ${UUID_A}`, `- [^b]: text b · finding:: ${UUID_B}`].join('\n');

  test('a page with only a Citations block (no body findings) has total === 0', () => {
    const page = scoreRegionRecall(FIXTURE);
    expect(page.total).toBe(0);
  });
});

describe('§5 #16 — page roll-up is the partition sum', () => {
  const FIXTURE = [
    `- Root claim _(well-supported)_ [^r]`,
    '## Section',
    '- Sec claim A _(well-supported)_ [^a]',
    '- Sec claim B _(unverified: unsupported by cited source)_',
    '',
    '- Citations',
    `- [^r]: R · finding:: ${UUID_C}`,
    `- [^a]: A · finding:: ${UUID_A}`,
  ].join('\n');

  test('page.cited/page.total equal the sum of every region (partition, no double counting)', () => {
    const page = scoreRegionRecall(FIXTURE);
    const sumCited = page.regions.reduce((s, r) => s + r.cited, 0);
    const sumTotal = page.regions.reduce((s, r) => s + r.total, 0);
    expect(page.cited).toBe(sumCited);
    expect(page.total).toBe(sumTotal);
  });
});

describe('§5 #17/#18 — reconcileManifest wiring (regionRecall)', () => {
  function setup(groundedProperty: string | null) {
    const dir = mkdtempSync(join(tmpdir(), 'kb-region-recall-'));
    const pages = join(dir, 'graph', 'pages');
    mkdirSync(pages, { recursive: true });
    const raw = [
      'title:: Sample Page',
      ...(groundedProperty ? [groundedProperty] : []),
      `- Claim _(well-supported)_ [^a]`,
      '- Citations',
      `- [^a]: Claim · finding:: ${UUID_A}`,
    ].join('\n');
    writeFileSync(join(pages, 'Sample Page.md'), raw, 'utf8');
    const manifest = join(dir, 'm.json');
    writeFileSync(
      manifest,
      JSON.stringify({ graphPath: join(dir, 'graph'), entries: [{ title: 'Sample Page' }] }),
      'utf8',
    );
    return { dir, manifest, outDir: join(dir, 'out') };
  }

  test('§5 #17 — a non-grounded source omits regionRecall', () => {
    const { dir, manifest, outDir } = setup(null);
    try {
      const res = reconcileManifest({ manifestPath: manifest, outDir });
      const entry = res.entries[0] as WiredEntry;
      expect(entry.regionRecall).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('§5 #18 — a grounded source carries regionRecall with a :root region', () => {
    const { dir, manifest, outDir } = setup('citation-recall:: 1.0');
    try {
      const res = reconcileManifest({ manifestPath: manifest, outDir });
      const entry = res.entries[0] as WiredEntry;
      expect(entry.regionRecall?.regions?.some((r) => r.id === ROOT_REGION_ID)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('§5 #19 — stamp-neutrality', () => {
  const RAW = [
    'title:: Stamp Neutrality Fixture',
    'citation-recall:: 1.0',
    '- ## Findings',
    '  - Claim one _(well-supported)_ [^k1]',
    '  - Claim two _(unverified: unsupported by cited source)_',
    '- Citations',
    `  - [^k1]: Claim one · finding:: ${UUID_A}`,
  ].join('\n');

  test('scoring the pre-stamp and post-stamp projection yields the same cited/total (stamps are inert)', () => {
    const projected = projectSourcePage(RAW);
    const stamped = stampProjected(projected, 'Stamp Neutrality Fixture');
    expect(stamped).not.toBe(projected); // sanity: stamping actually changed the content

    const before = scoreRegionRecall(projected);
    const after = scoreRegionRecall(stamped);

    expect(after.cited).toBe(before.cited);
    expect(after.total).toBe(before.total);
    expect(after.regions.map((r) => ({ id: r.id, cited: r.cited, total: r.total }))).toEqual(
      before.regions.map((r) => ({ id: r.id, cited: r.cited, total: r.total })),
    );
  });
});

describe('§5 #20 — real-corpus anchor', () => {
  test('the live "AI Agent Memory..." page snapshot scores 16 total / 16 cited, all in :root', () => {
    const page = scoreRegionRecall(AI_AGENT_MEMORY_PROJECTED);
    expect(page.total).toBe(AI_AGENT_MEMORY_EXPECTED.total);
    expect(page.cited).toBe(AI_AGENT_MEMORY_EXPECTED.cited);
    expect(rootOf(page).total).toBe(AI_AGENT_MEMORY_EXPECTED.rootTotal);
  });
});

// ── P4 audit hardening (kb-projection-6ji.8.5) ───────────────────────────────
// The out-of-family (Cato/GPT) audit found the scorer CORRECT but flagged that
// several hard-to-vary §3.4/§3.3 rules were not LOCKED by any test — a wrong
// reimplementation could still pass the 20 §5 tests. These add the missing locks,
// each with an INDEPENDENT expectation (not a Σ-tautology), so a subtly-wrong
// impl goes red here.
describe('P4-audit — hard-to-vary rules that the §5 suite under-locked', () => {
  test('exact-match band: a lone _(unsupported)_ superstring is NOT a finding (an includes("supported") impl would fail)', () => {
    // Guards §3.4 rule 2: "supported" must not substring-match inside unsupported/well-supported.
    expect(scoreRegionRecall('- x _(unsupported)_').total).toBe(0);
    expect(scoreRegionRecall('- x _(well-unsupported-thing)_').total).toBe(0);
  });

  test('partition: page totals equal an INDEPENDENT hardcoded count + pinned per-region totals (not Σ)', () => {
    // #16 in §5 asserts page.cited === Σ region.cited, which is true by construction
    // (region-recall.ts builds page totals as that sum) — tautological. Assert against
    // the fixture's known integers instead: 3 band lines (2 cited), root=1, sec total=2/cited=1.
    const FIX = [
      '- Root claim _(well-supported)_ [^r]',
      '## Sec',
      '- Sec A _(well-supported)_ [^a]',
      '- Sec B _(unverified: unsupported by cited source)_',
      '- Citations',
      `- [^r]: R · finding:: ${UUID_C}`,
      `- [^a]: A · finding:: ${UUID_A}`,
    ].join('\n');
    const page = scoreRegionRecall(FIX);
    expect(page.total).toBe(3); // independent: three allowlisted band lines
    expect(page.cited).toBe(2); // two carry a trailing [^key]
    expect(rootOf(page).total).toBe(1);
    expect(rootOf(page).cited).toBe(1);
    expect(regionOf(page, 'sec').total).toBe(2);
    expect(regionOf(page, 'sec').cited).toBe(1);
  });

  test('dangling ref: an unresolved [^key] still counts as cited but exposes no UUID (findingIds.length < cited)', () => {
    const FIX = ['- A _(well-supported)_ [^missing]', '- Citations', `- [^other]: x · finding:: ${UUID_A}`].join('\n');
    const root = rootOf(scoreRegionRecall(FIX));
    expect(root.cited).toBe(1);
    expect(root.findingIds.length).toBe(0);
  });

  test('CRLF input scores identically to LF (real projected pages may carry \\r\\n)', () => {
    const lines = ['- A _(well-supported)_ [^a]', '- Citations', `- [^a]: A · finding:: ${UUID_A}`];
    const lf = scoreRegionRecall(lines.join('\n'));
    const crlf = scoreRegionRecall(lines.join('\r\n'));
    expect(crlf.total).toBe(lf.total);
    expect(crlf.cited).toBe(lf.cited);
    expect(rootOf(crlf).findingIds).toEqual([UUID_A]);
  });

  test('fence region as a finding container: a band line inside a <!-- region: X --> fence attributes to that fence, not ROOT', () => {
    const FIX = [
      '<!-- region: block -->',
      '- Fenced claim _(well-supported)_ [^a]',
      '<!-- /region -->',
      '- Citations',
      `- [^a]: A · finding:: ${UUID_A}`,
    ].join('\n');
    const page = scoreRegionRecall(FIX);
    const fence = page.regions.find((r) => r.kind === 'fence');
    expect(fence?.total).toBe(1);
    expect(rootOf(page).total).toBe(0);
  });

  test('CITE_DEF does not truncate a longer-than-36 all-hex finding value', () => {
    const long = 'a'.repeat(40);
    expect(resolveCitationMap(`- [^k]: x · finding:: ${long}`).get('k')).toBe(long);
  });
});
