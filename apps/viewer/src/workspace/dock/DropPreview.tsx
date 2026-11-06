// The drop preview: paints the drop placeholder (a rounded, accent-stroked box inset 4 px
// from the zone) on the zone the current target lands in, keyed by the target's kind —
//
//   split  an edge of a tile: the half of the hovered tile the item lands in;
//   tab    the centre or a tab gap: the whole hovered tile, with the insertion marker in the bar;
//   strip  a dock-edge strip (an outer target): the whole new full-span strip the item lands in.
//
// The caller (the drop bridge) runs hitTest -> resultRect on every dragover and passes the
// target and the zone in; a refused drop or a self-drop has no result and paints nothing.
// One rect element stays mounted while the pointer moves between zones, so dock.css can
// glide it from one zone to the next.
// The preview clears itself on drop, dragend, a drag leaving `dockRoot` and Escape, reports
// that through `onClear`, and stays clear until the next result object arrives.
//
// Placement: render it inside the same positioned parent as the dock, after <DockOverlay>,
// so DOM order paints it above the tiles without a z-index. Rects are in that parent's
// coordinate space, i.e. the dockRect origin the bridge handed to resultRect. Geometry is
// inline top/left/width/height only; everything else, pointer-events: none included, lives
// in dock.css. dockview's own drop overlay is suppressed by the bridge, not here.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Target, ResultRect } from '@slaclab/canopy-dock-engine';
import './dock.css';

export const DROP_PREVIEW_CLASS = 'canopy-dock-drop-preview';
export const DROP_PREVIEW_RECT_CLASS = 'canopy-dock-drop-preview__rect';
export const DROP_PREVIEW_MARKER_CLASS = 'canopy-dock-drop-preview__marker';
export const DROP_PREVIEW_PLACEHOLDER_CLASS = 'canopy-dock-drop-preview__placeholder';

export type DropPreviewKind = 'split' | 'tab' | 'strip';

/** The highlight style for a drop on `target` (border targets have no pointer zone). */
export function previewKind(target: Target): DropPreviewKind | null {
  if ('zone' in target) return 'tab';
  if ('edge' in target) return 'split';
  if ('outer' in target) return 'strip';
  return null;
}

export interface DropPreviewProps {
  /** The target under the pointer, or null with none. */
  target: Target | null;
  /** resultRect for that target; null for a refused or self-drop, which paints nothing. */
  result: ResultRect | null;
  /** The dock root: a drag leaving it clears the preview. */
  dockRoot?: HTMLElement | null;
  /** Called once each time a painted preview is cleared by a drag-ending event. */
  onClear?: () => void;
}

/** True when a dragleave from inside `root` goes somewhere outside it. */
function leavesRoot(root: HTMLElement, event: DragEvent): boolean {
  const to = event.relatedTarget;
  if (to instanceof Node) return !root.contains(to);
  // Some engines report no related target on dragleave: judge by the pointer instead.
  const box = root.getBoundingClientRect();
  const { clientX: x, clientY: y } = event;
  return x < box.left || x >= box.right || y < box.top || y >= box.bottom;
}

const px = (n: number) => `${n}px`;

export function DropPreview({ target, result, dockRoot = null, onClear }: DropPreviewProps) {
  // The result that was showing when a drag-ending event cleared it; the preview stays
  // clear while the caller still passes that same object.
  const [cleared, setCleared] = useState<ResultRect | null>(null);
  const painted = target !== null && result !== null && result !== cleared ? result : null;

  // The document listeners read the latest render through refs, synced after each commit.
  const paintedRef = useRef(painted);
  const onClearRef = useRef(onClear);
  useLayoutEffect(() => {
    paintedRef.current = painted;
    onClearRef.current = onClear;
  });

  useEffect(() => {
    const clear = () => {
      const showing = paintedRef.current;
      if (showing === null) return;
      paintedRef.current = null;
      setCleared(showing);
      onClearRef.current?.();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
    };
    const onLeave = (event: DragEvent) => {
      if (dockRoot !== null && leavesRoot(dockRoot, event)) clear();
    };
    // Capture phase: a drop handler that stops propagation still clears the preview.
    document.addEventListener('drop', clear, true);
    document.addEventListener('dragend', clear, true);
    document.addEventListener('keydown', onKey, true);
    dockRoot?.addEventListener('dragleave', onLeave, true);
    return () => {
      document.removeEventListener('drop', clear, true);
      document.removeEventListener('dragend', clear, true);
      document.removeEventListener('keydown', onKey, true);
      dockRoot?.removeEventListener('dragleave', onLeave, true);
    };
  }, [dockRoot]);

  const kind = target === null ? null : previewKind(target);
  const { rect, marker } = painted ?? { rect: null, marker: null };
  return (
    <div className={DROP_PREVIEW_CLASS} aria-hidden="true">
      {rect !== null && kind !== null && (
        <div
          className={`${DROP_PREVIEW_RECT_CLASS} ${DROP_PREVIEW_RECT_CLASS}--${kind}`}
          data-kind={kind}
          style={{
            top: px(rect.y),
            left: px(rect.x),
            width: px(rect.width),
            height: px(rect.height),
          }}
        >
          <div className={DROP_PREVIEW_PLACEHOLDER_CLASS} />
        </div>
      )}
      {kind === 'tab' && marker !== null && (
        <div
          className={DROP_PREVIEW_MARKER_CLASS}
          style={{ top: px(marker.y), left: px(marker.x), height: px(marker.height) }}
        />
      )}
    </div>
  );
}
