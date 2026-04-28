/**
 * redact filter — code filter from the v1 registry.
 *
 * `light` mode is a verbatim port of the 777westwood `redactLight()`
 * (formerly at src/content/loaders/redact-westwood.ts; the per-host-site
 * file remains as the legacy bodyHooks supplier for back-compat). The
 * filter-driven path is the supported way forward; the legacy hook is
 * preferred-against by the loader when a `filters: [{ redact }]` entry
 * is present (cli-validate rejects entries that declare both).
 *
 * `none` is a no-op — useful for explicitly turning off redaction on a
 * page that would otherwise inherit it via a future inheritance mechanism,
 * or for documenting "we considered redacting and decided not to."
 */

export type RedactMode = 'light' | 'none';

export interface RedactParams {
  mode: RedactMode;
}

function redactLight(body: string): string {
  let out = body;
  out = out
    .replace(/\$355,000/g, '$[REDACTED]')
    .replace(/\$275,000/g, '$[REDACTED]')
    .replace(/\$145,500/g, '$[REDACTED]')
    .replace(/\$110,000/g, '$[REDACTED]')
    .replace(/\$210k/gi, '$[REDACTED]')
    .replace(/\$200k/gi, '$[REDACTED]');
  out = out.replace(/\bGoodwin(s|'s|\sfamily)?/g, 'the neighboring family');
  out = out.replace(/\bEastman\b(?! Fire| Kodak)/g, '[neighbor]');
  out = out.replace(/\((\d{3})\)\s?(\d{3})[-\s]?\d{4}/g, '($1) $2-XXXX');
  out = out.replace(/\b(\d{3})-(\d{3})-\d{4}\b/g, '$1-$2-XXXX');
  out = out.replace(
    /540 Yellow Hammer Ln[^,]*,\s*Lakeport[^,\n]*/gi,
    '[REDACTED personal address]',
  );
  out = out.replace(/\b105-321-0[2-7]\b/g, '[adjacent APN]');
  out = out.replace(/\b10504166|105-041-66\b/g, '[neighbor APN]');
  out = out.replace(/\b10532108|105-321-08\b/g, '[neighbor APN]');
  const notice =
    `> **Note:** This page has been lightly redacted before publication. ` +
    `Specific dollar figures, neighbor names, third-party personal contact ` +
    `details, and adjacent-parcel APNs are masked. The strategic and ` +
    `analytical content is preserved.\n\n`;
  return notice + out;
}

export function applyRedact(body: string, params: RedactParams): string {
  switch (params.mode) {
    case 'light':
      return redactLight(body);
    case 'none':
      return body;
    default: {
      // Exhaustiveness — surfaces in TS at compile time.
      const _exhaust: never = params.mode;
      return body;
    }
  }
}
