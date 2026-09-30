// activeGroupClass: its members in file order, at their own (absolute)
// coordinates. The group's visPv/visMin/visMax/visInvert show or hide all of
// them (EDM edmlib/group.cc).

import type { EdmWidgetProps } from './registry.js';
import { EdmObjectView } from './registry.js';
import { useVisibility } from './shared.js';

export function Group({ obj }: EdmWidgetProps) {
  const visible = useVisibility(obj.props, 'activeGroupClass');
  if (!visible) return null;
  return (
    <>
      {(obj.children ?? []).map((c, i) => (
        <EdmObjectView key={i} obj={c} />
      ))}
    </>
  );
}
