// Resolve an embedded-screen reference against the document that declares it.
//
// An `embedded-display` node's `file` is authored relative to its own screen,
// and that screen may itself be embedded: each link of the chain is relative
// to its parent. Folding the chain from the top document yields the declaring
// document's path; the ref is joined to that document's directory.
//
// Paths are in the manifest's root-relative form: `/`-separated, no leading
// slash. A ref starting with `/` is already root-relative and ignores the
// chain. Leading `..` segments that cannot be cancelled are kept, so a chain
// folded from an empty top path stays relative to the top document's
// directory (what a top-document-relative resolver expects).

/** Normalise `.`, `..` and empty segments; never returns a leading slash. */
function normalise(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Join `ref` onto the directory of `docPath`. */
function joinFrom(docPath: string, ref: string): string {
  if (ref.startsWith('/')) return normalise(ref);
  const slash = docPath.lastIndexOf('/');
  const dir = slash >= 0 ? docPath.slice(0, slash + 1) : '';
  return normalise(`${dir}${ref}`);
}

/**
 * Resolve `ref` as declared by the innermost document of an embed chain.
 *
 * @param topScreenPath path of the top document (empty/undefined: the root,
 *   giving paths relative to the top document's directory).
 * @param ancestors authored refs of every embedded screen between the top
 *   document and the declaring one, outermost first.
 * @param ref the authored reference to resolve.
 */
export function resolveAgainstChain(
  topScreenPath: string | undefined,
  ancestors: readonly string[],
  ref: string
): string {
  let doc = normalise(topScreenPath ?? '');
  for (const link of ancestors) doc = joinFrom(doc, link);
  return joinFrom(doc, ref);
}

/** A ref with a URL scheme (`https:`, `data:`, ...) or a leading `/`. */
export function isPassthroughRef(ref: string): boolean {
  return ref.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

/**
 * Rewrite an asset ref declared by an embedded document so its parent's
 * resolver can resolve it: a document-relative ref is re-expressed relative
 * to the parent document through the embed's authored link. Passthrough refs
 * are returned untouched; a root-relative link keeps the result root-relative.
 */
export function rebaseThroughEmbed(authoredRef: string, ref: string): string {
  if (isPassthroughRef(ref)) return ref;
  const rebased = resolveAgainstChain(undefined, [authoredRef], ref);
  return authoredRef.startsWith('/') ? `/${rebased}` : rebased;
}
