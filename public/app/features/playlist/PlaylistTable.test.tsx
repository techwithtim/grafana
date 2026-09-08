import { DragDropContext, type DraggableProvided, type DropResult, type DroppableProvided } from '@hello-pangea/dnd';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { type ReactNode } from 'react';

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

function setup(jsx: JSX.Element) {
  return {
    user: userEvent.setup(),
    ...render(jsx),
  };
}

/**
 * The spies stand in for the playlist form, which owns the item list: the rows therefore stay
 * exactly as they are after a move or a deletion, which is what makes the collapse observable.
 */
function renderTable() {
  const deleteItem = jest.fn();
  const moveItem = jest.fn();
  const onVariablesChange = jest.fn();

  return {
    deleteItem,
    moveItem,
    onVariablesChange,
    ...setup(
      <PlaylistTable
        items={playlistItems()}
        deleteItem={deleteItem}
        moveItem={moveItem}
        onVariablesChange={onVariablesChange}
      />
    ),
  };
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

function uidVariablesPanels() {
  return screen.getAllByRole('region', { name: 'Template variables for uid_1' });
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

describe('PlaylistTable', () => {
  beforeEach(() => {
    // The stubbed `DragDropContext` records every render, so the recorded props must not leak from
    // one case into the next. Only the calls are cleared — resetting the mocks would strip the stub
    // implementations this file depends on.
    jest.clearAllMocks();
  });

  it('offers a variable editor on the two dashboard_by_uid rows and on neither the tag nor the id row', async () => {
    const { user } = renderTable();

    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getByRole('cell', { name: 'Playlist item, dashboard_by_tag, graph-ng' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Playlist item, dashboard_by_id, 3' })).toBeInTheDocument();
    expect(disclosureButtons()).toHaveLength(2);
    expect(variablesPanels()).toHaveLength(0);

    await expandBothUidRows(user);

    expect(uidVariablesPanels()).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Template variables for graph-ng' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Template variables for 3' })).not.toBeInTheDocument();
  });

  it('closes an open variable editor when its own disclosure is clicked a second time', async () => {
    const { user } = renderTable();

    await user.click(disclosureButtons()[0]);

    expect(await screen.findByRole('textbox', { name: 'Variable name for host' })).toBeInTheDocument();
    expect(disclosureStates()).toEqual(['true', 'false']);
    expect(variablesPanels()).toHaveLength(1);

    await user.click(disclosureButtons()[0]);

    expect(disclosureStates()).toEqual(['false', 'false']);
    expect(screen.queryByRole('region', { name: 'Template variables for uid_1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Variable name for host' })).not.toBeInTheDocument();
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

  // A collapsed row mounts no panel, so the attribute is absent rather than naming an id that
  // resolves to nothing; `aria-expanded` is what announces the collapsed disclosure.
  it('carries aria-controls only while the row it belongs to is expanded', async () => {
    const { user } = renderTable();

    expect(disclosureStates()).toEqual(['false', 'false']);
    expect(disclosureControls()).toEqual([null, null]);

    await user.click(disclosureButtons()[0]);

    const [firstPanelId, secondPanelId] = disclosureControls();
    expect(firstPanelId).toEqual(expect.stringMatching(/\S/));
    expect(secondPanelId).toBeNull();
    expect(uidVariablesPanels().map((panel) => panel.getAttribute('id'))).toEqual([firstPanelId]);

    await user.click(disclosureButtons()[0]);

    expect(disclosureStates()).toEqual(['false', 'false']);
    expect(disclosureControls()).toEqual([null, null]);
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

  it('does not move the item when a drag is cancelled without a destination', async () => {
    const { moveItem } = renderTable();

    await endDrag(dropResult(0, null));

    expect(moveItem).not.toHaveBeenCalled();
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
      <PlaylistTableRows
        items={playlistItems()}
        onDelete={jest.fn()}
        expanded={new Set([0, 1, 2, 3])}
        onToggleExpanded={jest.fn()}
        onVariablesChange={jest.fn()}
      />
    );

    expect(disclosureStates()).toEqual(['true', 'true']);
    expect(uidVariablesPanels()).toHaveLength(2);
    expect(variablesPanels()).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Template variables for graph-ng' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Template variables for 3' })).not.toBeInTheDocument();
  });
});
