import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  copyReferencedAssets,
  extractReferencedAssets,
} from '../../src/lib/logseqToAstro';

describe('extractReferencedAssets', () => {
  test('extracts basenames from supported local assets image embeds', () => {
    const body = [
      '![one](../assets/x.jpg)',
      '![two](./assets/y.png)',
      '![three](assets/z.webp)',
      '![four](../../assets/nested.gif)',
    ].join('\n');

    expect(extractReferencedAssets(body)).toEqual([
      'x.jpg',
      'y.png',
      'z.webp',
      'nested.gif',
    ]);
  });

  test('deduplicates repeated references across lines', () => {
    const body = [
      '![one](../assets/x.jpg)',
      '![two](../../assets/x.jpg)',
      '![three](assets/x.jpg)',
    ].join('\n');

    expect(extractReferencedAssets(body)).toEqual(['x.jpg']);
  });

  test('ignores absolute and remote asset references', () => {
    const body = [
      '![one](/assets/x.jpg)',
      '![two](https://example.com/assets/y.jpg)',
      '![three](http://example.com/assets/z.jpg)',
    ].join('\n');

    expect(extractReferencedAssets(body)).toEqual([]);
  });

  test('ignores non-embed sidecar mentions', () => {
    const body =
      'Sidecar: `assets/wom-01-uplink.jpg.md`\n' +
      'Also text ../assets/wom-01-uplink.jpg without image syntax\n';

    expect(extractReferencedAssets(body)).toEqual([]);
  });

  test('returns empty when the body has no image embeds', () => {
    expect(extractReferencedAssets('just prose\nand [[wikilinks]]')).toEqual([]);
  });
});

describe('copyReferencedAssets', () => {
  test('copies only embedded local assets and records missing ones', () => {
    const graphDir = mkdtempSync(join(tmpdir(), 'kb-projection-graph-'));
    const targetDir = mkdtempSync(join(tmpdir(), 'kb-projection-target-'));
    const targetPublicAssetsDir = join(targetDir, 'public', 'assets', 'kb');
    const assetDir = join(graphDir, 'assets');
    const originalWarn = console.warn;
    const warnings: string[] = [];

    try {
      mkdirSync(assetDir, { recursive: true });
      writeFileSync(join(assetDir, 'x.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

      const pageBodies = [
        '![alt](../assets/x.jpg)',
        '![alt](../assets/missing.jpg)',
        'Sidecar: `assets/x.jpg.md`\nPlain text ../assets/x.jpg without image syntax\n',
      ];

      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };

      let result:
        | ReturnType<typeof copyReferencedAssets>
        | undefined;
      expect(() => {
        result = copyReferencedAssets({
          graphDir,
          pageBodies,
          targetPublicAssetsDir,
        });
      }).not.toThrow();

      expect(result).toEqual({
        copied: ['x.jpg'],
        missing: ['missing.jpg'],
      });
      expect(existsSync(join(targetPublicAssetsDir, 'x.jpg'))).toBe(true);
      expect(existsSync(join(targetPublicAssetsDir, 'x.jpg.md'))).toBe(false);
      expect(
        warnings.some((warning) =>
          warning.includes(join(graphDir, 'assets', 'missing.jpg')),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
      rmSync(graphDir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
