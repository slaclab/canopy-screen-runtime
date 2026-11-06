// Save view in two parts. SaveViewButton is what a tool's tile bar holds: the
// button (canopy-shell's `canopy-btn` look, SaveView.css keeping only the icon
// fill of its old recipe) and a status text, and nothing that floats: a click
// only asks its caller for the dialog. SaveViewDialog is rendered by the page,
// outside the dock: its name field is a small Carbon input, it warns before
// replacing a view of the same tool and shows a failed save as its error.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaveViewButton, SaveViewDialog } from './SaveView.js';
import type { SavedView } from './savedViews.js';
import type { ToolSpec } from './tools.js';

// Read from disk: vitest blanks `.css` imports, `?raw` included.
const css = readFileSync(createRequire(import.meta.url).resolve('./SaveView.css'), 'utf8');
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The selectors of every rule in the stylesheet. */
const selectors = bare
  .split('}')
  .map((rule) => rule.split('{')[0].trim())
  .filter((selector) => selector !== '');

const tool: ToolSpec = {
  id: 'trace',
  label: 'Data Browser',
  treeLabel: 'Data Browser',
  isValidQuery: (query: unknown): query is string => typeof query === 'string',
  describeQuery: (query) => `A view of ${query}`,
  emptyHint: 'Add a PV first',
};

function renderButton(query: string, status: string | null = null) {
  const onOpen = vi.fn();
  const { container } = render(
    <SaveViewButton tool={tool} query={query} status={status} onOpen={onOpen} />
  );
  return { button: screen.getByRole('button', { name: 'Save view' }), onOpen, container };
}

function renderDialog(
  options: {
    views?: SavedView[];
    initialName?: string;
    onSave?: (name: string) => Promise<void>;
  } = {}
) {
  const onSave = vi.fn(options.onSave ?? (async () => {}));
  const onCancel = vi.fn();
  render(
    <SaveViewDialog
      tool={tool}
      query="pv=A"
      views={options.views ?? []}
      initialName={options.initialName ?? ''}
      onCancel={onCancel}
      onSave={onSave}
    />
  );
  return { onSave, onCancel, input: document.getElementById('save-view-name') as HTMLInputElement };
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SaveViewButton', () => {
  it('carries canopy-btn beside save-view__button', () => {
    const { button } = renderButton('pv=A');
    expect(button.classList.contains('canopy-btn')).toBe(true);
    expect(button.classList.contains('save-view__button')).toBe(true);
    expect(button.title).toBe('Save this Data Browser view');
  });

  it('keeps both classes while there is nothing to save', () => {
    const { button, onOpen } = renderButton('');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.title).toBe('Add a PV first');
    expect(button.classList.contains('canopy-btn')).toBe(true);
    expect(button.classList.contains('save-view__button')).toBe(true);
    fireEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('asks for the dialog on a click and renders none itself', () => {
    const { button, onOpen, container } = renderButton('pv=A');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Nothing floats out of the bar: no dialog, no modal, no tooltip.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.cds--modal')).toBeNull();
    expect(document.getElementById('save-view-name')).toBeNull();
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('shows the status it is given, and none by default', () => {
    renderButton('pv=A', 'Saved “RF”');
    expect(screen.getByTestId('save-view-status').textContent).toBe('Saved “RF”');
    cleanup();
    renderButton('pv=A');
    expect(screen.getByTestId('save-view-status').textContent).toBe('');
  });
});

describe('SaveViewDialog', () => {
  it('names the view in a small text input', () => {
    const { input } = renderDialog();
    expect(input).not.toBeNull();
    expect(input.classList.contains('cds--text-input--sm')).toBe(true);
  });

  it('keeps the dialog at its xs width', () => {
    renderDialog();
    expect(document.querySelector('.cds--modal-container--xs')).not.toBeNull();
  });

  it('is worded for its tool and starts from the name it is given', () => {
    const { input } = renderDialog({ initialName: 'RF forward' });
    expect(screen.getByText('Save Data Browser view')).toBeTruthy();
    expect(
      screen.getByText('A view of pv=A, listed for everyone under Tools → Data Browser.')
    ).toBeTruthy();
    expect(input.value).toBe('RF forward');
  });

  it('saves under the typed name', async () => {
    const { input, onSave } = renderDialog();
    fireEvent.change(input, { target: { value: 'RF forward' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('RF forward'));
  });

  it('warns before replacing a view of the same tool', () => {
    const { input } = renderDialog({
      views: [{ id: 'gun-vacuum', name: 'Gun vacuum', kind: 'trace', query: 'pv=G' }],
    });
    fireEvent.change(input, { target: { value: 'gun VACUUM' } });
    expect(screen.getByText('Replaces the saved view “Gun vacuum”.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
  });

  it('shows a failed save as its error and stays open', async () => {
    const { input, onCancel } = renderDialog({
      onSave: async () => {
        throw new Error('view is of another kind');
      },
    });
    fireEvent.change(input, { target: { value: 'Taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('view is of another kind')).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels without saving', () => {
    const { onSave, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('SaveView.css', () => {
  it('declares no .save-view__button rule but the icon fill', () => {
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors.filter((selector) => selector.includes('.save-view__button'))).toEqual([
      '.save-view__button svg',
    ]);
    expect(bare).toMatch(/\.save-view__button svg\s*\{\s*fill:\s*currentColor;?\s*\}/);
  });

  it('takes its colours from contract variables', () => {
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bare).not.toMatch(/--cds-/);
    expect(bare).toMatch(/var\(--canopy-/);
  });
});
