import {
  DragDropContext,
  type BeforeCapture,
  type DraggableProvided,
  type DropResult,
  type DroppableProvided,
} from '@hello-pangea/dnd';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';

import { PlaylistVariablesCommitContext, usePlaylistVariablesCommit } from './PlaylistItemVariables';
import { PlaylistTable } from './PlaylistTable';
import { PlaylistTableRows } from './PlaylistTableRows';
import { type PlaylistItemUI } from './types';

type LoadedDashboard = NonNullable<PlaylistItemUI['dashboards']>[number];

interface DragDropContextStubProps {
  children: ReactNode;
}

interface DroppableStubProps {
  children: (provided: DroppableProvided) => ReactNode;
}

interface DraggableStubProps {
  draggableId: string;
  children: (provided: DraggableProvided) => ReactNode;
}

// `PlaylistTable` keeps `onDragEnd` internal rather than exposing it as a prop, so a reorder is
// invoked deterministically by reading that handler back off the props the stubbed `DragDropContext`
// recorded, without driving the library's sensor lifecycle or the layout measurements it needs. All
// three exports are stubbed together because `Draggable` throws outside a real `DragDropContext`.
jest.mock('@hello-pangea/dnd', () => {
  const contextId = 'playlist-table-test';

  const droppableProvided: DroppableProvided = {
    innerRef: () => {},
    placeholder: null,
    droppableProps: {
      'data-rfd-droppable-context-id': contextId,
      'data-rfd-droppable-id': 'playlist-list',
    },
  };

  const draggableProvided = (draggableId: string): DraggableProvided => ({
    innerRef: () => {},
    draggableProps: {
      'data-rfd-draggable-context-id': contextId,
      'data-rfd-draggable-id': draggableId,
    },
    // Mirrors the attributes the real library puts on a drag handle, so a stubbed row keeps the
    // roles and accessible names it has in production and the role queries below stay truthful.
    dragHandleProps: {
      'data-rfd-drag-handle-context-id': contextId,
      'data-rfd-drag-handle-draggable-id': draggableId,
      'aria-describedby': `${contextId}-drag-handle-instructions`,
      role: 'button',
      tabIndex: 0,
      draggable: false,
      onDragStart: () => {},
    },
  });

  return {
    DragDropContext: jest.fn(({ children }: DragDropContextStubProps) => children),
    Droppable: jest.fn(({ children }: DroppableStubProps) => children(droppableProvided)),
    Draggable: jest.fn(({ children, draggableId }: DraggableStubProps) => children(draggableProvided(draggableId))),
  };
});

function loadedDashboard(uid: string, name: string): LoadedDashboard {
  return {
    kind: 'dashboard',
    name,
    uid,
    url: `/d/${uid}`,
    panel_type: '',
    tags: [],
    location: 'General',
    ds_uid: [],
    score: 0,
    explain: {},
  };
}

/**
 * The duplicate UID is deliberate: rows are addressed by position, so this is the arrangement in
 * which an editor left open across a move or a deletion would re-attach to the other item. The tag
 * row and the deprecated `dashboard_by_id` row are the negative case for the UID-only variables
 * gate, and every row carries `dashboards` because a row without it renders a spinner, not its name.
 */
function playlistItems(): PlaylistItemUI[] {
  return [
    {
      type: 'dashboard_by_uid',
      value: 'uid_1',
      variables: { host: ['Host1'] },
      dashboards: [loadedDashboard('uid_1', 'Host dashboard')],
    },
    {
      type: 'dashboard_by_uid',
      value: 'uid_1',
      variables: { cluster: ['eu-west'] },
      dashboards: [loadedDashboard('uid_1', 'Host dashboard')],
    },
    { type: 'dashboard_by_tag', value: 'graph-ng', dashboards: [loadedDashboard('uid_2', 'Tagged dashboard')] },
    { type: 'dashboard_by_id', value: '3', dashboards: [loadedDashboard('uid_3', 'Legacy dashboard')] },
  ];
}

/** Three rows that are told apart by their accessible names, which duplicate UIDs are not. */
function distinctItems(): PlaylistItemUI[] {
  return [
    { type: 'dashboard_by_uid', value: 'uid_1', dashboards: [loadedDashboard('uid_1', 'First dashboard')] },
    { type: 'dashboard_by_uid', value: 'uid_2', dashboards: [loadedDashboard('uid_2', 'Second dashboard')] },
    { type: 'dashboard_by_tag', value: 'graph-ng', dashboards: [loadedDashboard('uid_3', 'Tagged dashboard')] },
  ];
}

function setup(jsx: JSX.Element) {
  return {
    user: userEvent.setup(),
    ...render(jsx),
  };
}

/**
 * The commit scope the playlist form provides in production. It is part of every fixture here
 * because the table reaches through it before it collapses or removes a row: text typed into an
 * open editor and not yet added exists nowhere else, and it has to be committed while the rows are
 * still the rows it was typed into.
 */
function WithCommitScope({ children }: { children: ReactNode }) {
  const { commitScope } = usePlaylistVariablesCommit();
  return (
    <PlaylistVariablesCommitContext.Provider value={commitScope}>{children}</PlaylistVariablesCommitContext.Provider>
  );
}

/**
 * The spies stand in for the playlist form, which owns the item list: the rows therefore stay
 * exactly as they are after a move or a deletion, which is what makes the collapse observable.
 */
function renderTable(items: PlaylistItemUI[] = playlistItems()) {
  const deleteItem = jest.fn();
  const moveItem = jest.fn();
  const onVariablesChange = jest.fn();

  return {
    deleteItem,
    moveItem,
    onVariablesChange,
    ...setup(
      <WithCommitScope>
        <PlaylistTable
          items={items}
          deleteItem={deleteItem}
          moveItem={moveItem}
          onVariablesChange={onVariablesChange}
        />
      </WithCommitScope>
    ),
  };
}

interface StatefulTableProps {
  initialItems: PlaylistItemUI[];
  deleteItem: (index: number) => void;
  moveItem: (src: number, dst: number) => void;
}

/**
 * A table whose item list is real state, standing in for the playlist form. A deletion therefore
 * removes the row for real, which is the only arrangement in which the control focus is moved to
 * afterwards is a *surviving* one, and in which a move re-renders the rows in their new order.
 */
function StatefulTable({ initialItems, deleteItem, moveItem }: StatefulTableProps) {
  const [items, setItems] = useState(initialItems);

  return (
    <WithCommitScope>
      <PlaylistTable
        items={items}
        deleteItem={(index) => {
          deleteItem(index);
          setItems((previous) => previous.filter((_, i) => i !== index));
        }}
        moveItem={(src, dst) => {
          moveItem(src, dst);
          setItems((previous) => {
            const next = Array.from(previous);
            const [moved] = next.splice(src, 1);
            next.splice(dst, 0, moved);
            return next;
          });
        }}
        onVariablesChange={(index, variables) =>
          setItems((previous) =>
            previous.map((item, i) => {
              if (i !== index) {
                return item;
              }
              const { variables: replaced, ...rest } = item;
              return variables && Object.keys(variables).length > 0 ? { ...rest, variables } : rest;
            })
          )
        }
      />
    </WithCommitScope>
  );
}

function renderStatefulTable(items: PlaylistItemUI[] = playlistItems()) {
  const deleteItem = jest.fn();
  const moveItem = jest.fn();

  return {
    deleteItem,
    moveItem,
    ...setup(<StatefulTable initialItems={items} deleteItem={deleteItem} moveItem={moveItem} />),
  };
}

/**
 * The item list, which is a `list` of `listitem` rows.
 *
 * Queried by role and name rather than by test id because the structure is the assertion: a row
 * may own its controls and, while it is expanded, its variables editor, which is what a `listitem`
 * in a `list` permits and what a `row` in no table permits at all.
 */
function itemList() {
  return screen.getByRole('list', { name: 'Playlist items' });
}

function rows() {
  return within(itemList()).getAllByRole('listitem');
}

/**
 * The accessible name of each row, in row order.
 *
 * The name is carried by the `listitem` itself — the row owns it, and there is no cell to hold it
 * — so it is read off the same elements `rows()` returns rather than off any descendant.
 */
function rowNames() {
  return rows().map((row) => row.getAttribute('aria-label'));
}

function disclosureButtons() {
  return screen.getAllByRole('button', { name: 'Template variables' });
}

function deleteButtons() {
  return screen.getAllByRole('button', { name: /delete playlist item/i });
}

function disclosureStates() {
  return disclosureButtons().map((button) => button.getAttribute('aria-expanded'));
}

function disclosureControls() {
  return disclosureButtons().map((button) => button.getAttribute('aria-controls'));
}

function variablesPanels() {
  return screen.queryAllByRole('region');
}

/**
 * The panels of the two rows holding `uid_1`, matched by name.
 *
 * The name of a panel carries its row's position as well as the dashboard, so the two rows of one
 * dashboard are matched by a pattern here and asserted to be distinct where that is the point.
 */
function uidVariablesPanels() {
  return screen.getAllByRole('region', { name: /^Template variables for uid_1, item [1-4]$/ });
}

function variablesPanelNames() {
  return variablesPanels().map((panel) => panel.getAttribute('aria-label'));
}

/**
 * The open editor of the row whose disclosure is at `index`, found through the id that disclosure
 * reports it controls. Two rows holding the same dashboard label their panels identically, so the
 * `aria-controls` link is the only thing that ties a panel to the row it belongs to.
 */
function editorFor(index: number): HTMLElement {
  const disclosure = disclosureButtons()[index];
  const controlledId = disclosure.getAttribute('aria-controls');
  const panel = variablesPanels().find((candidate) => candidate.id === controlledId);
  if (!panel) {
    throw new Error(`The disclosure at position ${index} controls no rendered panel`);
  }
  return panel;
}

/**
 * Opens the editor of both `dashboard_by_uid` rows and proves both are genuinely open. Collapsing is
 * only observable from an expanded row, and only an expanded set holding more than one row tells a
 * full clear apart from an implementation that drops the first row's entry alone.
 */
async function expandBothUidRows(user: UserEvent) {
  await user.click(disclosureButtons()[0]);
  await user.click(disclosureButtons()[1]);

  expect(disclosureStates()).toEqual(['true', 'true']);
  expect(variablesPanels()).toHaveLength(2);
}

function dropResult(sourceIndex: number, destinationIndex: number | null): DropResult {
  return {
    draggableId: `${sourceIndex}`,
    type: 'DEFAULT',
    mode: 'FLUID',
    reason: 'DROP',
    source: { droppableId: 'playlist-list', index: sourceIndex },
    destination: destinationIndex === null ? null : { droppableId: 'playlist-list', index: destinationIndex },
    combine: null,
  };
}

async function endDrag(result: DropResult) {
  const { calls } = jest.mocked(DragDropContext).mock;
  const props = calls[calls.length - 1]?.[0];
  if (!props) {
    throw new Error('DragDropContext was never rendered, so no onDragEnd handler was recorded');
  }

  // The handler reaches React from outside its event system, so its state update needs `act`.
  await act(async () => {
    props.onDragEnd(result, { announce: () => {} });
  });
}

/**
 * Fires the responder the library calls at the moment an item is lifted, before it measures the
 * element it is about to drag. The real library flushes this responder synchronously for exactly
 * that reason, so whatever it changes is in the DOM by the time it returns.
 */
async function beginDrag(before: BeforeCapture) {
  const { calls } = jest.mocked(DragDropContext).mock;
  const onBeforeCapture = calls[calls.length - 1]?.[0].onBeforeCapture;
  if (!onBeforeCapture) {
    throw new Error('DragDropContext was rendered without an onBeforeCapture handler');
  }

  await act(async () => {
    onBeforeCapture(before);
  });
}

function rowWrappers() {
  return Array.from(document.querySelectorAll('[data-playlist-item-index]'));
}

/** The draggable id the library would record for each row, in row order. */
function draggableIds() {
  return rowWrappers().map((wrapper) => wrapper.getAttribute('data-rfd-draggable-id'));
}

function activeElementName() {
  const active = document.activeElement;
  if (!active || active === document.body) {
    return 'document.body';
  }
  return active.getAttribute('aria-label') ?? active.textContent ?? active.tagName;
}

function confirmDialog() {
  return screen.queryByRole('dialog', { name: 'Delete playlist item' });
}

/** Every character that reorders the text around it, one per formatting class Unicode defines. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

describe('PlaylistTable', () => {
  beforeEach(() => {
    // The stubbed `DragDropContext` records every render, so the recorded props must not leak from
    // one case into the next. Only the calls are cleared — resetting the mocks would strip the stub
    // implementations this file depends on.
    jest.clearAllMocks();
  });

  it('offers a variable editor on the two dashboard_by_uid rows and on neither the tag nor the id row', async () => {
    const { user } = renderTable();

    expect(rows()).toHaveLength(4);
    expect(screen.getByRole('listitem', { name: 'Playlist item, dashboard_by_tag, graph-ng' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Playlist item, dashboard_by_id, 3' })).toBeInTheDocument();
    expect(disclosureButtons()).toHaveLength(2);
    expect(variablesPanels()).toHaveLength(0);

    await expandBothUidRows(user);

    expect(uidVariablesPanels()).toHaveLength(2);
    expect(screen.queryByRole('region', { name: /^Template variables for graph-ng/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Template variables for 3/ })).not.toBeInTheDocument();
  });

  /**
   * The rows are a list, and every row is one item of it.
   *
   * `role="row"` is what this markup used to carry, and it was invalid in two ways at once: a row
   * has to be owned by a table, grid, treegrid or rowgroup, and none of those is here or belongs
   * here, and a row may own nothing but cells, while these rows own a disclosure, a delete button,
   * a drag handle and — while a row is expanded — a whole variables editor.
   */
  it('renders the items as a named list of list items and as no kind of table', () => {
    renderTable();

    expect(itemList()).toBeInTheDocument();
    expect(rows()).toHaveLength(4);
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryAllByRole('cell')).toHaveLength(0);
    expect(screen.queryAllByRole('table')).toHaveLength(0);
    expect(screen.queryAllByRole('grid')).toHaveLength(0);
  });

  it('carries no list role while the playlist is empty, where the empty-state text is all there is', () => {
    renderTable([]);

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText('Playlist is empty. Add dashboards below.')).toBeInTheDocument();
  });

  /**
   * The arrangement this feature exists for: one dashboard listed several times, each entry
   * pinned to a different host. Nothing but the variables tells those entries apart, so the row's
   * text, the row's accessible name, the panel's name and the names of the controls inside the
   * panel all have to say which entry they belong to.
   */
  it('distinguishes two entries of one dashboard by their variables and their position', async () => {
    const { user } = renderTable([
      {
        type: 'dashboard_by_uid',
        value: 'uid_1',
        variables: { host: ['Host1'] },
        dashboards: [loadedDashboard('uid_1', 'Host dashboard')],
      },
      {
        type: 'dashboard_by_uid',
        value: 'uid_1',
        variables: { host: ['Host2'] },
        dashboards: [loadedDashboard('uid_1', 'Host dashboard')],
      },
    ]);

    expect(rowNames()).toEqual([
      'Playlist item, dashboard_by_uid, uid_1, host=Host1',
      'Playlist item, dashboard_by_uid, uid_1, host=Host2',
    ]);
    expect(rows()[0]).toHaveTextContent('· host=Host1');
    expect(rows()[1]).toHaveTextContent('· host=Host2');
    expect(rows()[0]).not.toHaveTextContent('Host2');
    expect(rows()[1]).not.toHaveTextContent('Host1');

    await expandBothUidRows(user);

    expect(variablesPanelNames()).toEqual([
      'Template variables for uid_1, item 1',
      'Template variables for uid_1, item 2',
    ]);
    expect(
      screen
        .getAllByRole('textbox', { name: /^Variable name for host, item [12]$/ })
        .map((input) => input.getAttribute('aria-label'))
    ).toEqual(['Variable name for host, item 1', 'Variable name for host, item 2']);
    expect(
      screen
        .getAllByRole('textbox', { name: /^Values for host, item [12]$/ })
        .map((input) => input.getAttribute('aria-label'))
    ).toEqual(['Values for host, item 1', 'Values for host, item 2']);
  });

  it('summarizes the first variables of a row and elides the rest', () => {
    renderTable([
      {
        type: 'dashboard_by_uid',
        value: 'uid_1',
        variables: { host: ['web-01', 'web-02'], region: ['eu'], zone: ['z1'] },
        dashboards: [loadedDashboard('uid_1', 'Host dashboard')],
      },
      { type: 'dashboard_by_uid', value: 'uid_2', dashboards: [loadedDashboard('uid_2', 'Plain dashboard')] },
      { type: 'dashboard_by_tag', value: 'graph-ng', dashboards: [loadedDashboard('uid_3', 'Tagged dashboard')] },
    ]);

    expect(rowNames()).toEqual([
      'Playlist item, dashboard_by_uid, uid_1, host=web-01, web-02; region=eu…',
      'Playlist item, dashboard_by_uid, uid_2',
      'Playlist item, dashboard_by_tag, graph-ng',
    ]);
    expect(screen.getByText('3 variables')).toBeInTheDocument();
    expect(rows()[0]).toHaveTextContent('· host=web-01, web-02; region=eu…');
    // A row with no variables and a tag row, which cannot carry any, keep the text and the name
    // they have always had: no count, no summary, nothing appended.
    expect(rows()[1]).toHaveTextContent('Plain dashboard');
    expect(rows()[1]).not.toHaveTextContent('variable');
    expect(rows()[2]).not.toHaveTextContent('variable');
  });

  /**
   * A row's summary and its accessible name are built out of stored variable text, and a
   * bidirectional override in that text reorders the display of everything the same string puts
   * after it — the `name=` it belongs to, the next pair, the row's own name. A row that reads as
   * holding `LTR` while the item holds `RTL` describes the wrong item, so those characters are
   * dropped from the description; isolating the summary is what keeps text that resolves to a
   * direction of its own from reordering the dashboard name beside it.
   */
  it('describes a value holding a bidirectional override in the order the item stores it', () => {
    renderTable([
      {
        type: 'dashboard_by_uid',
        value: 'uid_1',
        variables: { host: ['\u202eRTL\u202c', 'plain'] },
        dashboards: [loadedDashboard('uid_1', 'Host dashboard')],
      },
    ]);

    expect(rowNames()).toEqual(['Playlist item, dashboard_by_uid, uid_1, host=RTL, plain']);
    expect(rows()[0]).toHaveTextContent('· host=RTL, plain');
    expect(rows()[0].textContent).not.toMatch(BIDI_CONTROLS);
    expect(rows()[0].getAttribute('aria-label')).not.toMatch(BIDI_CONTROLS);
    expect(window.getComputedStyle(screen.getByText('1 variable')).unicodeBidi).toBe('isolate');
  });

  it('counts the variables of an item whose names and values are nothing but invisible controls', () => {
    renderTable([
      {
        type: 'dashboard_by_uid',
        value: 'uid_1',
        variables: { '\u202e': ['\u202c'] },
        dashboards: [loadedDashboard('uid_1', 'Host dashboard')],
      },
    ]);

    // Nothing renderable is left to preview, and the item still holds the variable: the count comes
    // from the stored map, and the row's name falls back to the one a row without variables has.
    expect(screen.getByText('1 variable')).toBeInTheDocument();
    expect(rowNames()).toEqual(['Playlist item, dashboard_by_uid, uid_1']);
    expect(rows()[0].textContent).not.toMatch(BIDI_CONTROLS);
  });

  it('closes an open variable editor when its own disclosure is clicked a second time', async () => {
    const { user } = renderTable();

    await user.click(disclosureButtons()[0]);

    expect(await screen.findByRole('textbox', { name: 'Variable name for host, item 1' })).toBeInTheDocument();
    expect(disclosureStates()).toEqual(['true', 'false']);
    expect(variablesPanels()).toHaveLength(1);

    await user.click(disclosureButtons()[0]);

    expect(disclosureStates()).toEqual(['false', 'false']);
    expect(screen.queryByRole('region', { name: 'Template variables for uid_1, item 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Variable name for host, item 1' })).not.toBeInTheDocument();
  });

  it('points every open disclosure at the id of its own variables panel', async () => {
    const { user } = renderTable();

    await user.click(disclosureButtons()[0]);

    const [firstPanelId] = disclosureControls();
    expect(firstPanelId).toEqual(expect.stringMatching(/\S/));
    expect(uidVariablesPanels().map((panel) => panel.getAttribute('id'))).toEqual([firstPanelId]);

    await user.click(disclosureButtons()[1]);

    const panelIds = disclosureControls();
    expect(panelIds[0]).not.toEqual(panelIds[1]);
    expect(uidVariablesPanels().map((panel) => panel.getAttribute('id'))).toEqual(panelIds);
  });

  /**
   * A disclosure names the panel it controls in both of its states, which is what makes it a
   * disclosure rather than a button that happens to toggle something: the relationship is what
   * assistive technology follows from the control to the content, and a collapsed row would
   * otherwise offer no way to reach it.
   *
   * The panel it names is in the document either way — `hidden` while the row is collapsed, so it
   * is out of the accessibility tree, out of the tab sequence and out of layout exactly as an
   * absent panel would be, which is why the role queries below still see none. What the attribute
   * must never do is name an id that resolves to nothing, and this is why it does not.
   */
  it('names its own variables panel from a collapsed disclosure as well as an expanded one', async () => {
    const { user } = renderTable();

    expect(disclosureStates()).toEqual(['false', 'false']);
    const [firstPanelId, secondPanelId] = disclosureControls();
    expect(firstPanelId).toEqual(expect.stringMatching(/\S/));
    expect(secondPanelId).toEqual(expect.stringMatching(/\S/));
    expect(firstPanelId).not.toEqual(secondPanelId);
    for (const [index, panelId] of [firstPanelId, secondPanelId].entries()) {
      const panel = document.getElementById(panelId ?? '');
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute('hidden');
      // The panel each disclosure names is the one inside its own row, which is the whole point of
      // the reference on two rows holding the same dashboard.
      expect(rows()[index].contains(panel)).toBe(true);
    }
    expect(variablesPanels()).toHaveLength(0);

    await user.click(disclosureButtons()[0]);

    expect(disclosureStates()).toEqual(['true', 'false']);
    expect(disclosureControls()).toEqual([firstPanelId, secondPanelId]);
    expect(uidVariablesPanels().map((panel) => panel.getAttribute('id'))).toEqual([firstPanelId]);
    expect(document.getElementById(firstPanelId ?? '')).not.toHaveAttribute('hidden');
    expect(document.getElementById(secondPanelId ?? '')).toHaveAttribute('hidden');

    await user.click(disclosureButtons()[0]);

    expect(disclosureStates()).toEqual(['false', 'false']);
    expect(disclosureControls()).toEqual([firstPanelId, secondPanelId]);
    expect(variablesPanels()).toHaveLength(0);
    expect(document.getElementById(firstPanelId ?? '')).toHaveAttribute('hidden');
  });

  it('moves the item and collapses both open variable editors when a drag ends on a new position', async () => {
    const { user, moveItem } = renderTable();
    await expandBothUidRows(user);

    await endDrag(dropResult(0, 1));

    expect(moveItem).toHaveBeenCalledWith(0, 1);
    expect(moveItem).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(disclosureStates()).toEqual(['false', 'false']);
    });
    expect(variablesPanels()).toHaveLength(0);
  });

  it('deletes the clicked tag row and collapses both variable editors open on other rows', async () => {
    const { user, deleteItem } = renderTable();
    await expandBothUidRows(user);

    // The tag row never had an editor of its own, so collapsing after its deletion is what shows
    // the collapse is unconditional rather than a side effect of removing the deleted row's entry.
    await user.click(deleteButtons()[2]);

    expect(deleteItem).toHaveBeenCalledWith(2);
    expect(deleteItem).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(disclosureStates()).toEqual(['false', 'false']);
    });
    expect(variablesPanels()).toHaveLength(0);
  });

  /**
   * Text typed into an open editor and never added exists nowhere but that editor, and every
   * structural change here takes the editor away. It is therefore committed first — while the row
   * it was typed into is still at the position it was typed at, which is what the recorded call
   * order proves. Settling afterwards would hand it to whichever item had taken that position.
   */
  it('adds a variable typed into an open editor to its own row before a deletion collapses the editors', async () => {
    const { user, deleteItem, onVariablesChange } = renderTable();

    await user.click(disclosureButtons()[1]);
    const editor = editorFor(1);
    await user.type(within(editor).getByRole('textbox', { name: 'Variable name' }), 'shard');
    await user.type(within(editor).getByRole('textbox', { name: 'Values (comma-separated)' }), 's1');
    expect(onVariablesChange).not.toHaveBeenCalled();

    await user.click(deleteButtons()[0]);

    expect(onVariablesChange).toHaveBeenCalledWith(1, { cluster: ['eu-west'], shard: ['s1'] });
    expect(deleteItem).toHaveBeenCalledWith(0);
    expect(onVariablesChange.mock.invocationCallOrder[0]).toBeLessThan(deleteItem.mock.invocationCallOrder[0]);
    expect(variablesPanels()).toHaveLength(0);
  });

  it('adds a variable typed into an open editor to its own row before that row is collapsed', async () => {
    const { user, onVariablesChange } = renderTable();

    await user.click(disclosureButtons()[0]);
    const editor = editorFor(0);
    await user.type(within(editor).getByRole('textbox', { name: 'Variable name' }), 'shard');
    await user.type(within(editor).getByRole('textbox', { name: 'Values (comma-separated)' }), 's1');

    await user.click(disclosureButtons()[0]);

    expect(onVariablesChange).toHaveBeenCalledWith(0, { host: ['Host1'], shard: ['s1'] });
    expect(disclosureStates()).toEqual(['false', 'false']);
  });

  it('adds a variable typed into an open editor to its own row before the row is lifted for a drag', async () => {
    const { user, onVariablesChange } = renderTable();

    await user.click(disclosureButtons()[0]);
    const editor = editorFor(0);
    await user.type(within(editor).getByRole('textbox', { name: 'Variable name' }), 'shard');
    await user.type(within(editor).getByRole('textbox', { name: 'Values (comma-separated)' }), 's1');

    await beginDrag({ draggableId: draggableIds()[0] ?? '', mode: 'FLUID' });

    expect(onVariablesChange).toHaveBeenCalledWith(0, { host: ['Host1'], shard: ['s1'] });
    expect(variablesPanels()).toHaveLength(0);
  });

  it('does not move the item when a drag is cancelled without a destination', async () => {
    const { moveItem } = renderTable();

    await endDrag(dropResult(0, null));

    expect(moveItem).not.toHaveBeenCalled();
  });

  // The library restores focus after a drop to the drag handle whose draggable id it recorded when
  // the item was lifted, so an id derived from the position hands the moved item's focus — and,
  // through the React key, its DOM node — to whichever row took its place.
  it('gives every row a draggable id that follows its own item across a reorder', async () => {
    const { moveItem } = renderStatefulTable(distinctItems());

    const idsBefore = draggableIds();
    const namesBefore = rowNames();
    expect(new Set(idsBefore).size).toBe(3);
    expect(idsBefore).not.toEqual(['0', '1', '2']);

    await endDrag(dropResult(0, 2));

    expect(moveItem).toHaveBeenCalledWith(0, 2);
    expect(rowNames()).toEqual([namesBefore[1], namesBefore[2], namesBefore[0]]);
    expect(draggableIds()).toEqual([idsBefore[1], idsBefore[2], idsBefore[0]]);
  });

  // Editing a row's variables replaces the item object. Two rows holding the same dashboard are
  // indistinguishable by content, so the identity has to survive that replacement as well as a
  // move, or the row would remount and take its open editor and the focus inside it with it.
  it('keeps each row of a duplicated dashboard on its own draggable id when its variables change', async () => {
    const { user } = renderStatefulTable();
    const idsBefore = draggableIds();

    await user.click(disclosureButtons()[1]);
    const editor = editorFor(1);
    await user.type(within(editor).getByRole('textbox', { name: 'Variable name' }), 'shard');
    await user.type(within(editor).getByRole('textbox', { name: 'Values (comma-separated)' }), 'a, b');
    await user.click(within(editor).getByRole('button', { name: 'Add variable' }));

    // The committed row is named for the item's position as well as the variable, so this also
    // says the row that took the text is the second entry of the dashboard and not the first.
    expect(await within(editor).findByRole('textbox', { name: 'Variable name for shard, item 2' })).toBeInTheDocument();
    expect(draggableIds()).toEqual(idsBefore);
    expect(disclosureStates()).toEqual(['false', 'true']);
  });

  // The panel of an expanded row is a sibling of the row inside the draggable wrapper, so it is
  // measured and lifted with the row unless it is gone before the library takes its dimensions.
  it('collapses every open editor before the library measures the row being lifted', async () => {
    const { user } = renderTable();
    await expandBothUidRows(user);

    await beginDrag({ draggableId: draggableIds()[0] ?? '', mode: 'FLUID' });

    expect(disclosureStates()).toEqual(['false', 'false']);
    expect(variablesPanels()).toHaveLength(0);
  });

  it('returns focus to the disclosure of the row being edited when another row is deleted', async () => {
    const { user, deleteItem } = renderStatefulTable();
    await user.click(disclosureButtons()[0]);
    const values = await screen.findByRole('textbox', { name: 'Values for host, item 1' });
    values.focus();
    expect(values).toHaveFocus();

    // Clicking would move focus onto the delete button first. Firing the event leaves focus inside
    // the panel that the deletion unmounts, which is the case that used to strand it on the page.
    fireEvent.click(deleteButtons()[1]);

    await waitFor(() => {
      expect(document.activeElement).toBe(disclosureButtons()[0]);
    });
    expect(deleteItem).toHaveBeenCalledWith(1);
    expect(disclosureStates()).toEqual(['false']);
    expect(variablesPanels()).toHaveLength(0);
  });

  it('moves focus off the delete button of the row it removed', async () => {
    const { user, deleteItem } = renderStatefulTable();

    await user.click(deleteButtons()[0]);

    await waitFor(() => {
      expect(activeElementName()).toBe('Template variables');
    });
    expect(deleteItem).toHaveBeenCalledWith(0);
    // Focus lands on the surviving row that took the deleted row's place, and on its disclosure
    // rather than its delete button, so a second Enter cannot remove another item.
    expect(deleteButtons()[0]).not.toHaveFocus();
    // The row that took the deleted row's place is the *other* entry of the same dashboard, which
    // its variable summary is what says: the deleted `host=Host1` entry is the one that is gone.
    expect(rowNames()).toEqual([
      'Playlist item, dashboard_by_uid, uid_1, cluster=eu-west',
      'Playlist item, dashboard_by_tag, graph-ng',
      'Playlist item, dashboard_by_id, 3',
    ]);
  });

  it('falls back to the drag handle when the row taking the deleted row place has no disclosure', async () => {
    const { user } = renderStatefulTable();

    await user.click(deleteButtons()[2]);

    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute('data-playlist-item-drag-handle');
    });
    expect(rowWrappers()).toHaveLength(3);
    expect(document.activeElement?.closest('[data-playlist-item-index]')).toBe(rowWrappers()[2]);
  });

  it('moves focus to the list itself when the last remaining row is deleted', async () => {
    const { user } = renderStatefulTable([playlistItems()[0]]);

    await user.click(deleteButtons()[0]);

    const list = document.querySelector('[data-rfd-droppable-id="playlist-list"]');
    await waitFor(() => {
      expect(document.activeElement).toBe(list);
    });
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.getByText('Playlist is empty. Add dashboards below.')).toBeInTheDocument();
  });

  describe('when a row carries template variables that have not been saved', () => {
    async function addVariableToFirstRow(user: UserEvent) {
      await user.click(disclosureButtons()[0]);
      const editor = editorFor(0);
      await user.type(within(editor).getByRole('textbox', { name: 'Variable name' }), 'shard');
      await user.type(within(editor).getByRole('textbox', { name: 'Values (comma-separated)' }), 'a, b');
      await user.click(within(editor).getByRole('button', { name: 'Add variable' }));
      expect(
        await within(editor).findByRole('textbox', { name: 'Variable name for shard, item 1' })
      ).toBeInTheDocument();
    }

    it('asks for confirmation before deleting it, naming how many values are at stake', async () => {
      const { user, deleteItem } = renderStatefulTable();
      await addVariableToFirstRow(user);

      await user.click(deleteButtons()[0]);

      const dialog = screen.getByRole('dialog', { name: 'Delete playlist item' });
      expect(deleteItem).not.toHaveBeenCalled();
      expect(
        within(dialog).getByText(
          'This item has 2 template variables that have not been saved yet. Deleting the item discards them.'
        )
      ).toBeInTheDocument();
    });

    it('removes it once the deletion is confirmed, without leaving focus on the page body', async () => {
      const { user, deleteItem } = renderStatefulTable();
      await addVariableToFirstRow(user);
      await user.click(deleteButtons()[0]);

      await user.click(screen.getByRole('button', { name: 'Delete item' }));

      expect(deleteItem).toHaveBeenCalledWith(0);
      expect(confirmDialog()).not.toBeInTheDocument();
      expect(rows()).toHaveLength(3);
      await waitFor(() => {
        expect(activeElementName()).toBe('Template variables');
      });
    });

    it('counts a variable that was typed but never added, which the deletion would discard', async () => {
      const { user, deleteItem } = renderStatefulTable();
      await user.click(disclosureButtons()[0]);
      const editor = editorFor(0);
      await user.type(within(editor).getByRole('textbox', { name: 'Variable name' }), 'shard');
      await user.type(within(editor).getByRole('textbox', { name: 'Values (comma-separated)' }), 'a, b');

      await user.click(deleteButtons()[0]);

      // The settle that runs before the row is judged is what puts the typed variable on the item,
      // so the question asked names both of them rather than only the one that was already there.
      const dialog = screen.getByRole('dialog', { name: 'Delete playlist item' });
      expect(deleteItem).not.toHaveBeenCalled();
      expect(
        within(dialog).getByText(
          'This item has 2 template variables that have not been saved yet. Deleting the item discards them.'
        )
      ).toBeInTheDocument();
    });

    it('keeps the row and its variables when the confirmation is dismissed', async () => {
      const { user, deleteItem } = renderStatefulTable();
      await addVariableToFirstRow(user);
      await user.click(deleteButtons()[0]);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(deleteItem).not.toHaveBeenCalled();
      expect(confirmDialog()).not.toBeInTheDocument();
      expect(rows()).toHaveLength(4);
      // The dismissal changes nothing, so the editor the variable was typed into is still open.
      expect(disclosureStates()).toEqual(['true', 'false']);
      expect(within(editorFor(0)).getByRole('textbox', { name: 'Values for shard, item 1' })).toHaveValue('a, b');
    });
  });

  // Variables loaded with the playlist are still stored on the server until the form is saved, and
  // the form's own Cancel puts the row back, so removing such a row stays a single click.
  it('deletes a row whose stored variables have not been edited without asking', async () => {
    const { user, deleteItem } = renderStatefulTable();

    await user.click(deleteButtons()[0]);

    expect(confirmDialog()).not.toBeInTheDocument();
    expect(deleteItem).toHaveBeenCalledWith(0);
    expect(rows()).toHaveLength(3);
  });

  /**
   * The disclosure carries its accessible name as `aria-label` rather than as `tooltip`, so no
   * overlay is rendered at all. A tooltip-bearing `IconButton` renders exactly one portal
   * `div[role="tooltip"]` on hover in jsdom, and floating-ui's `useFocus` keeps it open for as long
   * as the clicked button holds focus, so counting those elements is what makes this a regression
   * test rather than a tautology. In the browser that lingering overlay is pointer-capturing and
   * covers the next row's controls, which is why the first click is asserted to toggle the row.
   */
  it('renders no tooltip overlay for the disclosure and expands the row on the first click', async () => {
    const { user } = renderTable();

    await user.hover(disclosureButtons()[0]);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(0);

    await user.click(disclosureButtons()[0]);

    expect(disclosureStates()).toEqual(['true', 'false']);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
    expect(disclosureButtons()[0]).toHaveAccessibleName('Template variables');
  });

  /**
   * The summary shares the row's flex cell with a dashboard title that wraps to three lines on a
   * narrow viewport, and a shrinking flex item with the inherited `white-space: normal` broke the
   * phrase itself across two lines ("1" / "variable"). Wrapping is a layout outcome jsdom does not
   * compute, so the assertion is on the computed style emotion resolves from the class rule, which
   * is what actually decides it.
   */
  it('keeps the variable-count summary on one line and lets the dashboard title absorb the wrapping', () => {
    renderTable();

    const summaries = screen.getAllByText('1 variable');
    expect(summaries).toHaveLength(2);

    for (const summary of summaries) {
      const { whiteSpace, flexShrink } = window.getComputedStyle(summary);
      expect(whiteSpace).toBe('nowrap');
      expect(flexShrink).toBe('0');
    }
  });
});

describe('PlaylistTableRows', () => {
  // The table only ever expands a row whose own disclosure was clicked, and the tag and deprecated
  // dashboard_by_id rows have none, so their index cannot enter the table's expanded set at all.
  // The rows are therefore rendered directly with every index expanded, which is the only way to
  // hold the panel to its own dashboard_by_uid gate instead of inferring it from the disclosure's.
  // The stubbed `Draggable` above is what lets them render outside a real `DragDropContext`.
  it('renders a variables panel on the dashboard_by_uid rows only, even with every row index expanded', () => {
    render(
      // The rows are list items, so rendering them without `PlaylistTable` still needs the list
      // they belong to: a `listitem` outside a `list` is exactly the containment defect this
      // markup was restructured to remove, and a fixture is not the place to reintroduce it.
      <div role="list" aria-label="Playlist items">
        <PlaylistTableRows
          items={playlistItems()}
          itemKeys={['a', 'b', 'c', 'd']}
          onDelete={jest.fn()}
          expanded={new Set([0, 1, 2, 3])}
          onToggleExpanded={jest.fn()}
          onVariablesChange={jest.fn()}
        />
      </div>
    );

    expect(rows()).toHaveLength(4);
    expect(disclosureStates()).toEqual(['true', 'true']);
    expect(uidVariablesPanels()).toHaveLength(2);
    expect(variablesPanels()).toHaveLength(2);
    expect(screen.queryByRole('region', { name: /^Template variables for graph-ng/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Template variables for 3/ })).not.toBeInTheDocument();
  });
});
