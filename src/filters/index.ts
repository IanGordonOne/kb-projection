/**
 * Filter registry — public exports for the kyber-3fh.13 (perky-tarsier)
 * manifest filter pipeline.
 *
 * v1 surface:
 *   - applyFilters / FilterContext  — orchestrator + injected context
 *   - applyRedact / RedactMode      — single v1 code filter
 *
 * Future code filters (audience adapter, TOC inject, summarize) live as
 * sibling files (one per filter) and add a switch arm in applyFilters.ts.
 * Per the plan §5 (Risks / known concerns): the registry is data-driven
 * to keep cli-validate + cli-audit-drift coverage automatic.
 */

export { applyFilters, type FilterContext } from './applyFilters';
export { applyRedact, type RedactMode, type RedactParams } from './redact';
