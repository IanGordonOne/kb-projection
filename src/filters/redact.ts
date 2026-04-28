/**
 * redact filter — generic, source-clean code filter.
 *
 * The engine ships NO site-specific patterns. Each host site supplies
 * its own `RedactRules` keyed by mode name; the engine looks up the
 * rules at apply time and runs them in order.
 *
 * Two reserved mode behaviors:
 *   - `none`           — built-in no-op (always available)
 *   - any other string — looked up in `rulesByMode`; if absent, no-op
 *                        (cli-audit-drift's `filter-redact-mode-unknown`
 *                        finding flags the absence at audit time, given
 *                        the audit knows the available modes)
 *
 * Host site wiring: `createKbLoader({ redactRulesByMode: { light: ... } })`.
 */

export type RedactMode = string;

export interface RedactRule {
  /** Pattern to match. Always a RegExp; use the `g` flag to replace all. */
  pattern: RegExp;
  /** Replacement text. */
  replacement: string;
}

export interface RedactRules {
  /**
   * Optional notice prepended to the body when this ruleset is applied.
   * Convention: a markdown blockquote that tells the reader what was
   * redacted (without re-disclosing the redacted material).
   */
  notice?: string;
  /** Patterns + replacements applied in order. */
  rules: RedactRule[];
}

export interface RedactParams {
  mode: RedactMode;
  /**
   * Host-supplied rules table. Engine has no built-in modes other
   * than `none`. If `mode` is not `none` and not in `rulesByMode`,
   * the body is returned unchanged (no-op).
   */
  rulesByMode?: Record<string, RedactRules>;
}

export function applyRedact(body: string, params: RedactParams): string {
  if (params.mode === 'none') return body;
  const ruleset = params.rulesByMode?.[params.mode];
  if (!ruleset) return body;
  let out = body;
  for (const r of ruleset.rules) {
    out = out.replace(r.pattern, r.replacement);
  }
  return ruleset.notice ? ruleset.notice + out : out;
}
