# @kyber/kb-projection

LogSeq → Astro knowledge-base projection engine. Powers static-site KB publishing from a LogSeq vault via a curated `kb-publish.manifest.json` and a per-host content loader.

## What's in here

| Module | Purpose |
|---|---|
| `src/lib/logseqToAstro.ts` | Pure transforms — slugify, parseProperties, transformBody, resolveLogseqPath, escapeHtml, stripLeadingPropertyBlock |
| `src/lib/loader.ts` | `createKbLoader()` factory — Astro Content Layer loader for KB-publishing sites |
| `src/filters/` | Per-entry manifest filter pipeline (kyber-3fh.13 perky-tarsier): prepend/append KB anchors + redact code filter |
| `src/manifest/` | Schema, validator, audit-drift, patch + apply-patch, preview, propose-placement, logseq-meta |
| `bin/` | CLI shims: `kb-validate`, `kb-audit-drift`, `kb-preview`, `kb-propose-placement` |
| `legacy/` | Pre-loader materialized projection path (deprecated; will be removed in v0.2.0) |

## Install

### Development (local)

```bash
# In your host site:
bun add @kyber/kb-projection@file:/path/to/kb-projection
```

### Production (versioned)

```bash
bun add github:IanGordonOne/kb-projection#v0.1.0
```

## Usage

### Astro content loader

```ts
// src/content/loaders/kb.ts (in your host site)
import { createKbLoader } from '@kyber/kb-projection/loader';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';

export function kbLoader(opts?: {
  manifestPath?: string;
  hydrationCacheDir?: string;
}) {
  return createKbLoader({
    ...opts,
    bodyHooks: { /* site-specific redaction hooks */ },
    createProcessor: () => createMarkdownProcessor(),
  });
}
```

### CLIs

```bash
# Validate a manifest:
bunx --bun ~/Projects/kb-projection/bin/kb-validate.ts <manifest.json>

# Detect drift between manifest and LogSeq vault:
bunx --bun ~/Projects/kb-projection/bin/kb-audit-drift.ts <manifest.json>

# Preview a patch before applying:
bunx --bun ~/Projects/kb-projection/bin/kb-preview.ts <manifest.json> <patch.json>

# Propose section placement for candidate pages:
bunx --bun ~/Projects/kb-projection/bin/kb-propose-placement.ts <manifest.json> --graph <graph-path>
```

## Testing

```bash
bun install
bun test
bun run typecheck
```

7 test files, ~1,660 lines of tests; all using `bun:test`. Note: tests will not run under `node` (use `bun`).

## Reference consumer

`777westwood` (private repo) — the original consumer; demonstrates `createKbLoader` integration, host-supplied redact rules via `redactRulesByMode`, manifest curation, and the per-entry filter pipeline. Public consumers welcome; if you adopt this engine for your own KB site, file an issue and I'll link it here.

## History

Extracted from `~/.claude/USER/skills/_KNOWLEDGE/_KNOWLEDGE_PROJECT/Tools/` (PAI USER skill tree) on 2026-04-28. Track migration in `Plans/please-plan-c-sparkling-tower.md` of the 777westwood repo.

## License

MIT — see [LICENSE](./LICENSE).
