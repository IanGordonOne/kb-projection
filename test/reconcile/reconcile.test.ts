import { describe, expect, test } from 'bun:test';
import { apply, formatPlan, hashBody, plan, type DesiredRegion, type PriorState } from '../../src/reconcile/reconcile';
import { parseRegions, regionBody } from '../../src/reconcile/region-core';

// A projected page: two <SectionHeading> regions projection owns.
const PAGE = [
  '<SectionHeading level="2" id="intro" text="Intro" />',
  '',
  'Projected v1.',
  '',
  '<SectionHeading level="2" id="body" text="Body" />',
  '',
  'Body projected v1.',
  '',
].join('\n');

const bodyOf = (content: string, id: string) => regionBody(content, parseRegions(content, 'p').find((r) => r.id === id)!);

/** Establish a clean baseline: project desired == current, capture prior hashes. */
function baseline(content: string, desired: DesiredRegion[]): PriorState {
  return apply(content, desired, {}).newPrior;
}

describe('reconcile plan — three-way verdicts', () => {
  const desired: DesiredRegion[] = [
    { id: 'intro', body: 'Projected v1.' },
    { id: 'body', body: 'Body projected v1.' },
  ];
  const prior = baseline(PAGE, desired);

  test('unchanged when actual already matches desired', () => {
    const items = plan(PAGE, desired, prior);
    expect(items.every((i) => i.verdict === 'unchanged')).toBe(true);
  });

  test('update when source changed and output is clean', () => {
    const next = plan(PAGE, [{ id: 'intro', body: 'Projected v2.' }, desired[1]], prior);
    expect(next.find((i) => i.id === 'intro')!.verdict).toBe('update');
  });

  test('drifted when a projected span was hand-edited and source did not change', () => {
    // human edits the actual page's intro
    const handEdited = PAGE.replace('Projected v1.', 'A HUMAN wrote this.');
    const items = plan(handEdited, desired, prior);
    expect(items.find((i) => i.id === 'intro')!.verdict).toBe('drifted');
  });

  test('conflict when BOTH the hand-edit and the source changed', () => {
    const handEdited = PAGE.replace('Projected v1.', 'A HUMAN wrote this.');
    const items = plan(handEdited, [{ id: 'intro', body: 'Projected v2.' }, desired[1]], prior);
    expect(items.find((i) => i.id === 'intro')!.verdict).toBe('conflict');
  });

  test('create when a desired region is absent from the page', () => {
    const items = plan(PAGE, [...desired, { id: 'outro', body: 'New.', afterId: 'body' }], prior);
    expect(items.find((i) => i.id === 'outro')!.verdict).toBe('create');
  });
});

describe('reconcile apply — THE KEYSTONE: drift is preserved, not stomped', () => {
  const desired: DesiredRegion[] = [
    { id: 'intro', body: 'Projected v1.' },
    { id: 'body', body: 'Body projected v1.' },
  ];
  const prior = baseline(PAGE, desired);

  test('a clean source change is applied', () => {
    const res = apply(PAGE, [{ id: 'intro', body: 'Projected v2.' }, desired[1]], prior);
    expect(res.applied).toContain('intro');
    expect(bodyOf(res.content, 'intro')).toBe('Projected v2.');
  });

  test('a hand-edited projected region SURVIVES re-projection (no stomp)', () => {
    const handEdited = PAGE.replace('Projected v1.', 'A HUMAN wrote this.');
    // projection re-runs with the SAME source
    const res = apply(handEdited, desired, prior);
    expect(res.preserved).toContain('intro');
    expect(res.applied).not.toContain('intro');
    expect(bodyOf(res.content, 'intro')).toContain('A HUMAN wrote this.'); // preserved verbatim
  });

  test('a conflict is preserved (surfaced, not silently overwritten)', () => {
    const handEdited = PAGE.replace('Projected v1.', 'A HUMAN wrote this.');
    const res = apply(handEdited, [{ id: 'intro', body: 'Projected v2.' }, desired[1]], prior);
    expect(res.preserved).toContain('intro');
    expect(bodyOf(res.content, 'intro')).toContain('A HUMAN wrote this.'); // human wins until resolved
  });

  test('a new region is created and round-trips through the parser', () => {
    const res = apply(PAGE, [...desired, { id: 'outro', body: 'Fresh outro.', afterId: 'body' }], prior);
    expect(res.applied).toContain('outro');
    expect(bodyOf(res.content, 'outro')).toContain('Fresh outro.');
  });

  test('idempotency: applying twice is a no-op the second time', () => {
    const once = apply(PAGE, [{ id: 'intro', body: 'Projected v2.' }, desired[1]], prior);
    const twice = apply(once.content, [{ id: 'intro', body: 'Projected v2.' }, desired[1]], once.newPrior);
    expect(twice.applied).toEqual([]);
    expect(twice.content).toBe(once.content);
  });

  test('newPrior advances only for regions projection actually owns/updated', () => {
    const res = apply(PAGE, [{ id: 'intro', body: 'Projected v2.' }, desired[1]], prior);
    expect(res.newPrior['intro']).toBe(hashBody('Projected v2.'));
  });
});

describe('formatPlan — ranked report', () => {
  test('orders conflict/drift ahead of update/unchanged', () => {
    const items = plan(PAGE.replace('Projected v1.', 'HUMAN'), [{ id: 'intro', body: 'v2' }, { id: 'body', body: 'Body projected v1.' }], baseline(PAGE, [{ id: 'intro', body: 'Projected v1.' }, { id: 'body', body: 'Body projected v1.' }]));
    const out = formatPlan(items);
    expect(out.indexOf('CONFLICT')).toBeLessThan(out.indexOf('UNCHANGED'));
  });
});
