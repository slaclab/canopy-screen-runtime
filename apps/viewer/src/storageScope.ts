// Browser-storage keys. Every sessionStorage and localStorage key the viewer
// reads or writes is built here.
//
// Both storages are origin-scoped, not path-scoped. A host that serves the
// viewer to several users on one origin, each under their own path, would
// otherwise give all of them one shared slot per key: whoever wrote last
// decides what the next user opens with. So a key carries:
//
//   * the mount: the router basename (document.baseURI's path, `/` at the
//     origin root), so two mounts never share a record;
//   * the host scope, when the embedding host stamps one on `<html>` as
//     `data-canopy-storage-scope="<scope>"`, appended as `--<scope>`, so two
//     users of one mount never share a record either.
//
// A scoped page never falls back to the unscoped key: that slot is precisely
// the shared one the scope exists to escape.

/** The attribute an embedding host stamps on `<html>` to scope storage per user. */
export const STORAGE_SCOPE_ATTRIBUTE = 'data-canopy-storage-scope';

/** The router basename of this document (`/` at the root, or outside a browser). */
function currentBasename(): string {
  try {
    return new URL(document.baseURI).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '/';
  }
}

/** The host's per-user storage scope; null when none is stamped (or it is empty). */
export function storageScope(): string | null {
  try {
    const root = document.documentElement;
    const scope = root.getAttribute(STORAGE_SCOPE_ATTRIBUTE);
    return scope || null;
  } catch {
    return null;
  }
}

/**
 * The storage key of record `name` under a router basename (`/`, `/x/y` or
 * `/x/y/`; default: this document's): `<name>:<mount>`, plus `--<scope>`
 * when the host scopes the page.
 */
export function storageKey(name: string, basename: string = currentBasename()): string {
  const base = `${name}:${basename.replace(/\/+$/, '') || '/'}`;
  const scope = storageScope();
  return scope ? `${base}--${scope}` : base;
}
