// The kit's widgets by EDM class name. Classes not listed render a placeholder.

import { Bar } from './Bar.js';
import { Button, ExitButton, MessageButton, ShellCmd } from './Buttons.js';
import { Group } from './Group.js';
import { GifImageView, PngImage, TwoDProfileMonitor } from './Images.js';
import { Indicator } from './Indicator.js';
import { Line } from './Line.js';
import { Pip } from './Pip.js';
import { ChoiceButton, MenuButton } from './MenuChoice.js';
import { MenuMux } from './MenuMux.js';
import { Meter } from './Meter.js';
import { MotifSlider, makeMotifSlider } from './MotifSlider.js';
import {
  CoefTable,
  MessageBox,
  MultiLineTextEntry,
  MultiLineTextUpdate,
  Table,
} from './MotifText.js';
import { RadioBox } from './Radio.js';
import { RampButton, UpdownButton } from './RampUpdown.js';
import { Rectangle } from './Rectangle.js';
import { Unregistered, registerEdmWidget } from './registry.js';
import { RelatedDisplay } from './RelatedDisplay.js';
import { Arc, Byte, Circle } from './Shapes.js';
import { FreezeButton, Mmv } from './Slac.js';
import { SlacBar } from './SlacBar.js';
import { ActiveSymbol, AnaSymbol } from './Symbol.js';
import { Slider } from './Slider.js';
import { RegTextupdate, Textupdate } from './Textupdate.js';
import { XRegText, XText } from './XText.js';
import { MzXyGraph, XyGraph } from './XyGraph.js';
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
  registerEdmWidget('activeSlacBarClass', SlacBar);
  registerEdmWidget('activeFreezeButtonClass', FreezeButton);
  registerEdmWidget('mmvClass', Mmv);
  registerEdmWidget('activeSliderClass', Slider);
  registerEdmWidget('activeRampButtonClass', RampButton);
  registerEdmWidget('activeUpdownButtonClass', UpdownButton);
  registerEdmWidget('activeRadioButtonClass', RadioBox);
  registerEdmWidget('activeTriumfSliderClass', makeMotifSlider('activeTriumfSliderClass'));
  registerEdmWidget('activePngClass', PngImage);
  registerEdmWidget('cfcf6c8a_dbeb_11d2_8a97_00104b8742df', GifImageView);
  registerEdmWidget('TwoDProfileMonitorClass', TwoDProfileMonitor);
  registerEdmWidget('activeIndicatorClass', Indicator);
  registerEdmWidget('activeMeterClass', Meter);
  registerEdmWidget('activePipClass', Pip);
  registerEdmWidget('activeSymbolClass', ActiveSymbol);
  registerEdmWidget('anaSymbolClass', AnaSymbol);
  registerEdmWidget('aniSymbolClass', AnaSymbol);
  registerEdmWidget('menuMuxClass', MenuMux);
  registerEdmWidget('RegTextupdateClass', RegTextupdate);
  registerEdmWidget('activeXRegTextClass', XRegText);
  registerEdmWidget('multiLineTextUpdateClass', MultiLineTextUpdate);
  registerEdmWidget('multiLineTextEntryClass', MultiLineTextEntry);
  registerEdmWidget('activeMessageBoxClass', MessageBox);
  registerEdmWidget('activeTableClass', Table);
  registerEdmWidget('activeCoefTableClass', CoefTable);
  registerEdmWidget('xyGraphClass', XyGraph);
  registerEdmWidget('mzxyGraphClass', MzXyGraph);
  // In .edl files, but registered by no EDM library: EDM draws nothing.
  registerEdmWidget('activeVsBarClass', Unregistered);
}
