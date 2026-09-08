import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';

import { setBackendSrv } from '@grafana/runtime';
import { getCustomSearchHandler } from '@grafana/test-utils/handlers';
import server, { setupMockServer } from '@grafana/test-utils/server';
import { type DashboardPickerDTO } from 'app/core/components/Select/DashboardPicker';

import { type Playlist } from '../../api/clients/playlist/v1';
import { backendSrv } from '../../core/services/backend_srv';

import { PlaylistForm } from './PlaylistForm';
import * as playlistUtils from './utils';

setBackendSrv(backendSrv);
setupMockServer();

jest.mock('app/core/components/TagFilter/TagFilter', () => ({
  TagFilter: () => {
    return <>mocked-tag-filter</>;
  },
}));

// The real picker is an async Select backed by dashboard search. A button standing in for it keeps
// "add this dashboard" a single click, and `type="button"` matters: a submit button inside the
// form's real <form> would save the playlist instead of adding an item.
jest.mock('app/core/components/Select/DashboardPicker', () => ({
  DashboardPicker: ({ onChange }: { onChange: (dashboard: DashboardPickerDTO) => void }) => (
    <button
      type="button"
      onClick={() => onChange({ uid: 'uid_1', name: 'Host dashboard', folderUid: 'folder_1', folderTitle: 'Folder 1' })}
    >
      mocked-dashboard-picker
    </button>
  ),
}));

const mockPlaylist: Playlist = {
  apiVersion: 'playlist.grafana.app/v1',
  kind: 'Playlist',
  spec: {
    title: 'A test playlist',
    interval: '10m',
    items: [
      { type: 'dashboard_by_uid', value: 'uid_1' },
      { type: 'dashboard_by_uid', value: 'uid_2' },
      { type: 'dashboard_by_tag', value: 'tag_A' },
    ],
  },
  metadata: {
    name: 'foo',
  },
  status: {},
};

const mockEmptyPlaylist: Playlist = {
  apiVersion: 'playlist.grafana.app/v1',
  kind: 'Playlist',
  spec: {
    title: 'A test playlist',
    interval: '10m',
    items: [],
  },
  metadata: {
    name: 'foo',
  },
  status: {},
};

/**
 * A playlist whose dashboard items carry template variables, plus a tag item that cannot. Returned
 * from a factory so a test that edits it cannot leak state into the next one, and so the
 * immutability case can compare the object it passed in against a literal of these same values.
 */
function playlistWithVariables(): Playlist {
  return {
    apiVersion: 'playlist.grafana.app/v1',
    kind: 'Playlist',
    spec: {
      title: 'A test playlist',
      interval: '10m',
      items: [
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host1'] } },
        { type: 'dashboard_by_uid', value: 'uid_2', variables: { host: ['Host2'] } },
        { type: 'dashboard_by_tag', value: 'tag_A' },
      ],
    },
    metadata: {
      name: 'foo',
    },
    status: {},
  };
}

function setup(jsx: JSX.Element) {
  return {
    user: userEvent.setup(),
    ...render(jsx),
  };
}

function getTestContext(playlist: Playlist = mockPlaylist) {
  server.use(getCustomSearchHandler([]));
  const onSubmitMock = jest.fn();
  const { rerender, unmount, user } = setup(<PlaylistForm onSubmit={onSubmitMock} playlist={playlist} />);

  return { onSubmitMock, playlist, rerender, unmount, user };
}

function rows() {
  return screen.getAllByRole('row');
}

/** The picker re-mounts on every add (`key={items.length}`), so it is queried again each time. */
function dashboardPickerButton() {
  return screen.getByRole('button', { name: 'mocked-dashboard-picker' });
}

function saveButton() {
  return screen.getByRole('button', { name: /save/i });
}

/** One per `dashboard_by_uid` row, in row order; tag rows have no variable editor. */
function disclosureButtons() {
  return screen.getAllByRole('button', { name: 'Template variables' });
}

function disclosureStates() {
  return disclosureButtons().map((button) => button.getAttribute('aria-expanded'));
}

/**
 * The draggable wrapper of the row at `index`. The variables panel renders as a sibling of the
 * `role="row"` element rather than inside it, so the wrapper is the smallest element containing
 * both, and it is what confines a query to one row's editor when two rows hold the same dashboard.
 */
function rowWrapper(index: number): HTMLElement {
  const wrapper = rows()[index].parentElement;
  if (!wrapper) {
    throw new Error(`Row ${index} is not inside a draggable wrapper element`);
  }
  return wrapper;
}

/** The disclosure belonging to the row at `index`, never the nth disclosure of the whole table. */
function rowDisclosure(index: number) {
  return within(rows()[index]).getByRole('button', { name: 'Template variables' });
}

/**
 * The expanded variables panel of the row at `index`, reached by following that row's own
 * disclosure. Two rows listing the same dashboard label their panels identically, so the returned
 * region is provably the intended row's only because the disclosure that reports it controls
 * (`aria-controls`) lives in that row and the region carrying that id sits in that row's wrapper.
 */
function variableEditorFor(index: number): HTMLElement {
  const disclosure = rowDisclosure(index);
  const controlledId = disclosure.getAttribute('aria-controls');
  const region = within(rowWrapper(index)).getByRole('region');

  expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  expect(region.id).not.toBe('');
  expect(region.id).toBe(controlledId);

  return region;
}

/** Expands the row at `index` and returns the panel its disclosure controls. */
async function openVariableEditor(user: UserEvent, index: number): Promise<HTMLElement> {
  await user.click(rowDisclosure(index));
  return variableEditorFor(index);
}

/** The add row's inputs are labelled, where an existing variable's inputs are aria-labelled. */
function newVariableName(editor: HTMLElement) {
  return within(editor).getByRole('textbox', { name: 'Variable name' });
}

function newVariableValues(editor: HTMLElement) {
  return within(editor).getByRole('textbox', { name: 'Values (comma-separated)' });
}

function addVariableButton(editor: HTMLElement) {
  return within(editor).getByRole('button', { name: 'Add variable' });
}

/**
 * Commits one variable through the editor of the row at `index`, leaving the editor open, and
 * returns that editor's region so a caller can keep asserting inside it. Expansion and every query
 * below it go through that row's disclosure and the region it controls, so an editor left open on
 * another row — including one holding the same dashboard — cannot answer in its place.
 */
async function addVariable(user: UserEvent, index: number, name: string, values: string): Promise<HTMLElement> {
  const editor = await openVariableEditor(user, index);
  await user.type(newVariableName(editor), name);
  await user.type(newVariableValues(editor), values);
  await user.click(addVariableButton(editor));
  return editor;
}

/** `jest.fn()` records its arguments untyped, so the submitted playlist is typed at this one spot. */
function firstSubmittedPlaylist(onSubmitMock: jest.Mock): Playlist {
  const [submitted]: [Playlist] = onSubmitMock.mock.calls[0];
  return submitted;
}

describe('PlaylistForm', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // The enrichment case stubs the dashboard loader. This project's jest config restores nothing
    // between tests, so the stub has to be dropped here or it would answer for the next case too.
    jest.restoreAllMocks();
  });

  describe('when mounted with a playlist', () => {
    it('then name field should have correct value', () => {
      getTestContext();

      expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('A test playlist');
    });

    it('then interval field should have correct value', () => {
      getTestContext();

      expect(screen.getByRole('textbox', { name: /interval/i })).toHaveValue('10m');
    });

    it('then items row count should be correct', () => {
      getTestContext();

      expect(screen.getAllByRole('row')).toHaveLength(3);
    });

    it('then the first item row should be correct', () => {
      getTestContext();

      expectCorrectRow({ index: 0, type: 'dashboard_by_uid', value: 'uid_1' });
      expectCorrectRow({ index: 1, type: 'dashboard_by_uid', value: 'uid_2' });
      expectCorrectRow({ index: 2, type: 'dashboard_by_tag', value: 'tag_A' });
    });
  });

  describe('when deleting a playlist item', () => {
    it('then the item should be removed and other items should be correct', async () => {
      getTestContext();

      expect(rows()).toHaveLength(3);
      await userEvent.click(within(rows()[2]).getByRole('button', { name: /delete playlist item/i }));
      await waitFor(() => {
        expect(rows()).toHaveLength(2);
      });
      expectCorrectRow({ index: 0, type: 'dashboard_by_uid', value: 'uid_1' });
      expectCorrectRow({ index: 1, type: 'dashboard_by_uid', value: 'uid_2' });
    });
  });

  describe('when submitting the form', () => {
    it('then the correct item should be submitted', async () => {
      const { onSubmitMock } = getTestContext();

      await userEvent.click(screen.getByRole('button', { name: /save/i }));
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
      expect(onSubmitMock).toHaveBeenCalledWith({
        apiVersion: 'playlist.grafana.app/v1',
        kind: 'Playlist',
        spec: {
          title: 'A test playlist',
          interval: '10m',
          items: [
            { type: 'dashboard_by_uid', value: 'uid_1' },
            { type: 'dashboard_by_uid', value: 'uid_2' },
            { type: 'dashboard_by_tag', value: 'tag_A' },
          ],
        },
        metadata: {
          name: 'foo',
        },
        status: {},
      });
    });

    describe('and name is missing', () => {
      it('then an alert should appear and nothing should be submitted', async () => {
        const { onSubmitMock } = getTestContext();

        await userEvent.clear(screen.getByRole('textbox', { name: /name/i }));
        await userEvent.click(screen.getByRole('button', { name: /save/i }));
        expect(screen.getAllByRole('alert')).toHaveLength(1);
        expect(onSubmitMock).not.toHaveBeenCalled();
      });
    });

    describe('and interval is missing', () => {
      it('then an alert should appear and nothing should be submitted', async () => {
        const { onSubmitMock } = getTestContext();

        await userEvent.clear(screen.getByRole('textbox', { name: /interval/i }));
        await userEvent.click(screen.getByRole('button', { name: /save/i }));
        expect(screen.getAllByRole('alert')).toHaveLength(1);
        expect(onSubmitMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('when items are missing', () => {
    it('then save button is disabled', async () => {
      getTestContext(mockEmptyPlaylist);

      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    });
  });

  describe('when editing the template variables of a dashboard item', () => {
    it('submits the variables entered for a newly added dashboard', async () => {
      const { onSubmitMock, user } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      const disclosure = await screen.findByRole('button', { name: 'Template variables' });
      expect(disclosure).toHaveAttribute('aria-expanded', 'false');

      await user.click(disclosure);
      expect(disclosureStates()).toEqual(['true']);

      const editor = variableEditorFor(0);
      await user.type(newVariableName(editor), 'host');
      await user.type(newVariableValues(editor), 'a, b');
      await user.click(addVariableButton(editor));
      await user.click(saveButton());

      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [{ type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['a', 'b'] } }],
          },
          metadata: {
            name: 'foo',
          },
          status: {},
        });
      });
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });

    it('pre-populates the editor from a saved playlist when the form is mounted again', async () => {
      const { onSubmitMock, user, unmount } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      await addVariable(user, 0, 'host', 'a, b');
      await user.click(saveButton());
      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledTimes(1);
      });
      const saved = firstSubmittedPlaylist(onSubmitMock);
      unmount();

      // `usePlaylistItems` seeds its state from the prop only once, so re-rendering the same
      // instance would prove nothing about loading — the saved playlist needs a fresh mount.
      const reloaded = getTestContext(saved);

      expect(screen.getByText('1 variable')).toBeInTheDocument();
      const editor = await openVariableEditor(reloaded.user, 0);
      expect(await within(editor).findByRole('textbox', { name: 'Variable name for host' })).toHaveValue('host');
      expect(within(editor).getByRole('textbox', { name: 'Values for host' })).toHaveValue('a, b');
    });

    it('submits distinct variables for two rows holding the same dashboard', async () => {
      const { onSubmitMock, user } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      await addVariable(user, 0, 'host', 'a, b');
      await user.click(dashboardPickerButton());
      await addVariable(user, 1, 'host', 'c');

      // Both editors stay open on purpose. The two rows carry the same dashboard, so their rows and
      // their panels are labelled identically and only the disclosure-to-panel association tells
      // them apart; with one of the two closed, a panel rendered under the wrong row would look the
      // same as a correct one. Each region is re-resolved through its own row's `aria-controls`
      // here, so these assertions fail if that association is dropped or crossed over.
      const firstEditor = variableEditorFor(0);
      const secondEditor = variableEditorFor(1);
      expect(firstEditor.id).not.toBe(secondEditor.id);
      expect(within(firstEditor).getByRole('textbox', { name: 'Values for host' })).toHaveValue('a, b');
      expect(within(secondEditor).getByRole('textbox', { name: 'Values for host' })).toHaveValue('c');

      await user.click(saveButton());

      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [
              { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['a', 'b'] } },
              { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['c'] } },
            ],
          },
          metadata: {
            name: 'foo',
          },
          status: {},
        });
      });
    });

    it('submits an item with no variables key once its last variable is removed', async () => {
      const { onSubmitMock, user } = getTestContext(playlistWithVariables());

      const editor = await openVariableEditor(user, 0);
      await user.click(await within(editor).findByRole('button', { name: 'Remove variable host' }));
      await user.click(saveButton());

      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [
              { type: 'dashboard_by_uid', value: 'uid_1' },
              { type: 'dashboard_by_uid', value: 'uid_2', variables: { host: ['Host2'] } },
              { type: 'dashboard_by_tag', value: 'tag_A' },
            ],
          },
          metadata: {
            name: 'foo',
          },
          status: {},
        });
      });
      // `toHaveBeenCalledWith` compares with `toEqual` semantics, which treats a `variables:
      // undefined` key as absent, so the key set of each submitted item is asserted directly.
      expect(firstSubmittedPlaylist(onSubmitMock).spec.items.map((item) => Object.keys(item).sort())).toEqual([
        ['type', 'value'],
        ['type', 'value', 'variables'],
        ['type', 'value'],
      ]);
    });

    it('rejects a variable without a name and submits the items unchanged', async () => {
      const { onSubmitMock, user } = getTestContext(playlistWithVariables());

      const editor = await openVariableEditor(user, 0);
      await user.type(newVariableValues(editor), 'Host9');
      await user.click(addVariableButton(editor));

      expect(await within(editor).findByText('Variable name is required')).toBeInTheDocument();

      await user.click(saveButton());
      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [
              { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host1'] } },
              { type: 'dashboard_by_uid', value: 'uid_2', variables: { host: ['Host2'] } },
              { type: 'dashboard_by_tag', value: 'tag_A' },
            ],
          },
          metadata: {
            name: 'foo',
          },
          status: {},
        });
      });
    });

    it('collapses every editor and leaves each remaining item its own variables when a row is deleted', async () => {
      const { onSubmitMock, user } = getTestContext(playlistWithVariables());

      const editor = await openVariableEditor(user, 0);
      expect(await within(editor).findByRole('textbox', { name: 'Values for host' })).toHaveValue('Host1');
      expect(disclosureStates()).toEqual(['true', 'false']);

      await user.click(within(rows()[1]).getByRole('button', { name: /delete playlist item/i }));

      await waitFor(() => {
        expect(disclosureStates()).toEqual(['false']);
      });
      await user.click(saveButton());
      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [
              { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host1'] } },
              { type: 'dashboard_by_tag', value: 'tag_A' },
            ],
          },
          metadata: {
            name: 'foo',
          },
          status: {},
        });
      });
    });

    it('keeps a variable entered while the dashboard search is in flight and still merges the loaded dashboard', async () => {
      let releaseSearch = () => {};
      const searchGate = new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
      // The editor and the dashboard search write to the same item list, and a timed delay would
      // leave which of them lands last to the wall clock. Gating the loader makes the in-flight
      // window exact, and its result carries no variables on purpose: only a merge that keeps the
      // current state's other properties can leave the variable entered mid-flight in place.
      const loadDashboards = jest.spyOn(playlistUtils, 'loadDashboards').mockImplementation(async () => {
        await searchGate;
        return [
          {
            type: 'dashboard_by_uid',
            value: 'uid_1',
            dashboards: [
              {
                kind: 'dashboard',
                name: 'Host dashboard',
                uid: 'uid_1',
                url: '/d/uid_1/host-dashboard',
                panel_type: '',
                tags: [],
                location: 'general',
                ds_uid: [],
                score: 0,
                explain: {},
              },
            ],
          },
        ];
      });
      const { onSubmitMock, user } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      await waitFor(() => {
        expect(loadDashboards).toHaveBeenCalledWith([{ type: 'dashboard_by_uid', value: 'uid_1' }]);
      });
      expect(screen.queryByText('Host dashboard')).not.toBeInTheDocument();

      await addVariable(user, 0, 'host', 'a, b');
      releaseSearch();

      expect(await screen.findByText('Host dashboard')).toBeInTheDocument();
      expect(screen.getByText('1 variable')).toBeInTheDocument();

      await user.click(saveButton());
      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [{ type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['a', 'b'] } }],
          },
          metadata: {
            name: 'foo',
          },
          status: {},
        });
      });
    });

    it('leaves the playlist prop untouched while variables are added and removed', async () => {
      const { onSubmitMock, user, playlist } = getTestContext(playlistWithVariables());

      await addVariable(user, 0, 'cluster', 'eu-west');
      // The first row is collapsed again so the case also covers a commit surviving a closed
      // editor, and the removal below goes through the second row's own panel — both rows carry a
      // `host` variable, so an unscoped remove could take the first row's instead.
      await user.click(rowDisclosure(0));
      const secondEditor = await openVariableEditor(user, 1);
      await user.click(await within(secondEditor).findByRole('button', { name: 'Remove variable host' }));
      await user.click(saveButton());

      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [
              { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host1'], cluster: ['eu-west'] } },
              { type: 'dashboard_by_uid', value: 'uid_2' },
              { type: 'dashboard_by_tag', value: 'tag_A' },
            ],
          },
          metadata: {
            name: 'foo',
          },
          status: {},
        });
      });
      // The items reach the form from the RTK Query cache, so the edits above must have produced
      // new objects rather than writing through to the ones passed in.
      expect(playlist.spec.items).toEqual([
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host1'] } },
        { type: 'dashboard_by_uid', value: 'uid_2', variables: { host: ['Host2'] } },
        { type: 'dashboard_by_tag', value: 'tag_A' },
      ]);
    });
  });
});

interface ExpectCorrectRowArgs {
  index: number;
  type: 'dashboard_by_tag' | 'dashboard_by_uid';
  value: string;
}

function expectCorrectRow({ index, type, value }: ExpectCorrectRowArgs) {
  const row = within(rows()[index]);
  const cell = `Playlist item, ${type}, ${value}`;
  const regex = new RegExp(cell, 'i');
  expect(row.getByRole('cell', { name: regex })).toBeInTheDocument();
}
