// /edl/<path>?MACRO=value — a legacy EDM screen rendered directly from its
// .edl file, by path under the display root (no manifest entry needed).
//
// Reserved query parameters (never macros): render, impl, look.

import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { queryMacros } from '../macros.js';
import { EdlView } from './EdlView.js';

export function EdlPage({ edmBaseUrl }: { edmBaseUrl: string }) {
  const path = useParams()['*'] ?? '';
  const [searchParams] = useSearchParams();
  const macros = useMemo(() => queryMacros(searchParams), [searchParams]);
  return <EdlView path={path} macros={macros} edmBaseUrl={edmBaseUrl} />;
}
