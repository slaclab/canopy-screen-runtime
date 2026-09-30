// The kit's widgets by EDM class name. Classes not listed render a placeholder.

import { Group } from './Group.js';
import { Line } from './Line.js';
import { Rectangle } from './Rectangle.js';
import { registerEdmWidget } from './registry.js';
import { RelatedDisplay } from './RelatedDisplay.js';
import { Textupdate } from './Textupdate.js';
import { XText } from './XText.js';
import { makeTextDsp } from './XTextDsp.js';

let registered = false;

export function registerEdmBuiltins(): void {
  if (registered) return;
  registered = true;
  registerEdmWidget('activeXTextClass', XText);
  registerEdmWidget('activeXTextDspClass', makeTextDsp('activeXTextDspClass'));
  registerEdmWidget('activeXTextDspClass:noedit', makeTextDsp('activeXTextDspClass:noedit'));
  registerEdmWidget('relatedDisplayClass', RelatedDisplay);
  registerEdmWidget('activeRectangleClass', Rectangle);
  registerEdmWidget('TextupdateClass', Textupdate);
  registerEdmWidget('activeLineClass', Line);
  registerEdmWidget('activeGroupClass', Group);
}
