// A tool tile's "Save view" action, in two parts. SaveViewButton sits in the
// tool's tile bar and only asks for the dialog: the bar lives inside
// dockview's tab element, where nothing may float, so the bar keeps the
// button (and the short "Saved" status) and the page owns the rest.
// SaveViewDialog names the view, worded for that tool (tools.ts: "Save
// <label> view", its describeQuery, "listed under Tools → <label>"); the page
// renders it outside the dock, for the instance whose bar asked. The view is
// saved with the tool as its kind, under kindedViewId(name, kind): saving
// under a name that is already taken by a view of the same tool replaces that
// view, which the dialog says before the operator confirms. A server 409
// (another client put a view of another kind under that id) shows as the
// dialog's error.
//
// It is not an entry of the screen action registry (screenActions/): those
// actions work on an open screen (ScreenActionContext.screen) and render in
// the screen header, which a tool tile does not show (the tool draws its own
// header inside its frame). The button takes the same canopy-shell look
// (`canopy-btn`) as the header's buttons instead.

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Save } from '@carbon/icons-react';
import { InlineNotification, Modal, TextInput } from '@carbon/react';
import type { SavedView } from './savedViews.js';
import { VIEW_NAME_MAX, kindedViewId, viewNameProblem } from './savedViews.js';
import type { ToolSpec } from './tools.js';
import './SaveView.css';

/**
 * The status and the button as one group at the end of a bar row. In a bar too
 * narrow for both, the group shrinks and the status gives way (SaveView.css
 * ellipsizes it); the button keeps its size, so it never leaves the bar.
 */
const ACTION_ROW: CSSProperties = {
  display: 'flex',
  flex: '0 1 auto',
  minInlineSize: 0,
  alignItems: 'center',
  gap: '0.5rem',
};
const ACTION_BUTTON: CSSProperties = { flex: 'none' };

export interface SaveViewButtonProps {
  /** The instance's tool: the wording of the button's title. */
  tool: ToolSpec;
  /** The instance's current query; nothing to save while it is ''. */
  query: string;
  /** The outcome of this instance's last save, shown beside the button. */
  status?: string | null;
  /** Ask the page for the dialog; the caller knows which instance this is. */
  onOpen: () => void;
}

export function SaveViewButton({ tool, query, status = null, onOpen }: SaveViewButtonProps) {
  const disabled = query === '';
  return (
    <div className="save-view__action" style={ACTION_ROW} data-testid="save-view-action">
      <span className="save-view__status" role="status" data-testid="save-view-status">
        {status}
      </span>
      <button
        type="button"
        className="canopy-btn save-view__button"
        style={ACTION_BUTTON}
        disabled={disabled}
        title={disabled ? tool.emptyHint : `Save this ${tool.label} view`}
        onClick={onOpen}
      >
        <Save size={16} aria-hidden="true" />
        <span>Save view</span>
      </button>
    </div>
  );
}

export interface SaveViewDialogProps {
  /** The instance's tool: the view's kind and the dialog's wording. */
  tool: ToolSpec;
  /** The query being saved. */
  query: string;
  /** The existing views, to warn before replacing one. */
  views: readonly SavedView[];
  /** The name of the view the instance was opened with, else ''. */
  initialName: string;
  onCancel: () => void;
  /** Store the view; rejects with a message the dialog shows. */
  onSave: (name: string) => Promise<void>;
}

export function SaveViewDialog({
  tool,
  query,
  views,
  initialName,
  onCancel,
  onSave,
}: SaveViewDialogProps) {
  const [name, setName] = useState(initialName);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = viewNameProblem(name);
  const existing = problem ? undefined : views.find((v) => v.id === kindedViewId(name, tool.id));

  const submit = () => {
    setTouched(true);
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    onSave(name).then(
      () => setSaving(false),
      (err: unknown) => {
        setSaving(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    );
  };

  return (
    <Modal
      open
      size="xs"
      modalHeading={`Save ${tool.label} view`}
      primaryButtonText={existing ? 'Replace' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving || problem !== null}
      onRequestClose={onCancel}
      onRequestSubmit={submit}
    >
      <p className="save-view__summary">
        {tool.describeQuery(query)}, listed for everyone under Tools → {tool.label}.
      </p>
      <TextInput
        id="save-view-name"
        size="sm"
        labelText="Name"
        data-modal-primary-focus
        value={name}
        maxLength={VIEW_NAME_MAX}
        invalid={touched && problem !== null}
        invalidText={problem ?? undefined}
        warn={existing !== undefined}
        warnText={existing ? `Replaces the saved view “${existing.name}”.` : undefined}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      {error && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not saved"
          subtitle={error}
        />
      )}
    </Modal>
  );
}
