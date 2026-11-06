// "Save open tabs as collection…": the dialog that writes exactly the
// strip as a personal collection. It is opened from the ☰ window menu
// (dock/WindowMenu) and the collections popover's footer, and the page renders it outside
// the dock (like SaveViewDialog), handing it the tabs state, the collection
// list in GET order, the saved views, the tool config's default query and
// each tab's displayed title.
//
// The members are the strip tabs in strip order (stripMembers), built again
// when the operator submits so they are what the strip holds at that moment:
//   screen tab   {screen: '<category>/<id>', macros?} from its tab key
//   tool tab     {tool, query?, name?} with
//     query      the instance's query, else the tool config's default; absent
//                only when both are blank. A cleared query ('') over a
//                non-blank default is kept, so reopening does not bring the
//                default back.
//     name       the `from` member's name (first collection member in GET
//                order whose key equals `from`) > the loaded view's name >
//                the displayed tab title unless it is generic ("Data Browser",
//                "Correlation 3", …), then absent.
// A later tab whose member key repeats an earlier one is dropped; the dialog
// lists the dropped ones.
//
// "Include layout" writes the dock's layout (state.layout) in collection
// form (dock/layout.ts collectionOfDock): each tile's tabs as the indexes of
// their members, its showing tab, sizes as weights, no tile ids and no
// `from`. A one-tile dock saves a one-tile layout. A tab dropped as a
// duplicate leaves the layout with its tab, so every member is placed once.
//
// The name is new (useCollections.save mints the id from a fresh list, so a
// duplicate name costs one PUT) or an existing personal collection is picked
// to be replaced; replacing is confirmed as in SaveView: the primary button
// reads "Replace" and the field warns. The personal rows are snapshotted once
// when the dialog opens ({id, name, rev, updated, memberCount}); the
// Replace dropdown reads "<name> · N · <when>" from that snapshot and a
// replace sends the snapshot row's rev, so a row changed or deleted meanwhile
// is refused (412 stale / gone) rather than overwritten. A refused write keeps
// the dialog open: it takes a fresh snapshot and offers Save as new / Cancel.
// On success the page shows "Saved “<name>”", ticks the collection and puts
// focus on the Collections trigger (finishSave, focusCollectionsTrigger).

import { useMemo, useState } from 'react';
import { Checkbox, InlineNotification, Modal, Select, SelectItem, TextInput } from '@carbon/react';
import { collectionSummary, memberKey, memberLabel } from './collections.js';
import type {
  CollectionListed,
  Member,
  MemberKey,
  ScreenMember,
  ToolMember,
} from './collections.js';
import { collectionOfDock } from './dock/collectionLayout.js';
import type { CollectionLayout, Layout } from '@slaclab/canopy-dock-engine';
import type { SavedView } from './savedViews.js';
import { VIEW_NAME_MAX, viewNameProblem } from './savedViews.js';
import { parseTabKey } from './tabs.js';
import type { TabsState } from './tabs.js';
import { instanceLabel } from './tools.js';
import type { Collection, CollectionDraft, WriteConflict, WriteResult } from './useCollections.js';
import './SaveCollection.css';

export { SAVE_AS_COLLECTION } from './dock/WindowMenu.js';
export const NO_TABS = 'There are no open tabs to save.';
/** The primary button after a refused write: save the strip as a new collection. */
export const SAVE_AS_NEW = 'Save as new';
/** The Collections popover's trigger, where focus lands after a save. */
export const COLLECTIONS_TRIGGER = '[data-testid="collections-popover-trigger"]';
const NEW_COLLECTION = '';

/** What memberOfTab asks the page: the tool config and the displayed titles. */
export interface MemberResolvers {
  /** The tool config's default query for `tool` (toolConfig(config, tool)?.query). */
  toolQuery?: (tool: string) => string | undefined;
  /** The tab's displayed title (the strip's text). */
  titleOf?: (key: string) => string | undefined;
}

export interface StripMembers {
  /** One member per kept tab, in strip order. */
  members: Member[];
  /** The tab key each member was taken from, aligned with `members`. */
  tabKeys: string[];
  /** The labels of the tabs dropped as later duplicates, in strip order. */
  dropped: string[];
}

/** The name of the first member in GET order whose key is `key`, else undefined. */
function nameOf(collections: readonly Collection[], key: MemberKey): string | undefined {
  for (const collection of collections) {
    for (const member of collection.members) {
      let k: MemberKey;
      try {
        k = memberKey(member);
      } catch {
        continue;
      }
      if (k === key) return member.name;
    }
  }
  return undefined;
}

/** True for a tool's generic title: its label, or its label plus an instance number. */
export function isGenericTitle(title: string, tool: string): boolean {
  const label = instanceLabel(`@${tool}`);
  if (title === label) return true;
  if (!title.startsWith(`${label} `)) return false;
  return /^[1-9]\d*$/.test(title.slice(label.length + 1));
}

const blank = (s: string | null | undefined): boolean => s === null || s === undefined || s === '';

/** The member a tab key holds, null for a key that names neither. */
function memberOfTab(
  state: TabsState,
  key: string,
  collections: readonly Collection[],
  views: readonly SavedView[],
  resolvers: MemberResolvers
): Member | null {
  const parsed = parseTabKey(key);
  if (!parsed) return null;
  if (parsed.kind === 'screen') {
    const member: ScreenMember = { screen: `${parsed.category}/${parsed.id}` };
    if (Object.keys(parsed.macros).length > 0) member.macros = { ...parsed.macros };
    return member;
  }
  const instance = state.instances[key];
  const member: ToolMember = { tool: parsed.tool };
  // The live query, else the config default; absent only when both are blank.
  const fallback = resolvers.toolQuery?.(parsed.tool);
  const query = instance?.query ?? fallback ?? null;
  if (!(blank(query) && blank(fallback))) member.query = query ?? '';
  // The name: `from` name > view name > displayed title unless generic.
  let name = instance?.from !== undefined ? nameOf(collections, instance.from) : undefined;
  if (name === undefined && instance?.view) {
    name = views.find((v) => v.id === instance.view)?.name;
  }
  if (name === undefined) {
    const title = resolvers.titleOf?.(key)?.trim();
    if (title && !isGenericTitle(title, parsed.tool)) name = title;
  }
  if (name !== undefined) member.name = name;
  return member;
}

/** The strip's tabs as members, later duplicates by key dropped and listed. */
export function stripMembers(
  state: TabsState,
  collections: readonly Collection[],
  views: readonly SavedView[],
  resolvers: MemberResolvers = {}
): StripMembers {
  const out: StripMembers = { members: [], tabKeys: [], dropped: [] };
  const seen = new Set<MemberKey>();
  for (const key of state.keys) {
    const member = memberOfTab(state, key, collections, views, resolvers);
    if (!member) continue;
    let k: MemberKey;
    try {
      k = memberKey(member);
    } catch {
      continue;
    }
    if (seen.has(k)) {
      out.dropped.push(memberLabel(member));
      continue;
    }
    seen.add(k);
    out.members.push(member);
    out.tabKeys.push(key);
  }
  return out;
}

export interface DraftLayout {
  members: Member[];
  /** The dock's layout over the members' indexes; absent for an empty dock. */
  layout?: CollectionLayout<number>;
}

/** The draft's members and the dock's layout in collection form over them. */
export function draftLayout(strip: StripMembers, layout: Layout | null): DraftLayout {
  const indexOf = new Map(strip.tabKeys.map((key, i) => [key, i]));
  const members = strip.members.map((m) => ({ ...m }));
  const laid = layout === null ? null : collectionOfDock(layout, (key) => indexOf.get(key));
  return laid === null ? { members } : { members, layout: laid };
}

/** A personal collection as the dialog saw it when it opened. */
export interface PersonalRow {
  id: string;
  name: string;
  rev?: string;
  updated?: string;
  memberCount: number;
}

/** The personal rows of `collections`, in GET order. */
export function personalRows(collections: readonly Collection[]): PersonalRow[] {
  return collections
    .filter((c) => c.source === 'personal')
    .map((c) => {
      const row: PersonalRow = { id: c.id, name: c.name, memberCount: c.members.length };
      if (c.rev !== undefined) row.rev = c.rev;
      if (c.updated !== undefined) row.updated = c.updated;
      return row;
    });
}

/** A personal row as the list text reads it. */
function listedRow(row: PersonalRow): CollectionListed {
  return {
    id: row.id,
    name: row.name,
    members: Array.from({ length: row.memberCount }),
    ...(row.updated !== undefined ? { updated: row.updated } : {}),
  };
}

/**
 * The Replace dropdown's row text, "<name> · N · <when>"; given the rows
 * shown beside it, a row that reads the same as another gains " · <id>".
 */
export function rowSummary(row: PersonalRow, now?: Date, rows?: readonly PersonalRow[]): string {
  return collectionSummary(listedRow(row), now, rows?.map(listedRow));
}

/** What a refused write tells the operator, before "Save as new or cancel." */
export function conflictText(reason: WriteConflict, target: string | undefined): string {
  const named = target === undefined ? 'The collection' : `“${target}”`;
  switch (reason) {
    case 'stale':
      return `${named} changed on another console.`;
    case 'gone':
      return `${named} was deleted on another console.`;
    case 'exists':
      return 'Another console saved a collection with that id at the same time.';
    case 'precondition_required':
      return `${named} could not be replaced safely.`;
  }
}

export interface FinishSaveDeps {
  /** The page's toast store's show. */
  show: (spec: { message: string }) => unknown;
  /** CollectionsApi.tick. */
  tick: (ref: string) => Promise<void>;
  /** Close the dialog. */
  close: () => void;
}

/**
 * After a save, "Saved “<name>”", the collection ticked and the dialog
 * closed (the page then focuses the Collections trigger); a refused write
 * leaves the dialog open. Returns the result for the dialog.
 */
export function finishSave(result: WriteResult, name: string, deps: FinishSaveDeps): WriteResult {
  if (!result.ok) return result;
  deps.show({ message: `Saved “${result.collection?.name ?? name.trim()}”` });
  deps.tick(result.ref).catch((err: unknown) => {
    console.warn('Collections: could not tick the saved collection', err);
  });
  deps.close();
  return result;
}

/** Focus the Collections trigger, when one is on the page; true when focused. */
export function focusCollectionsTrigger(root: ParentNode = document): boolean {
  const trigger = root.querySelector<HTMLElement>(COLLECTIONS_TRIGGER);
  if (!trigger) return false;
  trigger.focus();
  return true;
}

export interface SaveCollectionDialogProps {
  /** The tabs state: the strip (keys), the layout and the instances. */
  state: TabsState;
  /** Every collection, in GET order: member names, and the personal ones to replace. */
  collections: readonly Collection[];
  /** The saved views, for the name of a view-loaded instance. */
  views: readonly SavedView[];
  /** The tool config's default query. */
  toolQuery?: MemberResolvers['toolQuery'];
  /** The tabs' displayed titles. */
  titleOf?: MemberResolvers['titleOf'];
  onCancel: () => void;
  /**
   * CollectionsApi.save (replace = the snapshot row's id, rev = its rev): a
   * refused write resolves {ok: false}; an unexpected failure rejects with a
   * message the dialog shows.
   */
  onSave: (draft: CollectionDraft, replace?: string, rev?: string) => Promise<WriteResult>;
}

interface Conflict {
  reason: WriteConflict;
  target: string | undefined;
}

export function SaveCollectionDialog({
  state,
  collections,
  views,
  toolQuery,
  titleOf,
  onCancel,
  onSave,
}: SaveCollectionDialogProps) {
  const [name, setName] = useState('');
  const [replaceId, setReplaceId] = useState(NEW_COLLECTION);
  const [includeLayout, setIncludeLayout] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  // The personal rows once, when the dialog opens. After a refusal the
  // hook refetches the list, and the rows follow it while the refusal shows;
  // leaving the refusal keeps what was shown last as the new snapshot.
  const [opened, setOpened] = useState<PersonalRow[]>(() => personalRows(collections));
  const rows = useMemo(
    () => (conflict ? personalRows(collections) : opened),
    [conflict, collections, opened]
  );
  const settle = () => {
    if (!conflict) return;
    setOpened(rows);
    setConflict(null);
  };

  const resolvers = { toolQuery, titleOf };
  const strip = useMemo(
    () => stripMembers(state, collections, views, { toolQuery, titleOf }),
    [state, collections, views, toolQuery, titleOf]
  );
  const canLayout = state.layout !== null;
  const replacing = conflict ? undefined : rows.find((r) => r.id === replaceId);
  const problem = viewNameProblem(name);
  const empty = strip.members.length === 0;

  const submit = () => {
    setTouched(true);
    if (problem || saving || empty) return;
    // Built now, from what the strip holds at the moment of the save.
    const now = stripMembers(state, collections, views, resolvers);
    const draft: CollectionDraft = {
      name: name.trim(),
      members: now.members.map((m) => ({ ...m })),
    };
    if (includeLayout) {
      const laid = draftLayout(now, state.layout);
      draft.members = laid.members;
      if (laid.layout) draft.layout = laid.layout;
    }
    const target = replacing;
    setSaving(true);
    setError(null);
    settle();
    onSave(draft, target?.id, target?.id === undefined ? undefined : target.rev).then(
      (result) => {
        setSaving(false);
        if (result && !result.ok) {
          setConflict({ reason: result.reason, target: target?.name });
          setReplaceId(NEW_COLLECTION);
        }
      },
      (err: unknown) => {
        setSaving(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    );
  };

  const count = strip.members.length;
  return (
    <Modal
      open
      size="xs"
      modalHeading="Save open tabs as collection"
      primaryButtonText={conflict ? SAVE_AS_NEW : replacing ? 'Replace' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving || problem !== null || empty}
      onRequestClose={onCancel}
      onRequestSubmit={submit}
    >
      <p className="save-collection__summary" data-testid="save-collection-summary">
        {empty
          ? NO_TABS
          : `${count} ${count === 1 ? 'member' : 'members'}, the open tabs in strip order.`}
      </p>
      {strip.dropped.length > 0 && (
        <div className="save-collection__dropped" data-testid="save-collection-dropped">
          <p>Left out as duplicates of an earlier tab:</p>
          <ul>
            {strip.dropped.map((label, i) => (
              <li key={`${i}:${label}`}>{label}</li>
            ))}
          </ul>
        </div>
      )}
      {rows.length > 0 && (
        <Select
          id="save-collection-target"
          size="sm"
          labelText="Save as"
          value={replaceId}
          onChange={(e) => {
            const id = e.target.value;
            setReplaceId(id);
            settle();
            const picked = rows.find((r) => r.id === id);
            if (picked) setName(picked.name);
          }}
        >
          <SelectItem value={NEW_COLLECTION} text="A new collection" />
          {rows.map((r) => {
            const text = rowSummary(r, undefined, rows);
            return <SelectItem key={r.id} value={r.id} text={text} title={text} />;
          })}
        </Select>
      )}
      <TextInput
        id="save-collection-name"
        size="sm"
        labelText="Name"
        data-modal-primary-focus
        value={name}
        maxLength={VIEW_NAME_MAX}
        invalid={touched && problem !== null}
        invalidText={problem ?? undefined}
        warn={replacing !== undefined}
        warnText={
          replacing
            ? `Replaces the collection “${replacing.name}” with exactly the open tabs.`
            : undefined
        }
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      {canLayout && (
        <div className="save-collection__layout">
          <Checkbox
            id="save-collection-layout"
            labelText="Include layout"
            checked={includeLayout}
            onChange={(_e, { checked }) => setIncludeLayout(checked)}
          />
        </div>
      )}
      {conflict && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Not saved"
          subtitle={`${conflictText(conflict.reason, conflict.target)} Save as new or cancel.`}
          data-testid="save-collection-conflict"
        />
      )}
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
