import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { of, throwError } from 'rxjs';
import { TestProvider } from 'test/helpers/TestProvider';

import { locationService } from '@grafana/runtime';
import { backendSrv } from 'app/core/services/backend_srv';
import { useResourceRepositorySelection } from 'app/features/provisioning/hooks/useResourceRepositorySelection';
import { configureStore } from 'app/store/configureStore';
import { AppNotificationSeverity } from 'app/types/appNotifications';

import { createFetchResponse } from '../../../test/helpers/createFetchResponse';
import { getPlaylistErrorMessage } from '../../api/clients/playlist/v1';

import { PlaylistEditPage } from './PlaylistEditPage';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => backendSrv,
}));

jest.mock('app/core/components/TagFilter/TagFilter', () => ({
  TagFilter: () => {
    return <>mocked-tag-filter</>;
  },
}));

jest.mock('app/features/provisioning/hooks/useResourceRepositorySelection');
const mockUseResourceRepositorySelection = useResourceRepositorySelection as jest.MockedFunction<
  typeof useResourceRepositorySelection
>;

/**
 * The shape `createBaseQuery` hands to RTK Query when a playlist request fails: a Grafana
 * `FetchError` carrying the apiserver's `Status` body and the request `config`. The `config` is
 * reproduced in full — headers included — because the load-error assertions below are about that
 * object never reaching the page.
 */
function playlistFetchError(status: number, statusText: string, reason: string, message: string, method: string) {
  return {
    status,
    statusText,
    data: {
      kind: 'Status',
      apiVersion: 'v1',
      metadata: {},
      status: 'Failure',
      message,
      reason,
      details: { name: 'foo', group: 'playlist.grafana.app', kind: 'playlists' },
      code: status,
    },
    config: {
      url: 'apis/playlist.grafana.app/v1/namespaces/default/playlists/foo',
      method,
      showErrorAlert: false,
      retry: 0,
      hideFromInspector: false,
      headers: {
        'X-Grafana-Org-Id': '1',
        'X-Grafana-Device-Id': '574b4522668e9454ab724da7cbbb172d',
      },
    },
  };
}

/** The real 409 a save over a concurrently edited playlist returns, apiserver wording and all. */
const conflictError = playlistFetchError(
  409,
  'Conflict',
  'Conflict',
  'Operation cannot be fulfilled on playlists.playlist.grafana.app "foo": the object has been modified; please apply your changes to the latest version and try again',
  'PUT'
);

/** Which requests fail, and with what. Anything not listed here answers with the playlist. */
interface FailedRequests {
  /** Fails the initial load, i.e. every request the page makes other than the save. */
  get?: ReturnType<typeof playlistFetchError>;
  /** Fails the save. */
  put?: ReturnType<typeof playlistFetchError>;
}

async function getTestContext(
  annotations?: Record<string, string>,
  provisioning: ReturnType<typeof useResourceRepositorySelection> = { isAvailable: false, repositories: [] },
  failedRequests: FailedRequests = {}
) {
  jest.clearAllMocks();
  mockUseResourceRepositorySelection.mockReturnValue(provisioning);

  // Narrowed outside the mock: a property access is not narrowed inside a callback.
  const getError = failedRequests.get;
  const putError = failedRequests.put;

  const backendSrvMock = jest.spyOn(backendSrv, 'fetch').mockImplementation((options) => {
    if (putError && options.method === 'PUT') {
      return throwError(() => putError);
    }
    if (getError && options.method !== 'PUT') {
      return throwError(() => getError);
    }

    return of(
      createFetchResponse({
        apiVersion: 'playlist.grafana.app/v0alpha1',
        kind: 'Playlist',
        spec: {
          title: 'Test Playlist',
          interval: '5s',
          items: [{ title: 'First item', type: 'dashboard_by_uid', order: 1, value: '1' }],
        },
        metadata: {
          name: 'foo',
          ...(annotations ? { annotations } : {}),
        },
      })
    );
  });

  // The store is created here rather than inside `TestProvider` so a test can read what the page
  // put in it — the error notification is the only place a failed save speaks to the user.
  const store = configureStore();
  const { rerender } = render(
    <TestProvider store={store}>
      <PlaylistEditPage />
    </TestProvider>
  );
  return { rerender, backendSrvMock, store };
}

/** The error toasts the page raised, in the order they were dispatched. */
function errorNotifications(store: ReturnType<typeof configureStore>) {
  return Object.values(store.getState().appNotifications.byId).filter(
    (notification) => notification.severity === AppNotificationSeverity.Error
  );
}

describe('PlaylistEditPage', () => {
  describe('when mounted', () => {
    it('then it should load playlist and header should be correct', async () => {
      await getTestContext();

      expect(await screen.findByRole('heading', { name: /edit playlist/i })).toBeInTheDocument();
      expect(await screen.findByRole('textbox', { name: /name/i })).toHaveValue('Test Playlist');
      expect(screen.getByRole('textbox', { name: /interval/i })).toHaveValue('5s');
      // The item rows are the list items of the playlist's item list: they own their controls and,
      // while a row is expanded, its variables editor, which a `role="row"` may not own and which
      // no table on this page could contain.
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });

    it('then it should not render the provisioned badge for an unmanaged playlist', async () => {
      await getTestContext();

      expect(await screen.findByRole('heading', { name: /edit playlist/i })).toBeInTheDocument();
      expect(screen.queryByTestId('icon-exchange-alt')).not.toBeInTheDocument();
    });

    it('then it should render the provisioned badge for a managed playlist', async () => {
      await getTestContext({
        'grafana.app/managedBy': 'repo',
        'grafana.app/managerId': 'foo-repo',
      });

      expect(await screen.findByRole('heading', { name: /edit playlist/i })).toBeInTheDocument();
      expect(await screen.findByTestId('icon-exchange-alt')).toBeInTheDocument();
    });
  });

  describe('when the load fails', () => {
    /**
     * Everything the failed load used to put on the page by serializing the error object. Any one
     * of these appearing again means the request — its URL, its method or its headers — is being
     * shown to whoever is looking at the screen.
     */
    const requestInternals = [
      'X-Grafana-Device-Id',
      '574b4522668e9454ab724da7cbbb172d',
      'X-Grafana-Org-Id',
      'showErrorAlert',
      'hideFromInspector',
      'config',
      'statusText',
      'apis/playlist.grafana.app',
    ];

    function expectNoRequestInternalsOnScreen() {
      const pageText = document.body.textContent ?? '';
      for (const internal of requestInternals) {
        expect(pageText).not.toContain(internal);
      }
    }

    it('then a missing playlist should be explained without leaking the request', async () => {
      await getTestContext(undefined, undefined, {
        get: playlistFetchError(404, 'Not Found', 'NotFound', 'playlists.playlist.grafana.app "foo" not found', 'GET'),
      });

      const alert = await screen.findByRole('alert', { name: 'Error loading playlist' });
      expect(alert).toHaveTextContent('This playlist no longer exists. It may have been deleted.');
      // Not even the backend's own wording here: it names the internal resource.
      expect(document.body.textContent).not.toContain('playlists.playlist.grafana.app');
      expectNoRequestInternalsOnScreen();
      // There is no editor to preserve when the load failed, so the alert is the whole page body.
      expect(screen.queryByRole('textbox', { name: /name/i })).not.toBeInTheDocument();
    });

    it('then a forbidden playlist should be explained without leaking the request', async () => {
      await getTestContext(undefined, undefined, {
        get: playlistFetchError(
          403,
          'Forbidden',
          'Forbidden',
          'playlists.playlist.grafana.app "foo" is forbidden: user is not allowed to get resource',
          'GET'
        ),
      });

      const alert = await screen.findByRole('alert', { name: 'Error loading playlist' });
      expect(alert).toHaveTextContent('You do not have permission to view or change this playlist.');
      expect(document.body.textContent).not.toContain('playlists.playlist.grafana.app');
      expectNoRequestInternalsOnScreen();
    });

    it('then a conflict should be described without naming the internal resource', async () => {
      // The apiserver reports a conflict by naming its own resource —
      // `playlists.playlist.grafana.app "foo"` — an identifier the user never chose and cannot act
      // on. This is the mapping the page's messages come from, asserted on the `FetchError` shape
      // a failed request carries.
      expect(getPlaylistErrorMessage(conflictError)).toBe(
        'This playlist was changed somewhere else. Reload the page and apply your changes to the latest version.'
      );
      expect(getPlaylistErrorMessage(conflictError)).not.toContain('playlists.playlist.grafana.app');
    });

    it('then an unrecognised failure should show the backend message and nothing else', async () => {
      await getTestContext(undefined, undefined, {
        get: playlistFetchError(500, 'Internal Server Error', 'InternalError', 'failed to read playlist', 'GET'),
      });

      const alert = await screen.findByRole('alert', { name: 'Error loading playlist' });
      // The apiserver's own message is the only detail carried through, and it is already written
      // for a person; the object that carried it is not rendered.
      expect(alert).toHaveTextContent('failed to read playlist');
      expect(document.body.textContent).not.toContain('Failure');
      expect(document.body.textContent).not.toContain('500');
      expectNoRequestInternalsOnScreen();
    });
  });

  describe('when submitted', () => {
    it('then correct api should be called', async () => {
      const { backendSrvMock } = await getTestContext();

      expect(await screen.findByRole('heading', { name: /edit playlist/i })).toBeInTheDocument();
      expect(locationService.getLocation().pathname).toEqual('/');
      await userEvent.clear(await screen.findByRole('textbox', { name: /name/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'A Name');
      await userEvent.clear(await screen.findByRole('textbox', { name: /interval/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /interval/i }), '10s');
      fireEvent.submit(screen.getByRole('button', { name: /save/i }));
      await waitFor(() =>
        expect(backendSrvMock).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              spec: {
                title: 'A Name',
                interval: '10s',
                items: [{ title: 'First item', type: 'dashboard_by_uid', order: 1, value: '1' }],
              },
              metadata: {
                name: 'foo',
              },
            }),
            method: 'PUT',
          })
        )
      );
      expect(locationService.getLocation().pathname).toEqual('/playlists');
    });

    it('then a failed save should stay on the form with the edit intact', async () => {
      // A 409 from a playlist someone else saved first is the failure a user actually meets. The
      // save used to be fired and abandoned, so the page navigated away — losing the edit — before
      // the conflict was even reported.
      locationService.push('/playlists/edit/foo');
      const { backendSrvMock } = await getTestContext(undefined, undefined, { put: conflictError });

      expect(await screen.findByRole('heading', { name: /edit playlist/i })).toBeInTheDocument();
      await userEvent.clear(await screen.findByRole('textbox', { name: /name/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'An edit worth keeping');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(backendSrvMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'PUT' })));

      expect(locationService.getLocation().pathname).toEqual('/playlists/edit/foo');
      expect(screen.getByRole('textbox', { name: /name/i })).toHaveValue('An edit worth keeping');
      // The one item row the playlist loaded with is still there, and it is a `listitem` of the
      // item list — the rows are no longer a table, so `role="row"` would find nothing.
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
      expect(await screen.findByRole('button', { name: /save/i })).toBeEnabled();
    });

    it('then a save conflict should raise exactly one error notification', async () => {
      const { backendSrvMock, store } = await getTestContext(undefined, undefined, { put: conflictError });

      expect(await screen.findByRole('heading', { name: /edit playlist/i })).toBeInTheDocument();
      await userEvent.clear(await screen.findByRole('textbox', { name: /name/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'A stale edit');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(backendSrvMock).toHaveBeenCalledWith(expect.objectContaining({ method: 'PUT' })));

      // The toast is the whole of what a failed save says to the user, so there is exactly one of
      // it and it is an error — the page adds no second surface, and reports no false success.
      await waitFor(() => expect(errorNotifications(store)).toHaveLength(1));
      expect(errorNotifications(store)[0].title).toBe('Unable to update playlist');
      // And its detail is the mapped sentence, not the apiserver's own message. A mutation rejects
      // with RTK Query's `{ error }` wrapper rather than the request failure itself, so this also
      // pins that the mapping unwraps it — without that, the raw internal resource name is what the
      // user reads.
      expect(errorNotifications(store)[0].text).toBe(
        'This playlist was changed somewhere else. Reload the page and apply your changes to the latest version.'
      );
      expect(errorNotifications(store)[0].text).not.toContain('playlists.playlist.grafana.app');
    });

    it('opens the provisioning save drawer for a repository-managed playlist instead of calling the API', async () => {
      const { backendSrvMock } = await getTestContext({
        'grafana.app/managedBy': 'repo',
        'grafana.app/managerId': 'test-repo',
        'grafana.app/sourcePath': 'playlists/foo.json',
      });

      expect(await screen.findByRole('heading', { name: /edit playlist/i })).toBeInTheDocument();
      const saveButton = await screen.findByRole('button', { name: /save/i });
      backendSrvMock.mockClear();

      fireEvent.submit(saveButton);

      // The provisioning save drawer opens...
      expect(await screen.findByRole('heading', { name: /save provisioned playlist/i })).toBeInTheDocument();
      // ...and the playlist replace API is not called.
      expect(backendSrvMock).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'PUT' }));
    });
  });

  describe('repository field', () => {
    const repositories = [
      { name: 'test-repo', title: 'Test Repository', target: 'instance' as const, type: 'git' as const, workflows: [] },
    ];

    it('shows the (read-only) repository field for a repository-managed playlist', async () => {
      await getTestContext(
        {
          'grafana.app/managedBy': 'repo',
          'grafana.app/managerId': 'test-repo',
          'grafana.app/sourcePath': 'playlists/foo.json',
        },
        { isAvailable: true, repositories }
      );

      expect(await screen.findByText('Repository')).toBeInTheDocument();
    });

    it('does not show the repository field for an unmanaged playlist stored in Grafana', async () => {
      await getTestContext(undefined, { isAvailable: true, repositories });

      expect(await screen.findByRole('heading', { name: /edit playlist/i })).toBeInTheDocument();
      expect(screen.queryByText('Repository')).not.toBeInTheDocument();
    });
  });
});
