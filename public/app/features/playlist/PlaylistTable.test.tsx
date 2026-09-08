import { DragDropContext, type DraggableProvided, type DropResult, type DroppableProvided } from '@hello-pangea/dnd';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { type ReactNode } from 'react';

import { PlaylistTable } from './PlaylistTable';
import { type PlaylistItemUI } from './types';

/** The loaded-dashboard shape a row renders, taken from the playlist item type itself. */
type LoadedDashboard = NonNullable<PlaylistItemUI['dashboards']>[number];

/**
 * The props each stubbed drag-and-drop export receives from `PlaylistTable` and
 * `PlaylistTableRows`. The stubs render their children straight away, so `provided` is all they
 * have to supply and none of the library's drag-state objects need to be invented here.
 */
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

// `PlaylistTable` keeps its `onDragEnd` handler internal and the real library only calls it after a
// pointer drag that jsdom cannot produce, so a reorder is reachable only by stubbing the library and
// reading the handler back off the props `DragDropContext` recorded. All three exports are stubbed
// together because `Draggable` throws when it renders outside a real `DragDropContext`.
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

function hostDashboard(): LoadedDashboard {
  return {
    kind: 'dashboard',
    name: 'Host dashboard',
    uid: 'uid_1',
    url: '/d/uid_1/host-dashboard',
    panel_type: '',
    tags: [],
    location: 'General',
    ds_uid: [],
    score: 0,
    explain: {},
  };
}

/**
 * The same dashboard twice with different variables. Rows are addressed by position, so this is the
 * arrangement in which an editor left open across a move or a deletion would re-attach to the other
 * item. `dashboards` is filled in because a row without it renders a spinner instead of its name.
 */
function playlistItems(): PlaylistItemUI[] {
  return [
    { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host1'] }, dashboards: [hostDashboard()] },
    { type: 'dashboard_by_uid', value: 'uid_1', variables: { cluster: ['eu-west'] }, dashboards: [hostDashboard()] },
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

/** The `aria-expanded` state of every row's variable editor disclosure, in row order. */
function disclosureStates() {
  return disclosureButtons().map((button) => button.getAttribute('aria-expanded'));
}

/**
 * Opens the first row's editor and proves it is genuinely open, because collapsing is only
 * observable from an expanded row. `host` belongs to the first item and `cluster` to the second, so
 * the editor on screen also identifies the row the disclosure opened.
 */
async function expectFirstRowEditorOpen(user: UserEvent) {
  await user.click(disclosureButtons()[0]);

  expect(await screen.findByRole('textbox', { name: 'Variable name for host' })).toBeInTheDocument();
  expect(disclosureStates()).toEqual(['true', 'false']);
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

  it('moves the item and collapses the open variable editor when a drag ends on a new position', async () => {
    const { user, moveItem } = renderTable();
    await expectFirstRowEditorOpen(user);

    await endDrag(dropResult(0, 1));

    expect(moveItem).toHaveBeenCalledWith(0, 1);
    expect(moveItem).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(disclosureStates()).toEqual(['false', 'false']);
    });
  });

  it('deletes the clicked item and collapses the variable editor open on another row', async () => {
    const { user, deleteItem } = renderTable();
    await expectFirstRowEditorOpen(user);

    await user.click(deleteButtons()[1]);

    expect(deleteItem).toHaveBeenCalledWith(1);
    expect(deleteItem).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(disclosureStates()).toEqual(['false', 'false']);
    });
  });

  it('does not move the item when a drag is cancelled without a destination', async () => {
    const { moveItem } = renderTable();

    await endDrag(dropResult(0, null));

    expect(moveItem).not.toHaveBeenCalled();
  });
});
