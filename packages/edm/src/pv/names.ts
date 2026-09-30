// EDM PV strings → (scheme, channel). EDM's PV factory picks the plugin by a
// `TYPE\` prefix (edmlib/pv_factory.cc); no prefix means EPICS (Channel
// Access). `ca://` is accepted as EPICS too.

export type EdmPvScheme = 'epics' | 'loc' | 'calc' | 'log' | 'proxy' | 'pva';

export interface EdmPvRef {
  readonly scheme: EdmPvScheme;
  /** Channel name without the prefix (macros already expanded by the caller). */
  readonly name: string;
}

const PREFIXES: [RegExp, EdmPvScheme][] = [
  [/^EPICS\\/i, 'epics'],
  [/^LOC\\/i, 'loc'],
  [/^CALC\\/i, 'calc'],
  [/^LOG\\/i, 'log'],
  [/^PROXY\\/i, 'proxy'],
  [/^ca:\/\//i, 'epics'],
  [/^pva:\/\//i, 'pva'],
];

export function parsePvName(raw: string): EdmPvRef | null {
  const s = raw.trim();
  if (!s) return null;
  for (const [re, scheme] of PREFIXES) {
    const m = re.exec(s);
    if (m) {
      const name = s.slice(m[0].length).trim();
      return name ? { scheme, name } : null;
    }
  }
  return { scheme: 'epics', name: s };
}
