// The kit's widgets by EDM class name. Classes not listed render a placeholder.

import { Bar } from './Bar.js';
import { Button, ExitButton, MessageButton, ShellCmd } from './Buttons.js';
import { Group } from './Group.js';
import { Line } from './Line.js';
import { ChoiceButton, MenuButton } from './MenuChoice.js';
import { MotifSlider } from './MotifSlider.js';
import { Rectangle } from './Rectangle.js';
import { registerEdmWidget } from './registry.js';
import { RelatedDisplay } from './RelatedDisplay.js';
import { Arc, Byte, Circle } from './Shapes.js';
import { Textupdate } from './Textupdate.js';
import { XText } from './XText.js';
import { Textentry, makeTextDsp } from './XTextDsp.js';

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
  registerEdmWidget('activeMessageButtonClass', MessageButton);
  registerEdmWidget('activeButtonClass', Button);
  registerEdmWidget('ByteClass', Byte);
  registerEdmWidget('activeCircleClass', Circle);
  registerEdmWidget('activeMenuButtonClass', MenuButton);
  registerEdmWidget('shellCmdClass', ShellCmd);
  registerEdmWidget('activeChoiceButtonClass', ChoiceButton);
  registerEdmWidget('activeExitButtonClass', ExitButton);
  registerEdmWidget('activeArcClass', Arc);
  registerEdmWidget('activeMotifSliderClass', MotifSlider);
  registerEdmWidget('activeBarClass', Bar);
  registerEdmWidget('TextentryClass', Textentry);
}
