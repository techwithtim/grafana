import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { useEffect } from 'react';
import { render as renderWithRouter } from 'test/test-utils';

import { colorManipulator, rangeUtil } from '@grafana/data';
import { config, locationService, setBackendSrv } from '@grafana/runtime';
import { getCustomSearchHandler } from '@grafana/test-utils/handlers';
import server, { setupMockServer } from '@grafana/test-utils/server';
import { type DashboardPickerDTO } from 'app/core/components/Select/DashboardPicker';
import { type TermCount } from 'app/core/components/TagFilter/TagFilter';
import * as searcherService from 'app/features/search/service/searcher';

import { type Playlist } from '../../api/clients/playlist/v1';
import { backendSrv } from '../../core/services/backend_srv';

import { PlaylistForm } from './PlaylistForm';
import * as playlistUtils from './utils';

setBackendSrv(backendSrv);
setupMockServer();

// The real `TagFilter` compares its `tags` prop by reference and re-queries the dashboard tag
// facets whenever that identity changes, so the stand-in records every reference it is handed.
const mockTagFilterTagProps: string[][] = [];

/**
 * Whether "Add by tag" renders the real `TagFilter` for the case under test.
 *
 * The stand-in keeps every other case independent of react-select's async option loading, and it
 * is what records the `tags` reference identity above. The cases that are about what the tag
 * options themselves offer — their accessible names, and adding an item by picking one — need the
 * real control, its real options and the real `TagOption` that renders them.
 */
const mockRealTagFilter = { enabled: false };

jest.mock('app/core/components/TagFilter/TagFilter', () => {
  const actualModule = jest.requireActual('app/core/components/TagFilter/TagFilter');

  return {
    TagFilter: (props: { tags: string[] }) => {
      mockTagFilterTagProps.push(props.tags);
      return mockRealTagFilter.enabled ? <actualModule.TagFilter {...props} /> : <>mocked-tag-filter</>;
    },
  };
});

// `jest.mock` factories are hoisted above the imports, so anything they reach for has to be
// declared with a `mock`-prefixed name (babel-plugin-jest-hoist allows only those).
const mockDashboardPickerMounts = { count: 0 };

// The real picker is an async Select backed by dashboard search. A button standing in for it keeps
// "add this dashboard" a single click, and `type="button"` matters: a submit button inside the
// form's real <form> would save the playlist instead of adding an item. The mount counter stands in
// for the real picker's mount cost: it subscribes to dashboard and tag search when it mounts.
jest.mock('app/core/components/Select/DashboardPicker', () => ({
  DashboardPicker: ({ onChange }: { onChange: (dashboard: DashboardPickerDTO) => void }) => {
    useEffect(() => {
      mockDashboardPickerMounts.count++;
    }, []);

    return (
      <button
        type="button"
        onClick={() =>
          onChange({ uid: 'uid_1', name: 'Host dashboard', folderUid: 'folder_1', folderTitle: 'Folder 1' })
        }
      >
        mocked-dashboard-picker
      </button>
    );
  },
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

/**
 * Renders the form with an `onSubmit` the test supplies. `getTestContext` covers everything that
 * only needs to observe what was submitted; this is for the cases that also need to control when
 * the save settles, or to navigate from inside it the way the pages do.
 */
function renderWithSubmit(playlist: Playlist, onSubmit: jest.Mock) {
  server.use(getCustomSearchHandler([]));
  return setup(<PlaylistForm onSubmit={onSubmit} playlist={playlist} />);
}

/**
 * Renders the form inside the app's providers, which the unsaved-changes cases need: the location
 * service they navigate through is created fresh per render (so one test's location cannot leak into
 * the next), and the redirect the discard button performs goes through the router.
 */
function renderInApp(playlist: Playlist, onSubmit: jest.Mock = jest.fn()) {
  server.use(getCustomSearchHandler([]));
  return { onSubmitMock: onSubmit, ...renderWithRouter(<PlaylistForm onSubmit={onSubmit} playlist={playlist} />) };
}

/**
 * An `onSubmit` whose promise the test settles by hand. The pages await their create/replace call
 * before navigating, so the in-flight window is the whole request; controlling it here makes the
 * assertions about that window exact rather than dependent on the wall clock.
 */
function controlledSubmit() {
  let resolveSubmit = () => {};
  const onSubmitMock = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      })
  );

  return { onSubmitMock, settleSubmit: () => resolveSubmit() };
}

/**
 * An in-app navigation attempt, as the app's own redirects and menu links make it. Wrapped in `act`
 * because the guard answers it by opening a modal, which is a React state update originating from
 * outside React.
 */
async function attemptNavigation(path: string) {
  await act(async () => {
    locationService.push(path);
  });
}

function currentPath() {
  return locationService.getLocation().pathname;
}

function unsavedChangesModal() {
  return screen.queryByRole('dialog', { name: 'Leave page?' });
}

/**
 * Dispatches the event the browser fires before a reload or a tab close, and reports whether it was
 * cancelled — which is what makes the browser show its own "leave site?" dialog.
 */
function reloadIsBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Stubs the dashboard search so enrichment attaches a named dashboard to every item. The name is
 * rendered in the row, so a test can wait for it and know the enrichment has merged into the item
 * list before it asserts anything about unsaved changes.
 */
function stubDashboardEnrichment() {
  return jest.spyOn(playlistUtils, 'loadDashboards').mockImplementation(async (items) =>
    items.map((item) => ({
      ...item,
      dashboards: [
        {
          kind: 'dashboard',
          name: `Dashboard ${item.value}`,
          uid: item.value,
          url: `/d/${item.value}/dashboard-${item.value}`,
          panel_type: '',
          tags: [],
          location: 'general',
          ds_uid: [],
          score: 0,
          explain: {},
        },
      ],
    }))
  );
}

/**
 * The item list, and the rows of it.
 *
 * The rows are a `list` of `listitem` elements: a row owns the item's name, its controls and,
 * while it is expanded, its variables editor — content a `row` may not own, in a place a `row`
 * may not be, which is why neither role is here any more.
 */
function itemList() {
  return screen.getByRole('list', { name: 'Playlist items' });
}

function rows() {
  return within(itemList()).getAllByRole('listitem');
}

/** Stands in for the "Add by title" picker; one click adds `uid_1` to the item list. */
function dashboardPickerButton() {
  return screen.getByRole('button', { name: 'mocked-dashboard-picker' });
}

function saveButton() {
  return screen.getByRole('button', { name: /save/i });
}

function cancelButton() {
  return screen.getByRole('link', { name: /cancel/i });
}

/**
 * How the Save control presents its availability, in both of the ways it can.
 *
 * They are read together because the defect was that they disagreed: `Button` pairs the native
 * `disabled` attribute with `aria-disabled="false"`, so an unavailable Save reported itself as
 * enabled to assistive technology while being unfocusable and unhoverable — which took its reason
 * with it. `nativeDisabled` must therefore be false in every state.
 */
function saveAvailability() {
  const save = saveButton();
  return {
    ariaDisabled: save.getAttribute('aria-disabled'),
    nativeDisabled: save.hasAttribute('disabled'),
  };
}

/** The form's polite live region, which is where a refused save says so. */
function saveLiveRegion() {
  return screen.getByRole('status');
}

/** The interaction states a pointer or the keyboard can put a button into. */
const REACHABLE_STATES = ['hover', 'focus', 'focus-visible', 'active'] as const;

type ReachableState = (typeof REACHABLE_STATES)[number];

/**
 * The background each reachable state declares for `element`, read out of the emotion rules that
 * apply to it and restricted to the rules that also carry the availability guard.
 *
 * `Button` declares a background for the same states without that guard, and those rules are still
 * in the sheet — they are what the guarded ones override, since `:not()` makes them more specific.
 * Reading them all back would therefore report the fill that loses rather than the one that paints,
 * so the guard is what identifies the winning rule here. jsdom applies no pseudo-class state, which
 * is why this reads the declarations instead of computed styles.
 */
function guardedStateFills(element: HTMLElement): Partial<Record<ReachableState, string>> {
  const classSelectors = Array.from(element.classList, (name) => `.${name}`);
  const fills: Partial<Record<ReachableState, string>> = {};

  // Emotion inserts through the CSSOM here, so the rules are read from the sheets rather than from
  // the text of the style elements, which is empty. Each rule is one flattened declaration block,
  // e.g. `.css-hash:not([disabled]):not([aria-disabled='true']):hover {background: #2c64d6;}`.
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules ?? [])) {
      const match = /^([^{}]+)\{([^{}]*)\}/.exec(rule.cssText ?? '');
      if (!match) {
        continue;
      }
      const [, selectorList, body] = match;
      const background = /(?:^|;)\s*background(?:-color)?:\s*([^;]+)/.exec(body)?.[1]?.trim();
      if (!background) {
        continue;
      }

      for (const selector of selectorList.split(',')) {
        if (!classSelectors.some((classSelector) => selector.includes(classSelector))) {
          continue;
        }
        if (!selector.includes(':not([disabled])')) {
          continue;
        }
        // `focus-visible` is matched ahead of `focus`, and `focus` only where no hyphen follows it,
        // so a `:focus-visible` selector is not also counted as a `:focus` one.
        for (const [, state] of selector.matchAll(/:(hover|active|focus-visible|focus(?!-))/g)) {
          fills[state as ReachableState] = background;
        }
      }
    }
  }

  return fills;
}

function nameField() {
  return screen.getByRole('textbox', { name: /name/i });
}

function intervalField() {
  return screen.getByRole('textbox', { name: /interval/i });
}

/**
 * Submits the form itself, the way pressing Enter in a field does.
 *
 * Clicking Save proves nothing about a save the form refuses: Save is disabled while any field
 * reports an error, so a swallowed click and a refused submit look identical. Going through the
 * form puts the question to react-hook-form's submit handler, which is what has to decline.
 */
function submitForm() {
  fireEvent.submit(saveButton());
}

function disclosureButtons() {
  return screen.getAllByRole('button', { name: 'Template variables' });
}

function disclosureStates() {
  return disclosureButtons().map((button) => button.getAttribute('aria-expanded'));
}

function rowDisclosure(index: number) {
  return within(rows()[index]).getByRole('button', { name: 'Template variables' });
}

/**
 * The expanded variables panel of the row at `index`, reached by following that row's own
 * disclosure.
 *
 * The returned region is provably the intended row's twice over: the disclosure reporting it
 * controls (`aria-controls`) lives in that row, the region carrying that id is inside that row,
 * and the region names the row's position, so a panel rendered under the wrong row of a
 * duplicated dashboard fails here rather than passing as a correct one.
 */
function variableEditorFor(index: number): HTMLElement {
  const disclosure = rowDisclosure(index);
  const controlledId = disclosure.getAttribute('aria-controls');
  const region = within(rows()[index]).getByRole('region');

  expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  expect(region.id).not.toBe('');
  expect(region.id).toBe(controlledId);
  expect(region).toHaveAccessibleName(new RegExp(`, item ${index + 1}$`));

  return region;
}

async function openVariableEditor(user: UserEvent, index: number): Promise<HTMLElement> {
  await user.click(rowDisclosure(index));
  return variableEditorFor(index);
}

function newVariableName(editor: HTMLElement) {
  return within(editor).getByRole('textbox', { name: 'Variable name' });
}

function newVariableValues(editor: HTMLElement) {
  return within(editor).getByRole('textbox', { name: 'Values (comma-separated)' });
}

function addVariableButton(editor: HTMLElement) {
  return within(editor).getByRole('button', { name: 'Add variable' });
}

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
    mockDashboardPickerMounts.count = 0;
    mockTagFilterTagProps.length = 0;
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

      expect(rows()).toHaveLength(3);
    });

    /**
     * The rows are one item of a list each, and nothing about them is tabular.
     *
     * They used to be `role="row"` elements owning a `role="cell"`, which is invalid twice: a row
     * has to be owned by a table, grid, treegrid or rowgroup, and there is none here, and a row
     * may own nothing but cells, while these rows own a disclosure, a delete button, a drag handle
     * and — while a row is expanded — a whole variables editor.
     */
    it('then the item rows are list items of a named list and carry no table roles', () => {
      getTestContext();

      expect(rows()).toHaveLength(3);
      expect(screen.queryAllByRole('row')).toHaveLength(0);
      expect(screen.queryAllByRole('cell')).toHaveLength(0);
      expect(screen.queryAllByRole('table')).toHaveLength(0);
      expect(screen.queryAllByRole('grid')).toHaveLength(0);
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

  describe('when the item list changes structurally', () => {
    it('then the dashboard picker is not re-mounted', async () => {
      const { user } = getTestContext();

      expect(rows()).toHaveLength(3);
      expect(mockDashboardPickerMounts.count).toBe(1);

      await user.click(dashboardPickerButton());
      await waitFor(() => {
        expect(rows()).toHaveLength(4);
      });

      await user.click(within(rows()[3]).getByRole('button', { name: /delete playlist item/i }));
      await waitFor(() => {
        expect(rows()).toHaveLength(3);
      });

      // Re-mounting the picker is what dropped keyboard focus to `document.body` after a selection
      // and re-issued its dashboard and tag search requests, whose async default-options load runs
      // on mount only. Adding and deleting an item are local edits, so the picker survives both.
      expect(mockDashboardPickerMounts.count).toBe(1);

      // The tag filter holds no tags here, but it reloads the dashboard tag facets whenever its
      // `tags` prop changes identity — it compares by reference. The add and the delete above
      // re-rendered this form several times, and every one of those renders has to hand the filter
      // the same array, or a purely local edit of the item list issues search requests again.
      expect(mockTagFilterTagProps.length).toBeGreaterThan(1);
      expect(new Set(mockTagFilterTagProps).size).toBe(1);
      expectCorrectRow({ index: 0, type: 'dashboard_by_uid', value: 'uid_1' });
      expectCorrectRow({ index: 1, type: 'dashboard_by_uid', value: 'uid_2' });
      expectCorrectRow({ index: 2, type: 'dashboard_by_tag', value: 'tag_A' });
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

    describe('and name is nothing but spaces', () => {
      it('then it is refused with a reason and nothing should be submitted', async () => {
        const { onSubmitMock, user } = getTestContext();

        await user.clear(nameField());
        await user.type(nameField(), '   ');
        // Submitted through the form rather than by clicking Save, so what refuses the save is the
        // field's own validation and not the disabled state of the button.
        submitForm();

        // `required` alone accepts a name of spaces — it is a non-empty string — and the playlist
        // used to be stored with it, leaving an unnamed card in the list.
        expect(await screen.findByRole('alert')).toHaveTextContent('Name cannot consist only of spaces');
        expect(onSubmitMock).not.toHaveBeenCalled();
      });
    });

    describe('and the name has surrounding whitespace', () => {
      it('then the trimmed name is submitted', async () => {
        const { onSubmitMock, user } = getTestContext();

        await user.clear(nameField());
        await user.type(nameField(), '  Padded playlist  ');
        await user.click(saveButton());

        await waitFor(() => expect(onSubmitMock).toHaveBeenCalledTimes(1));
        expect(firstSubmittedPlaylist(onSubmitMock).spec?.title).toBe('Padded playlist');
        // The field itself keeps what was typed; only what is stored is normalised.
        expect(nameField()).toHaveValue('  Padded playlist  ');
      });
    });

    describe('and the interval is not a duration', () => {
      it.each(['bogus', '5 minutes', 'm5', '   ', '0'])(
        'then %p is refused with a reason and nothing should be submitted',
        async (interval) => {
          const { onSubmitMock, user } = getTestContext();

          await user.clear(intervalField());
          await user.type(intervalField(), interval);
          submitForm();

          // Every one of these throws in `rangeUtil.intervalToMs`, which is what `PlaylistSrv`
          // calls when the playlist is started, so accepting one would store an unplayable
          // playlist.
          expect(await screen.findByRole('alert')).toHaveTextContent(
            'Interval must be a duration such as 30s, 5m or 1h'
          );
          expect(() => rangeUtil.intervalToMs(interval)).toThrow();
          expect(onSubmitMock).not.toHaveBeenCalled();
        }
      );

      it.each(['30s', '5m', '90s', '1h', '2d', '45'])(
        'then %p is accepted, exactly as playback parses it',
        async (interval) => {
          const { onSubmitMock, user } = getTestContext();

          await user.clear(intervalField());
          await user.type(intervalField(), interval);
          await user.click(saveButton());

          await waitFor(() => expect(onSubmitMock).toHaveBeenCalledTimes(1));
          expect(firstSubmittedPlaylist(onSubmitMock).spec?.interval).toBe(interval);
          expect(() => rangeUtil.intervalToMs(interval)).not.toThrow();
        }
      );
    });

    describe('and both a blank name and an invalid interval are given for a new playlist', () => {
      it('then nothing is created until each one is corrected', async () => {
        const { onSubmitMock, user } = getTestContext(mockEmptyPlaylist);

        await user.clear(nameField());
        await user.type(nameField(), '   ');
        await user.clear(intervalField());
        await user.type(intervalField(), 'bogus');
        await user.click(dashboardPickerButton());
        await waitFor(() => {
          expect(rows()).toHaveLength(1);
        });

        submitForm();

        // Both fields report, and the create request the QA reproduction saw is never made.
        expect(await screen.findAllByRole('alert')).toHaveLength(2);
        expect(onSubmitMock).not.toHaveBeenCalled();

        await user.clear(nameField());
        await user.type(nameField(), ' Corrected playlist ');
        await user.clear(intervalField());
        await user.type(intervalField(), '10m');
        // Leaving the field is what re-runs its validation in this form (`validateOn="onBlur"`),
        // which is how the messages go and how Save — unavailable while an error is reported —
        // comes back for the retry.
        await user.tab();

        await waitFor(() => {
          expect(screen.queryAllByRole('alert')).toHaveLength(0);
        });
        expect(saveAvailability()).toEqual({ ariaDisabled: 'false', nativeDisabled: false });
        await user.click(saveButton());

        await waitFor(() => expect(onSubmitMock).toHaveBeenCalledTimes(1));
        expect(firstSubmittedPlaylist(onSubmitMock).spec).toMatchObject({
          title: 'Corrected playlist',
          interval: '10m',
        });
      });
    });
  });

  describe('when items are missing', () => {
    it('then Save presents as unavailable, and says so the same way twice', async () => {
      getTestContext(mockEmptyPlaylist);

      expect(saveAvailability()).toEqual({ ariaDisabled: 'true', nativeDisabled: false });
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
      expect(await within(editor).findByRole('textbox', { name: 'Variable name for host, item 1' })).toHaveValue(
        'host'
      );
      expect(within(editor).getByRole('textbox', { name: 'Values for host, item 1' })).toHaveValue('a, b');
    });

    it('submits distinct variables for two rows holding the same dashboard', async () => {
      const { onSubmitMock, user } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      await addVariable(user, 0, 'host', 'a, b');
      await user.click(dashboardPickerButton());
      await addVariable(user, 1, 'host', 'c');

      // Both editors stay open on purpose. The two rows carry the same dashboard, so only the
      // disclosure-to-panel association and the position each panel names tell them apart; with
      // one of the two closed, a panel rendered under the wrong row would look the same as a
      // correct one. Each region is re-resolved through its own row's `aria-controls` here, so
      // these assertions fail if that association is dropped or crossed over.
      const firstEditor = variableEditorFor(0);
      const secondEditor = variableEditorFor(1);
      expect(firstEditor.id).not.toBe(secondEditor.id);
      expect(within(firstEditor).getByRole('textbox', { name: 'Values for host, item 1' })).toHaveValue('a, b');
      expect(within(secondEditor).getByRole('textbox', { name: 'Values for host, item 2' })).toHaveValue('c');

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

    /**
     * The arrangement the feature exists for, read the way a user reads it: one dashboard listed
     * twice, both editors closed, and the two rows still telling the reader which entry plays
     * which host — in their text and in the name assistive technology reports for them.
     */
    it('tells two closed rows of one dashboard apart by the variables each one plays', async () => {
      const { user } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      await addVariable(user, 0, 'host', 'Host1');
      await user.click(dashboardPickerButton());
      await addVariable(user, 1, 'host', 'Host2');

      await user.click(rowDisclosure(0));
      await user.click(rowDisclosure(1));
      expect(disclosureStates()).toEqual(['false', 'false']);

      expectCorrectRow({ index: 0, type: 'dashboard_by_uid', value: 'uid_1', variables: 'host=Host1' });
      expectCorrectRow({ index: 1, type: 'dashboard_by_uid', value: 'uid_1', variables: 'host=Host2' });
      expect(rows()[0]).toHaveTextContent('· host=Host1');
      expect(rows()[1]).toHaveTextContent('· host=Host2');
      // The counts match, which is the case the summary exists for: it is the values, not the
      // count, that separate the rows.
      expect(screen.getAllByText('1 variable')).toHaveLength(2);
    });

    it('names each open editor and its controls after the row they belong to', async () => {
      const { user } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      await addVariable(user, 0, 'host', 'Host1');
      await user.click(dashboardPickerButton());
      await addVariable(user, 1, 'host', 'Host2');

      const firstEditor = variableEditorFor(0);
      const secondEditor = variableEditorFor(1);
      expect(firstEditor).toHaveAccessibleName('Template variables for uid_1, item 1');
      expect(secondEditor).toHaveAccessibleName('Template variables for uid_1, item 2');
      expect(within(firstEditor).getByRole('textbox', { name: 'Values for host, item 1' })).toHaveValue('Host1');
      expect(within(secondEditor).getByRole('textbox', { name: 'Values for host, item 2' })).toHaveValue('Host2');
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

    it('refuses to save a variable without a name, keeps the message, and saves once it is given one', async () => {
      const { onSubmitMock, user } = getTestContext(playlistWithVariables());

      const editor = await openVariableEditor(user, 0);
      await user.type(newVariableValues(editor), 'Host9');
      await user.click(addVariableButton(editor));

      expect(await within(editor).findByText('Variable name is required')).toBeInTheDocument();

      await user.click(saveButton());

      // Saving now would drop the text the user can see on screen and report that as a success, so
      // the save stops and the editor stays open with its message.
      expect(onSubmitMock).not.toHaveBeenCalled();
      expect(within(editor).getByText('Variable name is required')).toBeInTheDocument();
      expect(disclosureStates()).toEqual(['true', 'false']);

      await user.type(newVariableName(editor), 'extra');
      await user.click(saveButton());

      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [
              { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host1'], extra: ['Host9'] } },
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
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });

    it('saves a variable that was typed but never added', async () => {
      const { onSubmitMock, user } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      const editor = await openVariableEditor(user, 0);
      await user.type(newVariableName(editor), 'draft2');
      await user.type(newVariableValues(editor), 'd2');

      // No click on Add variable: the text is still in the add row when Save is pressed, and a
      // playlist saved without it would report success while dropping what the user typed.
      await user.click(saveButton());

      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [{ type: 'dashboard_by_uid', value: 'uid_1', variables: { draft2: ['d2'] } }],
          },
          metadata: {
            name: 'foo',
          },
          status: {},
        });
      });
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });

    /**
     * The interaction that used to lose a save: with text in the add row, the press on Save moves
     * focus out of the field, and adding the variable at that moment inserts a row into the panel
     * above the button — which moves the button out from under the pointer before the click that
     * submits has been delivered, so nothing is saved and nothing is said. Leaving the row now
     * changes nothing at all, and the save is what adds the variable.
     */
    it('leaves a variable typed but never added in the add row when focus moves to another field', async () => {
      const { onSubmitMock, user } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      const editor = await openVariableEditor(user, 0);
      await user.type(newVariableName(editor), 'oneclick');
      await user.type(newVariableValues(editor), 'o1, o2');

      // The playlist's own Name field, which is where the QA report's own reproduction clicked.
      await user.click(screen.getByRole('textbox', { name: 'Name' }));

      expect(screen.queryByText('1 variable')).not.toBeInTheDocument();
      expect(newVariableName(editor)).toHaveValue('oneclick');
      expect(newVariableValues(editor)).toHaveValue('o1, o2');
      expect(
        within(editor).getByText('This variable is not added yet. Select Add variable to include it.')
      ).toBeInTheDocument();
      expect(onSubmitMock).not.toHaveBeenCalled();
    });

    /**
     * A variable typed into an open editor is committed before the deletion that collapses it, so
     * it belongs to the row it was typed into rather than to whichever item takes that position.
     */
    it('keeps a variable typed but never added with its own item when a row above it is deleted', async () => {
      const { onSubmitMock, user } = getTestContext(playlistWithVariables());

      const editor = await openVariableEditor(user, 1);
      await user.type(newVariableName(editor), 'shard');
      await user.type(newVariableValues(editor), 's1');

      await user.click(within(rows()[0]).getByRole('button', { name: /delete playlist item/i }));

      expect(disclosureStates()).toEqual(['false']);
      await user.click(saveButton());

      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalled();
      });
      expect(firstSubmittedPlaylist(onSubmitMock).spec.items).toEqual([
        { type: 'dashboard_by_uid', value: 'uid_2', variables: { host: ['Host2'], shard: ['s1'] } },
        { type: 'dashboard_by_tag', value: 'tag_A' },
      ]);
    });

    it('points every collapsed disclosure at the variables panel of its own row', () => {
      getTestContext(playlistWithVariables());

      const controlled = disclosureButtons().map((button) => button.getAttribute('aria-controls'));
      expect(disclosureStates()).toEqual(['false', 'false']);
      expect(new Set(controlled).size).toBe(2);
      controlled.forEach((panelId, index) => {
        const panel = document.getElementById(panelId ?? '');
        expect(panel).not.toBeNull();
        // Named while collapsed and resolving to an element inside its own row, and hidden — so it
        // is no more exposed than an absent panel is, and the reference is never left dangling.
        expect(panel).toHaveAttribute('hidden');
        expect(rows()[index].contains(panel)).toBe(true);
      });
      expect(screen.queryAllByRole('region')).toHaveLength(0);
    });

    it('keeps a variable that was typed but never added when the row is collapsed and reopened', async () => {
      const { user } = getTestContext(mockEmptyPlaylist);

      await user.click(dashboardPickerButton());
      const editor = await openVariableEditor(user, 0);
      await user.type(newVariableName(editor), 'draft1');
      await user.type(newVariableValues(editor), 'd1');

      // Collapsing unmounts the panel and everything typed into it, so the variable has to have
      // been added by the time the disclosure closes.
      await user.click(rowDisclosure(0));

      expect(await screen.findByText('1 variable')).toBeInTheDocument();
      expect(disclosureStates()).toEqual(['false']);

      const reopened = await openVariableEditor(user, 0);
      expect(within(reopened).getByRole('textbox', { name: 'Variable name for draft1, item 1' })).toHaveValue('draft1');
      expect(within(reopened).getByRole('textbox', { name: 'Values for draft1, item 1' })).toHaveValue('d1');
    });

    it('refuses to save an invalid edit of a committed variable, then saves the corrected value', async () => {
      const { onSubmitMock, user } = getTestContext(playlistWithVariables());

      const editor = await openVariableEditor(user, 0);
      await user.clear(within(editor).getByRole('textbox', { name: 'Values for host, item 1' }));

      // The click on Save is itself what leaves the field, so the rejection and the submit arrive
      // in one interaction: saving through it would store the value the user had just replaced.
      await user.click(saveButton());

      expect(onSubmitMock).not.toHaveBeenCalled();
      expect(await within(editor).findByText('Variable value is required')).toBeInTheDocument();
      expect(disclosureStates()).toEqual(['true', 'false']);

      await user.type(within(editor).getByRole('textbox', { name: 'Values for host, item 1' }), 'Host9');
      await user.click(saveButton());

      await waitFor(() => {
        expect(onSubmitMock).toHaveBeenCalledWith({
          apiVersion: 'playlist.grafana.app/v1',
          kind: 'Playlist',
          spec: {
            title: 'A test playlist',
            interval: '10m',
            items: [
              { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host9'] } },
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
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });

    it('collapses every editor and leaves each remaining item its own variables when a row is deleted', async () => {
      const { onSubmitMock, user } = getTestContext(playlistWithVariables());

      const editor = await openVariableEditor(user, 0);
      expect(await within(editor).findByRole('textbox', { name: 'Values for host, item 1' })).toHaveValue('Host1');
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
      expect(playlist.spec.items).toEqual([
        { type: 'dashboard_by_uid', value: 'uid_1', variables: { host: ['Host1'] } },
        { type: 'dashboard_by_uid', value: 'uid_2', variables: { host: ['Host2'] } },
        { type: 'dashboard_by_tag', value: 'tag_A' },
      ]);
    });
  });

  describe('while a save is in flight', () => {
    it('disables Save, reports aria-busy, and restores the button when the save comes back failed', async () => {
      const { onSubmitMock, settleSubmit } = controlledSubmit();
      const { user } = renderWithSubmit(mockPlaylist, onSubmitMock);

      expect(saveAvailability()).toEqual({ ariaDisabled: 'false', nativeDisabled: false });
      expect(saveButton()).toHaveAttribute('aria-busy', 'false');

      await user.click(saveButton());

      await waitFor(() => {
        expect(saveAvailability()).toEqual({ ariaDisabled: 'true', nativeDisabled: false });
      });
      expect(saveButton()).toHaveAttribute('aria-busy', 'true');
      expect(onSubmitMock).toHaveBeenCalledTimes(1);

      // The pages report a failed save with an error notification and keep the user on the form, so
      // the promise `doSubmit` awaits settles with the form still mounted.
      settleSubmit();

      await waitFor(() => {
        expect(saveAvailability()).toEqual({ ariaDisabled: 'false', nativeDisabled: false });
      });
      expect(saveButton()).toHaveAttribute('aria-busy', 'false');

      // The retry is one click: nothing else has to be re-entered or re-focused first.
      await user.click(saveButton());
      expect(onSubmitMock).toHaveBeenCalledTimes(2);
    });

    it('submits once for a double-click on Save', async () => {
      const { onSubmitMock, settleSubmit } = controlledSubmit();
      const { user } = renderWithSubmit(mockPlaylist, onSubmitMock);

      await user.dblClick(saveButton());

      await waitFor(() => {
        expect(saveAvailability()).toEqual({ ariaDisabled: 'true', nativeDisabled: false });
      });
      expect(onSubmitMock).toHaveBeenCalledTimes(1);

      settleSubmit();
      await waitFor(() => {
        expect(saveAvailability()).toEqual({ ariaDisabled: 'false', nativeDisabled: false });
      });
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });

    it('submits once for three clicks on Save landing inside the same request', async () => {
      const { onSubmitMock, settleSubmit } = controlledSubmit();
      const { user } = renderWithSubmit(mockPlaylist, onSubmitMock);

      await user.click(saveButton());
      await user.click(saveButton());
      await user.click(saveButton());

      expect(onSubmitMock).toHaveBeenCalledTimes(1);

      settleSubmit();
      await waitFor(() => {
        expect(saveAvailability()).toEqual({ ariaDisabled: 'false', nativeDisabled: false });
      });
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('when leaving the editor', () => {
    it('lets a playlist that has not been edited go, including after its dashboards have loaded', async () => {
      stubDashboardEnrichment();
      renderInApp(playlistWithVariables());

      // The loaded dashboards are added to the same item objects the guard compares, so the
      // comparison is only proven correct once that enrichment has landed.
      expect(await screen.findByText('Dashboard uid_1')).toBeInTheDocument();
      // Both dashboard items of this playlist carry one variable, and both summaries survive the
      // enrichment; the guard compares the same maps.
      expect(screen.getAllByText('1 variable')).toHaveLength(2);
      expect(reloadIsBlocked()).toBe(false);

      await attemptNavigation('/dashboards');

      expect(currentPath()).toBe('/dashboards');
      expect(unsavedChangesModal()).not.toBeInTheDocument();
    });

    it('blocks the navigation and returns to the form when the name has been edited', async () => {
      const { user } = renderInApp(mockPlaylist);

      await user.type(screen.getByRole('textbox', { name: /name/i }), ' edited');

      await attemptNavigation('/dashboards');

      expect(await screen.findByRole('dialog', { name: 'Leave page?' })).toBeInTheDocument();
      expect(currentPath()).toBe('/');

      await user.click(screen.getByRole('button', { name: 'Continue editing' }));

      await waitFor(() => {
        expect(unsavedChangesModal()).not.toBeInTheDocument();
      });
      expect(currentPath()).toBe('/');
      expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('A test playlist edited');
    });

    it('lets the navigation through once the unsaved changes are discarded', async () => {
      const { user } = renderInApp(mockPlaylist);

      await user.type(screen.getByRole('textbox', { name: /name/i }), ' edited');

      await attemptNavigation('/dashboards');
      expect(await screen.findByRole('dialog', { name: 'Leave page?' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));

      await waitFor(() => {
        expect(currentPath()).toBe('/dashboards');
      });
      expect(unsavedChangesModal()).not.toBeInTheDocument();
    });

    it('blocks the navigation when a dashboard row has been added but nothing typed', async () => {
      const { user } = renderInApp(mockPlaylist);

      await user.click(dashboardPickerButton());
      await waitFor(() => {
        expect(rows()).toHaveLength(4);
      });

      await attemptNavigation('/dashboards');

      expect(await screen.findByRole('dialog', { name: 'Leave page?' })).toBeInTheDocument();
      expect(currentPath()).toBe('/');
    });

    it('blocks a reload only while there is unsaved input', async () => {
      const { user } = renderInApp(mockPlaylist);

      expect(reloadIsBlocked()).toBe(false);

      await user.type(screen.getByRole('textbox', { name: /name/i }), ' edited');

      expect(reloadIsBlocked()).toBe(true);
    });

    it('does not prompt when a successful save navigates away', async () => {
      // The pages await their create/replace call and only then push the list route, from inside the
      // `onSubmit` the form awaits — the one navigation the guard must never intercept.
      const onSubmitMock = jest.fn(async () => {
        locationService.push('/playlists');
      });
      const { user } = renderInApp(mockPlaylist, onSubmitMock);

      await user.type(screen.getByRole('textbox', { name: /name/i }), ' edited');
      await user.click(saveButton());

      await waitFor(() => {
        expect(currentPath()).toBe('/playlists');
      });
      expect(unsavedChangesModal()).not.toBeInTheDocument();
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('when adding an item by tag', () => {
    /**
     * The real "Add by tag" control, over the dashboard tag facets the form asks the searcher for.
     * `getGrafanaSearcher` is stubbed rather than the HTTP layer because the form reaches for the
     * searcher itself, and the facet counts are the point of these cases.
     */
    function withTagFacets(facets: TermCount[]) {
      mockRealTagFilter.enabled = true;
      jest.spyOn(searcherService, 'getGrafanaSearcher').mockReturnValue({
        tags: async () => facets,
      } as unknown as ReturnType<typeof searcherService.getGrafanaSearcher>);
    }

    async function openTagOptions(user: UserEvent) {
      // The mocked dashboard picker is a button, so the tag filter owns the only combobox here.
      await user.click(screen.getByRole('combobox'));
      return screen.findAllByRole('option');
    }

    afterEach(() => {
      mockRealTagFilter.enabled = false;
    });

    it('names each option after its own tag and the number of dashboards carrying it', async () => {
      withTagFacets([
        { term: 'qa-final', count: 2 },
        { term: 'qa-final-ui', count: 1 },
      ]);
      const { user } = getTestContext(mockEmptyPlaylist);

      const options = await openTagOptions(user);

      // Every option used to be named "Tag option", leaving these two indistinguishable to anything
      // that cannot see the badge.
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveAccessibleName('Tag option qa-final (2)');
      expect(options[1]).toHaveAccessibleName('Tag option qa-final-ui (1)');
      expect(new Set(options.map((option) => option.getAttribute('aria-label'))).size).toBe(2);
    });

    it('names an option whose count the badge hides by its tag alone', async () => {
      withTagFacets([{ term: 'no-count', count: 0 }]);
      const { user } = getTestContext(mockEmptyPlaylist);

      const [option] = await openTagOptions(user);

      expect(option).toHaveAccessibleName('Tag option no-count');
    });

    it('keeps a tag name that would otherwise be escaped readable in the name', async () => {
      withTagFacets([{ term: 'r&d "core"', count: 3 }]);
      const { user } = getTestContext(mockEmptyPlaylist);

      const [option] = await openTagOptions(user);

      // The name is set as an attribute value, never parsed as HTML, so i18next's default escaping
      // would only turn the tag into entities where it is announced.
      expect(option).toHaveAccessibleName('Tag option r&d "core" (3)');
    });

    it('still adds the picked tag as an item', async () => {
      withTagFacets([{ term: 'qa-final', count: 2 }]);
      const { onSubmitMock, user } = getTestContext(mockEmptyPlaylist);

      const [option] = await openTagOptions(user);
      await user.click(option);

      await waitFor(() => {
        expect(rows()).toHaveLength(1);
      });
      expectCorrectRow({ index: 0, type: 'dashboard_by_tag', value: 'qa-final' });

      await user.click(saveButton());
      await waitFor(() => expect(onSubmitMock).toHaveBeenCalledTimes(1));
      expect(firstSubmittedPlaylist(onSubmitMock).spec?.items).toEqual([
        { type: 'dashboard_by_tag', value: 'qa-final' },
      ]);
    });
  });

  describe('what the Save control reports and what it refuses', () => {
    it('never carries the native disabled attribute, in any state it presents', async () => {
      const { user } = getTestContext(mockEmptyPlaylist);

      // Unavailable for want of an item.
      expect(saveAvailability()).toEqual({ ariaDisabled: 'true', nativeDisabled: false });

      // Available: one item and valid fields.
      await user.click(dashboardPickerButton());
      await waitFor(() => {
        expect(saveAvailability()).toEqual({ ariaDisabled: 'false', nativeDisabled: false });
      });

      // Unavailable for an invalid field. The native attribute is what used to appear here beside
      // `aria-disabled="false"`, which is the contradiction the finding measured.
      await user.clear(nameField());
      await user.tab();
      await waitFor(() => {
        expect(saveAvailability()).toEqual({ ariaDisabled: 'true', nativeDisabled: false });
      });
    });

    it('carries the reason it is unavailable, reachable by pointer and by keyboard', async () => {
      const { user } = getTestContext(mockEmptyPlaylist);

      // Focusable and hoverable is the point of reporting `aria-disabled` instead: the reason is on
      // the control rather than something to deduce from a dead button.
      await user.hover(saveButton());
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Add at least one dashboard before saving');

      await user.unhover(saveButton());
      saveButton().focus();
      expect(saveButton()).toHaveFocus();
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Add at least one dashboard before saving');
      // The tooltip describes the control while it is open, so the reason is announced with it.
      expect(saveButton()).toHaveAccessibleDescription('Add at least one dashboard before saving');
    });

    it('refuses a submit that reaches the form while Save presents as unavailable', async () => {
      const { onSubmitMock } = getTestContext(mockEmptyPlaylist);

      // Save is this form's submit control and no longer carries the native attribute, so pressing
      // Enter in a field now reaches the form's own submit. Nothing may be written by it.
      submitForm();

      await waitFor(() => {
        expect(saveLiveRegion()).toHaveTextContent('Add at least one dashboard before saving');
      });
      expect(onSubmitMock).not.toHaveBeenCalled();
      expect(rows).toThrow();
    });

    it('refuses a save while a variable is half-entered, moves focus to the field and announces it', async () => {
      const { onSubmitMock, user } = getTestContext(playlistWithVariables());
      const editor = await openVariableEditor(user, 0);

      // A name with no values: a draft the editor cannot add, which used to leave Save enabled and
      // then swallow the click — nothing was saved and nothing said so.
      await user.type(newVariableName(editor), 'cluster');
      await user.click(saveButton());

      expect(onSubmitMock).not.toHaveBeenCalled();
      expect(saveLiveRegion()).toHaveTextContent('Playlist not saved.');
      expect(newVariableValues(editor)).toHaveFocus();
      expect(newVariableValues(editor)).toHaveAccessibleDescription('Variable value is required');
      // The draft is still there to be corrected rather than discarded.
      expect(newVariableName(editor)).toHaveValue('cluster');

      // A second attempt is announced again: identical text left in the same node is not a change a
      // live region reports, so the announcement is a new node each time.
      const firstAnnouncement = saveLiveRegion().firstElementChild;
      await user.click(saveButton());
      expect(saveLiveRegion().firstElementChild).not.toBe(firstAnnouncement);
      expect(saveLiveRegion()).toHaveTextContent('Playlist not saved.');
      expect(onSubmitMock).not.toHaveBeenCalled();

      // And the refusal is not a dead end: completing the draft saves it with the playlist.
      await user.type(newVariableValues(editor), 'eu');
      await user.click(saveButton());
      await waitFor(() => expect(onSubmitMock).toHaveBeenCalledTimes(1));
      expect(firstSubmittedPlaylist(onSubmitMock).spec?.items?.[0]).toEqual({
        type: 'dashboard_by_uid',
        value: 'uid_1',
        variables: { cluster: ['eu'], host: ['Host1'] },
      });
    });
  });

  describe('the size of the form controls', () => {
    it('offers Save and Cancel a 44 px box without changing their labels', () => {
      getTestContext();

      for (const control of [saveButton(), cancelButton()]) {
        const { minWidth, minHeight, fontSize } = window.getComputedStyle(control);
        expect({ label: control.textContent, minWidth, minHeight }).toEqual({
          label: control.textContent,
          minWidth: '44px',
          minHeight: '44px',
        });
        // The box is the whole change: a control grown by scaling its text is a different control,
        // so both keep the type size `Button` gives a `size="md"` control.
        expect(fontSize).toBe(config.theme2.typography.size.md);
      }
    });
  });

  describe('the contrast of the form controls', () => {
    it('keeps the Save label above 4.5:1 on every state a pointer or the keyboard can reach', () => {
      getTestContext();
      const { colors } = config.theme2;
      const fills = guardedStateFills(saveButton());

      // Every reachable state has to be covered: `Button` paints hover and focus with the lighter
      // `primary.shade`, which carried white text at 3.55:1, and leaves `:active` on `primary.main`.
      expect(Object.keys(fills).sort()).toEqual([...REACHABLE_STATES].sort());

      for (const state of REACHABLE_STATES) {
        const background = fills[state] ?? '';
        const ratio = colorManipulator.getContrastRatio(colors.primary.contrastText, background);
        // The state is carried into the assertion so a failure names the state that fell short
        // rather than reporting a bare `false`.
        expect({ state, meetsContrastMinimum: ratio >= 4.5 }).toEqual({ state, meetsContrastMinimum: true });
        // A state that reads exactly like the rest state would meet the ratio by removing the
        // feedback instead of fixing it, so each fill also has to differ from the resting one.
        expect({ state, fill: colorManipulator.asHexString(background) }).not.toEqual({
          state,
          fill: colorManipulator.asHexString(colors.primary.main),
        });
      }
    });

    it('leaves the Cancel link on the secondary fills, which already clear 4.5:1 in every state', () => {
      getTestContext();

      // Recorded rather than changed: `secondary.main` and `secondary.shade` carry
      // `secondary.contrastText` at 8.49:1 and 7.04:1 on the dark theme, so the control the finding
      // asked about needs no override — and an override here would be an unexplained visual change.
      expect(guardedStateFills(cancelButton())).toEqual({});
      const { colors } = config.theme2;
      for (const background of [colors.secondary.main, colors.secondary.shade]) {
        expect(colorManipulator.getContrastRatio(colors.secondary.contrastText, background)).toBeGreaterThanOrEqual(
          4.5
        );
      }
    });
  });
});

interface ExpectCorrectRowArgs {
  index: number;
  type: 'dashboard_by_tag' | 'dashboard_by_uid';
  value: string;
  /** The variable summary the row's name ends with, for an item that carries variables. */
  variables?: string;
}

function expectCorrectRow({ index, type, value, variables }: ExpectCorrectRowArgs) {
  const name = `Playlist item, ${type}, ${value}${variables === undefined ? '' : `, ${variables}`}`;
  expect(rows()[index]).toHaveAccessibleName(name);
}
