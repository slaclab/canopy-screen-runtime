// Types of check-chrome-literals.mjs, for its unit test.

export const REASONS: readonly string[];

export function repoKey(file: string): string;

export function gatesFontSize(file: string): boolean;

export function stripComments(text: string, options?: { lineComments?: boolean }): string;

export interface ScanResult {
  hits: { line: number; text: string }[];
  exempt: { line: number; reason: string }[];
  errors: { line: number; text: string }[];
}

export function scan(
  text: string,
  options?: { lineComments?: boolean; fontSize?: boolean }
): ScanResult;

export function parseAllow(text: string): { entries: Map<string, number>; errors: string[] };

export function run(
  argv: string[],
  options?: { allowText?: string }
): { code: number; out: string[]; err: string[] };
