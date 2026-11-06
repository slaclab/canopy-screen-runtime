// Colour-role emission: roles become `light-dark()` values carrying the whole
// role in a trailing comment, with the scheme's values when a scheme defines
// the role and the role's fallbacks otherwise.

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import type { ColorRole, FlatScheme } from '@slaclab/canopy-screen-ir';
import { escapeRoleJSON, generateTSX } from './generateTSX.js';
import type { CodegenWidgetProps, Widget } from './model.js';
import { createDefaultScreen } from './model.js';

const scheme: FlatScheme = {
  roles: ['Test_Text', 'Test_Back'],
  light: ['#112233', '#ddeeff'],
  dark: ['#aabbcc', '#010203'],
  meta: { id: 'test', sha256: null, flatHash: 'h', served: 'test', errors: [] },
};

function widget(partial: Partial<Widget> & Pick<Widget, 'id' | 'type'>): Widget {
  return {
    layout: { x: 0, y: 0, width: 100, height: 30 },
    props: {},
    zIndex: 0,
    visible: true,
    rotation: 0,
    ...partial,
  };
}

function screenWith(props: CodegenWidgetProps) {
  const screen = createDefaultScreen();
  screen.meta.title = 'Role Screen';
  screen.widgets['w1'] = widget({ id: 'w1', type: 'PVTextDisplay', props });
  screen.rootWidgetIds = ['w1'];
  return screen;
}

/** Every role carried in a `/* role: ... *\/` comment, parsed back. */
function commentRoles(tsx: string): ColorRole[] {
  const out: ColorRole[] = [];
  const re = /\/\* role: (.*?) \*\//g;
  for (let m = re.exec(tsx); m; m = re.exec(tsx)) out.push(JSON.parse(m[1]!) as ColorRole);
  return out;
}

/** Syntactic diagnostics of the emitted file, as TSX. */
function syntaxErrors(tsx: string): string[] {
  const result = ts.transpileModule(tsx, {
    reportDiagnostics: true,
    fileName: 'Screen.tsx',
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
  });
  return (result.diagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, '\n')
  );
}

describe('generateTSX — colour roles', () => {
  it('emits the scheme values when the scheme defines the role', () => {
    const role: ColorRole = { $role: 'Test_Text', fallback: '#000000', fallbackDark: '#ffffff' };
    const tsx = generateTSX(screenWith({ foregroundColor: role }), scheme);
    expect(tsx).toContain(
      `foregroundColor={'light-dark(#112233, #aabbcc)' /* role: ${JSON.stringify(role)} */}`
    );
    expect(commentRoles(tsx)).toEqual([role]);
  });

  it('emits the fallbacks when no scheme is given', () => {
    const role: ColorRole = { $role: 'Test_Text', fallback: '#000000', fallbackDark: '#ffffff' };
    const tsx = generateTSX(screenWith({ foregroundColor: role }));
    expect(tsx).toContain("foregroundColor={'light-dark(#000000, #ffffff)' /* role: ");
  });

  it('emits the fallbacks for a role the scheme lacks', () => {
    const role: ColorRole = { $role: 'Absent_Role', fallback: '#123456', fallbackDark: '#654321' };
    const tsx = generateTSX(screenWith({ backgroundColor: role }), scheme);
    expect(tsx).toContain("backgroundColor={'light-dark(#123456, #654321)' /* role: ");
  });

  it('uses fallback for both modes when fallbackDark is missing', () => {
    const role: ColorRole = { $role: 'No_Dark', fallback: '#abcdef' };
    const withScheme = generateTSX(screenWith({ borderColor: role }), scheme);
    const without = generateTSX(screenWith({ borderColor: role }));
    expect(withScheme).toContain("'light-dark(#abcdef, #abcdef)'");
    expect(without).toContain("'light-dark(#abcdef, #abcdef)'");
    const [parsed] = commentRoles(without);
    expect(parsed).toEqual(role);
    expect('fallbackDark' in parsed!).toBe(false);
  });

  it('keeps the comment outside the string value', () => {
    const role: ColorRole = { $role: 'Test_Text', fallback: '#000000' };
    const tsx = generateTSX(screenWith({ onColor: role }), scheme);
    expect(tsx).toMatch(/onColor=\{'light-dark\(#112233, #aabbcc\)' \/\* role: \{.*\} \*\/\}/);
  });

  it('escapes a role name containing */ so it cannot close the comment', () => {
    const role: ColorRole = { $role: 'evil */ name', fallback: '#111111' };
    const tsx = generateTSX(screenWith({ foregroundColor: role, label: 'kept' }), scheme);
    expect(tsx).not.toContain('evil */');
    expect(tsx).toContain('evil *\\/ name');
    expect(commentRoles(tsx)).toEqual([role]);
    expect(tsx).toContain('label="kept"');
    expect(syntaxErrors(tsx)).toEqual([]);
  });

  it('escapes a role name containing > so it cannot end the tag', () => {
    const role: ColorRole = { $role: 'a > b />', fallback: '#222222' };
    const tsx = generateTSX(screenWith({ foregroundColor: role, label: 'after' }), scheme);
    expect(tsx).not.toContain('a > b');
    expect(tsx).toContain('a \\u003e b /\\u003e');
    expect(commentRoles(tsx)).toEqual([role]);
    expect(syntaxErrors(tsx)).toEqual([]);
  });

  it('escapeRoleJSON escapes both */ and >', () => {
    const role: ColorRole = { $role: 'x */ > y', fallback: '#000000' };
    const text = escapeRoleJSON(role);
    expect(text).not.toContain('*/');
    expect(text).not.toContain('>');
    expect(JSON.parse(text)).toEqual(role);
  });

  it('walks nested props: roles inside curves[].color', () => {
    const red: ColorRole = { $role: 'Test_Text', fallback: '#ff0000' };
    const blue: ColorRole = {
      $role: 'Curve > */ 2',
      fallback: '#0000ff',
      fallbackDark: '#8888ff',
    };
    const curves = [
      { pv: 'SR:BPM1', label: 'a {b} "c" <d>', color: red },
      { pv: 'SR:BPM2', label: 'two', color: blue, width: 2 },
      { pv: 'SR:BPM3', label: 'plain', color: '#00ff00' },
    ];
    const tsx = generateTSX(screenWith({ curves }), scheme);
    expect(tsx).toContain('"color": \'light-dark(#112233, #aabbcc)\' /* role: ');
    expect(tsx).toContain('"color": \'light-dark(#0000ff, #8888ff)\' /* role: ');
    expect(tsx).toContain('"color": "#00ff00"');
    expect(tsx).toContain('a {b} \\"c\\" \\u003cd\\u003e');
    expect(commentRoles(tsx)).toEqual([red, blue]);
    expect(syntaxErrors(tsx)).toEqual([]);
  });

  it('emits a meta.backgroundColor role in the meta block', () => {
    const role: ColorRole = { $role: 'Test_Back', fallback: '#fafafa', fallbackDark: '#161616' };
    const screen = createDefaultScreen();
    screen.meta.backgroundColor = role;
    const withScheme = generateTSX(screen, scheme);
    expect(withScheme).toContain("backgroundColor: 'light-dark(#ddeeff, #010203)' /* role: ");
    expect(generateTSX(screen)).toContain(
      "backgroundColor: 'light-dark(#fafafa, #161616)' /* role: "
    );
    expect(commentRoles(withScheme)).toEqual([role]);
  });

  it('adds a mode prop setting the color-scheme when the screen holds a role', () => {
    const role: ColorRole = { $role: 'Test_Text', fallback: '#000000' };
    const tsx = generateTSX(screenWith({ foregroundColor: role }), scheme);
    expect(tsx).toContain("mode = 'light dark'");
    expect(tsx).toContain("mode?: 'light' | 'dark' | 'light dark';");
    expect(tsx).toContain('<Screen meta={screenMeta} macros={macros} mode={mode}>');
    expect(syntaxErrors(tsx)).toEqual([]);
  });

  it('finds a role in a nested child widget', () => {
    const screen = createDefaultScreen();
    screen.widgets['g'] = widget({ id: 'g', type: 'Group', children: ['c'] });
    screen.widgets['c'] = widget({
      id: 'c',
      type: 'PVTextDisplay',
      props: { fillColor: { $role: 'Test_Back', fallback: '#000000' } },
    });
    screen.rootWidgetIds = ['g'];
    const tsx = generateTSX(screen, scheme);
    expect(tsx).toContain("fillColor={'light-dark(#ddeeff, #010203)' /* role: ");
    expect(tsx).toContain('mode={mode}');
  });

  it('leaves a role-free screen unchanged: no mode, plain strings, plain JSON', () => {
    const curves = [{ pv: 'A', color: '#00ff00' }];
    const screen = screenWith({ foregroundColor: '#ff0000', curves });
    const tsx = generateTSX(screen, scheme);
    expect(tsx).toBe(generateTSX(screen));
    expect(tsx).not.toContain('mode');
    expect(tsx).toContain('foregroundColor="#ff0000"');
    expect(tsx).toContain(`curves={${JSON.stringify(curves)}}`);
    expect(tsx).toContain("backgroundColor: '#262626',");
    expect(tsx).toContain(
      'export default function RoleScreen({ macros }: { macros?: Record<string, string> }) {'
    );
  });
});

describe('codegen model typing', () => {
  it('accepts builder-shaped props: widened colours, extras under an index signature', () => {
    // The builder passes its own props type; it must stay structurally assignable.
    interface BuilderLikeProps {
      pvName?: string;
      foregroundColor?: string | ColorRole;
      fillColor?: string | ColorRole;
      [key: string]: unknown;
    }
    const builderProps: BuilderLikeProps = { foregroundColor: { $role: 'R', fallback: '#000000' } };
    const props: CodegenWidgetProps = builderProps;
    expect(props.foregroundColor).toEqual({ $role: 'R', fallback: '#000000' });
  });
});
