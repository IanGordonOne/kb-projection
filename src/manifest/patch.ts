/**
 * Manifest patch DSL — pure transform.
 *
 * A ManifestPatch is an ordered list of operations (add/remove/set/unset)
 * each carrying a mandatory `rationale` string. Rationale capture happens
 * at moment-of-decision per the kyber-3fh.6 design notes — agents must
 * record WHY they're proposing each operation, and apply-patch surfaces
 * those rationales to the bd-memory layer.
 *
 * applyPatch is pure (no I/O): takes a current manifest + a patch,
 * returns the resulting manifest plus any operation-level errors. The
 * caller (CLI / preview) then runs validate.ts over the output to
 * confirm the patched manifest still satisfies schema + ref-integrity.
 *
 * Order is preserved so the manifest's diff stays readable. Inserts
 * land at the end; removes preserve the relative order of survivors.
 */

import type { PublishEntry, PublishManifest } from './schema';

export type PatchOpKind = 'add' | 'remove' | 'set' | 'unset';

export interface PatchOpAdd {
  op: 'add';
  entry: PublishEntry & Record<string, unknown>;
  rationale: string;
}

export interface PatchOpRemove {
  op: 'remove';
  title: string;
  rationale: string;
}

export interface PatchOpSet {
  op: 'set';
  title: string;
  field: string;
  value: unknown;
  rationale: string;
}

export interface PatchOpUnset {
  op: 'unset';
  title: string;
  field: string;
  rationale: string;
}

export type PatchOp = PatchOpAdd | PatchOpRemove | PatchOpSet | PatchOpUnset;

export interface ManifestPatch {
  manifestPath?: string;
  operations: PatchOp[];
}

export interface PatchApplyError {
  opIndex: number;
  message: string;
}

export interface PatchApplyResult {
  manifest: PublishManifest;
  errors: PatchApplyError[];
  /** Per-op summary of what changed. Index-aligned with patch.operations. */
  changes: PatchChange[];
}

export interface PatchChange {
  opIndex: number;
  op: PatchOpKind;
  title: string;
  before: PublishEntry | null;
  after: PublishEntry | null;
  rationale: string;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function findEntryIndex(entries: PublishEntry[], title: string): number {
  return entries.findIndex((e) => e.title === title);
}

function ensureRationale(op: PatchOp, opIndex: number): PatchApplyError | null {
  if (typeof op.rationale !== 'string' || op.rationale.trim().length === 0) {
    return { opIndex, message: `op ${op.op} requires non-empty rationale` };
  }
  return null;
}

/**
 * Apply a patch to a manifest. Pure: takes a manifest + patch, returns
 * the resulting manifest + any operation-level errors. Failed operations
 * are skipped (but recorded); subsequent operations apply against the
 * accumulated state. Caller should validate the output via validate.ts
 * before persisting.
 */
export function applyPatch(
  manifest: PublishManifest,
  patch: ManifestPatch
): PatchApplyResult {
  const out: PublishManifest = {
    ...manifest,
    entries: manifest.entries.map((e) => deepClone(e)),
  };
  const errors: PatchApplyError[] = [];
  const changes: PatchChange[] = [];

  for (let i = 0; i < patch.operations.length; i++) {
    const op = patch.operations[i];
    const ratErr = ensureRationale(op, i);
    if (ratErr) {
      errors.push(ratErr);
      continue;
    }

    if (op.op === 'add') {
      if (!op.entry || typeof op.entry.title !== 'string' || op.entry.title.length === 0) {
        errors.push({ opIndex: i, message: `op add[${i}] entry.title is required` });
        continue;
      }
      if (findEntryIndex(out.entries, op.entry.title) !== -1) {
        errors.push({
          opIndex: i,
          message: `op add[${i}]: title "${op.entry.title}" already in manifest`,
        });
        continue;
      }
      const entry = deepClone(op.entry);
      out.entries.push(entry as PublishEntry);
      changes.push({
        opIndex: i,
        op: 'add',
        title: entry.title,
        before: null,
        after: entry as PublishEntry,
        rationale: op.rationale,
      });
      continue;
    }

    if (op.op === 'remove') {
      const idx = findEntryIndex(out.entries, op.title);
      if (idx === -1) {
        errors.push({
          opIndex: i,
          message: `op remove[${i}]: title "${op.title}" not in manifest`,
        });
        continue;
      }
      const before = deepClone(out.entries[idx]);
      out.entries.splice(idx, 1);
      changes.push({
        opIndex: i,
        op: 'remove',
        title: op.title,
        before,
        after: null,
        rationale: op.rationale,
      });
      continue;
    }

    if (op.op === 'set') {
      if (typeof op.field !== 'string' || op.field.length === 0) {
        errors.push({ opIndex: i, message: `op set[${i}]: field is required` });
        continue;
      }
      if (op.field === 'title') {
        errors.push({
          opIndex: i,
          message: `op set[${i}]: refusing to rename via 'set'; use remove + add`,
        });
        continue;
      }
      const idx = findEntryIndex(out.entries, op.title);
      if (idx === -1) {
        errors.push({
          opIndex: i,
          message: `op set[${i}]: title "${op.title}" not in manifest`,
        });
        continue;
      }
      const before = deepClone(out.entries[idx]);
      const next = deepClone(out.entries[idx]) as PublishEntry & Record<string, unknown>;
      next[op.field] = op.value as unknown as never;
      out.entries[idx] = next as PublishEntry;
      changes.push({
        opIndex: i,
        op: 'set',
        title: op.title,
        before,
        after: next as PublishEntry,
        rationale: op.rationale,
      });
      continue;
    }

    if (op.op === 'unset') {
      if (typeof op.field !== 'string' || op.field.length === 0) {
        errors.push({ opIndex: i, message: `op unset[${i}]: field is required` });
        continue;
      }
      if (op.field === 'title' || op.field === 'tier') {
        errors.push({
          opIndex: i,
          message: `op unset[${i}]: cannot unset required field "${op.field}"`,
        });
        continue;
      }
      const idx = findEntryIndex(out.entries, op.title);
      if (idx === -1) {
        errors.push({
          opIndex: i,
          message: `op unset[${i}]: title "${op.title}" not in manifest`,
        });
        continue;
      }
      const before = deepClone(out.entries[idx]);
      const next = deepClone(out.entries[idx]) as PublishEntry & Record<string, unknown>;
      delete next[op.field];
      out.entries[idx] = next as PublishEntry;
      changes.push({
        opIndex: i,
        op: 'unset',
        title: op.title,
        before,
        after: next as PublishEntry,
        rationale: op.rationale,
      });
      continue;
    }

    errors.push({
      opIndex: i,
      message: `unknown op kind: ${(op as { op: string }).op}`,
    });
  }

  return { manifest: out, errors, changes };
}

/**
 * Compute the set of entries "affected" by a patch — the directly-changed
 * entries plus any other entries whose backlinks reference a changed
 * entry's title (changes there are visible in the published page's
 * backlinks frontmatter).
 *
 * Returned in the order they appear in the post-patch manifest, with
 * directly-changed entries first.
 */
export function affectedEntries(
  postPatch: PublishManifest,
  changes: PatchChange[]
): PublishEntry[] {
  const directTitles = new Set(changes.map((c) => c.title));
  const directs: PublishEntry[] = [];
  const indirect: PublishEntry[] = [];

  for (const e of postPatch.entries) {
    if (directTitles.has(e.title)) {
      directs.push(e);
      continue;
    }
    const hasTouchedBacklink = (e.backlinks ?? []).some((b) => directTitles.has(b));
    if (hasTouchedBacklink) {
      indirect.push(e);
    }
  }

  return [...directs, ...indirect];
}
