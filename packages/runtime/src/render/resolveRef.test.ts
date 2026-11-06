// The pure ref-resolution rules: resolveAgainstChain, isPassthroughRef,
// rebaseThroughEmbed.

import { describe, expect, it } from 'vitest';
import { isPassthroughRef, rebaseThroughEmbed, resolveAgainstChain } from './resolveRef.js';

describe('resolveAgainstChain', () => {
  it('depth 1: resolves against the top document directory', () => {
    expect(resolveAgainstChain('a/b/top', [], 'embedded/child')).toBe('a/b/embedded/child');
  });

  it('depth 2: resolves against the embedding parent, not the top document', () => {
    expect(resolveAgainstChain('a/b/top', ['embedded/child'], '../details')).toBe('a/b/details');
  });

  it('folds a longer chain, each ref relative to its own parent', () => {
    expect(resolveAgainstChain('a/top', ['x/one', '../y/two', 'three'], 'leaf')).toBe('a/y/leaf');
  });

  it('a root-relative ref ignores the chain and drops the leading slash', () => {
    expect(resolveAgainstChain('a/b/top', ['embedded/child'], '/shared/./c/../d')).toBe('shared/d');
  });

  it('a root-relative ancestor resets the fold', () => {
    expect(resolveAgainstChain('a/b/top', ['/lib/child'], 'sib')).toBe('lib/sib');
  });

  it('normalises . and repeated slashes', () => {
    expect(resolveAgainstChain('a/b/top', [], './c//./d')).toBe('a/b/c/d');
  });

  it('a top document at the root, or none, resolves relative to the root', () => {
    expect(resolveAgainstChain('top', [], 'leaf.screen.json')).toBe('leaf.screen.json');
    expect(resolveAgainstChain('', [], 'leaf.screen.json')).toBe('leaf.screen.json');
    expect(resolveAgainstChain(undefined, ['sub/a'], 'b')).toBe('sub/b');
  });

  it('keeps leading .. segments it cannot cancel', () => {
    expect(resolveAgainstChain('', [], '../up')).toBe('../up');
    expect(resolveAgainstChain('a/top', [], '../../up')).toBe('../up');
  });
});

describe('isPassthroughRef', () => {
  it('passes scheme refs through', () => {
    for (const ref of [
      'http://host/img.png',
      'https://host/a/b.gif',
      'data:image/png;base64,AAAA',
      'blob:http://host/uuid',
      'file:///tmp/x.png',
      'svn+ssh://h/x',
    ])
      expect(isPassthroughRef(ref)).toBe(true);
  });

  it('passes root-relative refs through', () => {
    expect(isPassthroughRef('/images/logo.png')).toBe(true);
    expect(isPassthroughRef('//cdn/x.png')).toBe(true);
  });

  it('does not pass document-relative refs through', () => {
    for (const ref of ['logo.png', './img/a.png', '../up.png', 'img/a:b.png', '1http:x', ''])
      expect(isPassthroughRef(ref)).toBe(false);
  });
});

describe('rebaseThroughEmbed', () => {
  it('re-expresses a document-relative ref through the embed link', () => {
    expect(rebaseThroughEmbed('sub/child.screen.json', 'img/a.png')).toBe('sub/img/a.png');
    expect(rebaseThroughEmbed('../lib/g.screen.json', 'a.png')).toBe('../lib/a.png');
  });

  it('leaves scheme and root-relative refs untouched', () => {
    expect(rebaseThroughEmbed('sub/child', 'https://h/a.png')).toBe('https://h/a.png');
    expect(rebaseThroughEmbed('sub/child', '/abs/a.png')).toBe('/abs/a.png');
  });

  it('keeps the result root-relative under a root-relative link', () => {
    expect(rebaseThroughEmbed('/lib/child', 'a.png')).toBe('/lib/a.png');
  });
});

// ── Through the renderer ────────────────────────────────────────────────────
