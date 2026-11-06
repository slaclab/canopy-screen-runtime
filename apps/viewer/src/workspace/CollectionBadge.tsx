// CollectionBadge: the glyph that tells a personal collection from a facility
// one wherever collections are listed: the sidebar heading's icon and the
// popover row. Personal collections carry the User glyph, facility ones the
// Catalog glyph; `data-source` and the title name which. The list text beside
// it ("<name> · N · <when>") comes from collections.ts, re-exported here
// so a list renders badge and suffix from one import.

import { Catalog, User } from '@carbon/icons-react';
import type { CollectionSource } from './useCollections.js';

export { collectionSuffix, collectionSummary, formatWhen } from './collections.js';

export const BADGE_TITLE: Record<CollectionSource, string> = {
  personal: 'Personal collection',
  facility: 'Facility collection',
};

export interface CollectionBadgeProps {
  source: CollectionSource;
  size?: 16 | 20;
}

export function CollectionBadge({ source, size = 16 }: CollectionBadgeProps) {
  return (
    <span
      className={`collection-badge collection-badge--${source}`}
      data-source={source}
      title={BADGE_TITLE[source]}
    >
      {source === 'personal' ? <User size={size} /> : <Catalog size={size} />}
    </span>
  );
}
