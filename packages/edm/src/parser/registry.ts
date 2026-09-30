// File-parser registry: extension → parser producing the EDM object
// description. `.edl` is built in; other formats (a Phoebus .bob mapping, a
// dumped PyDM tree) can register without touching the loader.

import type { EdmDocument } from '../model.js';
import { parseEdl } from './edl.js';

export type EdmFileParser = (text: string, path: string) => EdmDocument;

const parsers = new Map<string, EdmFileParser>([['.edl', (text) => parseEdl(text)]]);

export function registerFileParser(extension: string, parser: EdmFileParser): void {
  parsers.set(
    extension.toLowerCase().startsWith('.')
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`,
    parser
  );
}

export function getFileParser(path: string): EdmFileParser | undefined {
  const m = /(\.[^./]+)$/.exec(path.toLowerCase());
  return m ? parsers.get(m[1]) : undefined;
}
