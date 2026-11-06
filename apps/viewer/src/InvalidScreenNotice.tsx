// In-page notice for a loaded screen document that fails the Screen IR
// contract (validate()). The screen renders beneath it as far as the renderer
// takes the document; the notice stays while the loaded document is invalid,
// and a reload or a draft revision re-validates.

import { InlineNotification } from '@carbon/react';

export function InvalidScreenNotice({
  path,
  problems,
}: {
  /** The document's manifest path, so the reader knows which file to fix. */
  path: string;
  /** validate()'s messages, at least one. */
  problems: readonly string[];
}) {
  const [first] = problems;
  const rest = problems.length - 1;
  const fact = rest > 0 ? `${path}: ${first} and ${rest} more.` : `${path}: ${first}.`;
  return (
    <InlineNotification
      className="viewer-invalid-screen"
      data-testid="canopy-invalid-screen"
      kind="error"
      lowContrast
      hideCloseButton
      title="Invalid screen"
      subtitle={`${fact} Fix the document and reload.`}
    />
  );
}
