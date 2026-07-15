import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * DRIFT GUARD (kb-projection-6ji.3 item 3 — the "extraction trigger").
 *
 * region-core.ts is a VENDORED copy of the pure core of 777westwood's region.ts.
 * The agent-CMS north star (kb-projection-6ji) says the region-addressing layer
 * gets a single source once it has 2 consumers. Rather than pay the publish/
 * versioning infra tax (the casco lesson), we keep the copy and fail-fast if it
 * DIVERGES from the source — the reconciler's own drift concept applied to its own
 * code. If a third consumer appears, promote to a real shared package.
 *
 * The pure core is the slice from `export function fileStem` up to the filesystem
 * shell marker (or EOF), so this is robust to header/line-number changes.
 */
const REGION_TS = join(homedir(), 'Projects', '777westwood', 'scripts', 'region.ts');
const REGION_CORE = join(import.meta.dir, '..', '..', 'src', 'reconcile', 'region-core.ts');

/** Extract the pure-core slice: `export function fileStem` … before the FS shell. */
function pureCore(content: string): string {
  const start = content.indexOf('export function fileStem');
  if (start < 0) return '';
  let end = content.indexOf('// ── Filesystem shell');
  if (end < 0) end = content.length;
  return content.slice(start, end).trimEnd();
}

describe('region-core drift guard (vs 777westwood/scripts/region.ts)', () => {
  test.skipIf(!existsSync(REGION_TS))(
    'vendored region-core pure core is byte-identical to the 777westwood source',
    () => {
      const source = pureCore(readFileSync(REGION_TS, 'utf8'));
      const vendored = pureCore(readFileSync(REGION_CORE, 'utf8'));
      expect(vendored.length).toBeGreaterThan(0);
      expect(vendored).toBe(source); // any divergence fails here — re-vendor to fix
    },
  );

  test('the vendored copy exists and carries the consumer-#2 extraction banner', () => {
    const core = readFileSync(REGION_CORE, 'utf8');
    expect(core).toContain('CONSUMER #2');
    expect(pureCore(core).length).toBeGreaterThan(0);
  });
});
