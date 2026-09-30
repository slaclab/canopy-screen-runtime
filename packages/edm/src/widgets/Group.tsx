// activeGroupClass: its members in file order, at their own (absolute)
// coordinates. The group's visPv/visMin/visMax/visInvert show or hide all of
// them (EDM edmlib/group.cc). Hidden members stay mounted: EDM activates
// every object whatever its visibility, so their PVs are connected and they
// reappear at once when the group's visibility PV changes.

import type { EdmWidgetProps } from './registry.js';
import { EdmObjectView } from './registry.js';
import { useVisibility } from './shared.js';

export function Group({ obj }: EdmWidgetProps) {
  const visible = useVisibility(obj.props, 'activeGroupClass');
  return (
    // display: contents keeps the members positioned against the screen root.
    <div data-edm-class="activeGroupClass" style={{ display: visible ? 'contents' : 'none' }}>
      {(obj.children ?? []).map((c, i) => (
        <EdmObjectView key={i} obj={c} />
      ))}
    </div>
  );
}
