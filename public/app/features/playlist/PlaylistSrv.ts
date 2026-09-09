import { type Action, type Location } from 'history';
import { pickBy } from 'lodash';

import { AppEvents, locationUtil, urlUtil, rangeUtil, type UrlQueryValue } from '@grafana/data';
import { t } from '@grafana/i18n';
import { locationService, logWarning } from '@grafana/runtime';
import { appEvents } from 'app/core/app_events';
import { StateManagerBase } from 'app/core/services/StateManagerBase';

import { type Playlist } from '../../api/clients/playlist/v1';

import { loadDashboards } from './utils';
import { boundedItemVariables, hasItemVariables } from './variableLimits';

const queryParamsToPreserve: { [key: string]: boolean } = {
  kiosk: true,
  autofitpanels: true,
  orgId: true,
  hideLogo: true,
  '_dash.hideTimePicker': true,
  '_dash.hideVariables': true,
  '_dash.hideLinks': true,
  '_dash.hidePlaylistNav': true,
};

export interface PlaylistSrvState {
  isPlaying: boolean;
}

interface PlaylistUrlEntry {
  url: string;
  variables?: Record<string, string[]>;
}

interface UrlQueryParam {
  name: string;
  value: UrlQueryValue;
}

/**
 * Why a playlist could not be played, in the terms the viewer can act on.
 *
 * `no-items` is a playlist that holds no dashboards at all; `no-dashboards` is one whose items
 * resolve to nothing — every dashboard it names has been deleted, or none is visible to this
 * viewer, or a tag matches no dashboard.
 */
export type PlaylistStartFailureReason = 'no-items' | 'no-dashboards';

/** The outcome of a start attempt: either playback is running, or here is why it is not. */
export interface PlaylistStartResult {
  started: boolean;
  failureReason?: PlaylistStartFailureReason;
}

/**
 * Appends one query parameter per value, so a value list is written as a repeated key.
 *
 * Given a map, the serializer decomposes a value whose `String()` is `[object Object]` into indexed
 * parameters, and that string is a legal variable value. A flat name/value list is encoded and
 * emitted verbatim instead, one parameter per value.
 */
function appendParam(params: UrlQueryParam[], name: string, value: UrlQueryValue) {
  if (Array.isArray(value)) {
    for (const single of value) {
      params.push({ name, value: single });
    }
    return;
  }

  params.push({ name, value });
}

/**
 * The parameters of the current location that a playlist carries from one item to the next,
 * flattened to one entry per value.
 *
 * They are read from the live location every time rather than from anything captured when playback
 * began, so an option the viewer changes mid-playback — leaving kiosk mode, above all — is honoured
 * by every URL the playlist writes afterwards, including the one the periodic reload navigates to.
 */
function preservedSearchParams(): UrlQueryParam[] {
  const queryParams = locationService.getSearchObject();
  const filteredParams = pickBy(queryParams, (value: unknown, key: string) => queryParamsToPreserve[key]);

  const params: UrlQueryParam[] = [];
  for (const [name, value] of Object.entries(filteredParams)) {
    appendParam(params, name, value);
  }

  return params;
}

export class PlaylistSrv extends StateManagerBase<PlaylistSrvState> {
  private nextTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private entries: PlaylistUrlEntry[] = [];
  private index = 0;
  declare private interval: number;
  declare private startUrl: string;
  private numberOfLoops = 0;
  declare private validPlaylistUrl: string;
  private locationListenerUnsub?: () => void;

  public constructor() {
    super({ isPlaying: false });

    this.locationUpdated = this.locationUpdated.bind(this);
  }

  private navigateToDashboard(replaceHistoryEntry = false) {
    const entry = this.entries[this.index];
    const nextDashboardUrl = locationUtil.stripBaseFromUrl(entry.url);

    this.index++;
    this.validPlaylistUrl = nextDashboardUrl;
    this.nextTimeoutId = setTimeout(() => this.next(), this.interval);

    const params = preservedSearchParams();

    // A playlist is stored data, so its variables are untrusted: the budget bounds how much is
    // expanded into this one history entry. Pairs that exceed it are left out rather than
    // truncated, and playback continues with the rest. The budget measures a pair as one
    // `var-<name>=<value>` parameter per value, which is exactly what the flat list emits for the
    // string values it admits, so the measurement stays character for character the pushed query.
    const { pairs, dropped, uninspected } = boundedItemVariables(entry.variables);
    for (const [name, values] of pairs) {
      appendParam(params, `var-${name}`, values);
    }

    if (dropped > 0 || uninspected) {
      // Counts and one flag: a variable name or value is exactly the untrusted content this
      // warning must not carry into telemetry. `variablesLeftUninspected` is what keeps the two
      // counts honest — the walk stops at the item's variable maximum, so a map holding more than
      // that has keys the counts above never saw and cannot speak for.
      logWarning('Playlist item variables exceeded the supported limits and were not applied', {
        droppedVariables: String(dropped),
        appliedVariables: String(pairs.length),
        variablesLeftUninspected: String(uninspected),
      });
    }

    const urlWithParams = nextDashboardUrl + '?' + urlUtil.toUrlParams(params);

    if (replaceHistoryEntry) {
      locationService.getHistory().replace(urlWithParams);
    } else {
      locationService.push(urlWithParams);
    }
  }

  /**
   * The URL the periodic reload navigates to: the location playback was started from, carrying the
   * playback options of the live URL rather than the ones it was started with.
   *
   * The path comes from the captured absolute href, so the origin and any sub-path Grafana is
   * served under survive the assignment to `window.location.href`. Only the query is rebuilt, and
   * that is the point: replaying the captured one re-applied `kiosk` after the viewer had pressed
   * Escape to leave kiosk mode, hiding the Stop control again every third loop.
   */
  private reloadUrl(): string {
    const [startLocation] = this.startUrl.split('#');
    const [startPath] = startLocation.split('?');
    const search = urlUtil.toUrlParams(preservedSearchParams());

    return search ? `${startPath}?${search}` : startPath;
  }

  next() {
    clearTimeout(this.nextTimeoutId);

    // Nothing to advance to when no item resolved to a dashboard. start() leaves such a playlist
    // stopped, so this guards only a control or a timer that outlived a playlist which did play.
    if (!this.entries.length) {
      return;
    }

    const playedAllDashboards = this.index > this.entries.length - 1;
    if (playedAllDashboards) {
      this.numberOfLoops++;

      // This does full reload of the playlist to keep memory in check due to existing leaks but at the same time
      // we do not want page to flicker after each full loop.
      if (this.numberOfLoops >= 3) {
        window.location.href = this.reloadUrl();
        return;
      }
      this.index = 0;
    }

    this.navigateToDashboard();
  }

  prev() {
    if (!this.entries.length) {
      return;
    }

    // The index already points past the item on screen, so the one before it is two back. Going
    // back from the first item wraps to the last, mirroring next()'s wrap to the first, so the
    // control always moves the playlist instead of silently re-showing the item being watched. The
    // wrap lands on the last index rather than past it, so going backwards never completes a loop
    // and never triggers the reload above.
    const previousIndex = this.index - 2;
    this.index = previousIndex < 0 ? this.entries.length - 1 : previousIndex;

    this.next();
  }

  locationUpdated(location: Location, action: Action) {
    // A POP is the browser's own back or forward button: the viewer has left the history entry the
    // playlist is playing in, and that ends playback wherever they land — including on another
    // item's entry for the same dashboard, which the pathname comparison cannot see and which used
    // to leave the playlist running with nothing to show that the button had done anything.
    if (action === 'POP' || location.pathname !== this.validPlaylistUrl) {
      this.stopBecauseOfNavigation();
    }
  }

  /**
   * Ends playback that a navigation, rather than the Stop control, brought to an end, and says so.
   *
   * Stopping silently is what made navigating during playback unexplainable: the playlist controls
   * simply disappeared from the toolbar. The notification goes onto the bus the application's own
   * toasts are read from, so it needs no page of its own and reaches the viewer wherever the
   * navigation left them.
   */
  private stopBecauseOfNavigation() {
    if (!this.state.isPlaying) {
      return;
    }

    this.stop();

    appEvents.publish({
      type: AppEvents.alertInfo.name,
      payload: [
        t('playlist.playlist-srv.stopped-navigation-title', 'Playlist stopped'),
        t(
          'playlist.playlist-srv.stopped-navigation-body',
          'Navigating away from a playlist dashboard ends the playlist.'
        ),
      ],
    });
  }

  /**
   * Starts playing `playlist`, and reports whether it could be played at all.
   *
   * A playlist that holds no dashboards, or none that resolve to anything this viewer can open,
   * leaves playback stopped and returns the reason. The caller is a page that can name the problem
   * and offer a way out of it, which is the only thing the viewer can act on; marking such a
   * playlist as playing left that page blank, with the toolbar's playback controls hidden behind a
   * dashboard that was never going to arrive.
   */
  async start(playlist: Playlist): Promise<PlaylistStartResult> {
    this.stop();

    this.startUrl = window.location.href;
    this.index = 0;
    // Nothing from a previous playlist may survive a start that fails below.
    this.entries = [];

    if (!playlist.spec?.items?.length) {
      return { started: false, failureReason: 'no-items' };
    }

    this.interval = rangeUtil.intervalToMs(playlist.spec?.interval);

    const entries: PlaylistUrlEntry[] = [];
    const items = await loadDashboards(playlist.spec?.items);
    for (const item of items) {
      // Variable values address a single dashboard, so only items selected by uid carry them.
      // `hasItemVariables` returns at the first own key: whether a map is empty is a yes or no,
      // and `Object.keys(...).length` would answer it by allocating an array of every name a
      // stored map holds.
      const variables =
        item.type === 'dashboard_by_uid' && hasItemVariables(item.variables) ? item.variables : undefined;

      if (item.dashboards) {
        for (const dash of item.dashboards) {
          entries.push({ url: dash.url, variables });
        }
      }
    }

    if (!entries.length) {
      return { started: false, failureReason: 'no-dashboards' };
    }

    this.entries = entries;
    this.setState({ isPlaying: true });

    // Subscribed only once there is something to play, so a failed start leaves no listener behind.
    this.locationListenerUnsub = locationService.getHistory().listen(this.locationUpdated);

    // Replace current history entry with first dashboard instead of pushing
    // this is to avoid the back button to go back to the playlist start page which causes a redirection
    this.navigateToDashboard(true);

    return { started: true };
  }

  stop() {
    if (!this.state.isPlaying) {
      return;
    }

    this.index = 0;

    this.setState({ isPlaying: false });

    if (this.locationListenerUnsub) {
      this.locationListenerUnsub();
    }

    if (this.nextTimeoutId) {
      clearTimeout(this.nextTimeoutId);
    }

    if (locationService.getSearchObject().kiosk) {
      locationService.partial({ kiosk: null });
    }
  }
}

export const playlistSrv = new PlaylistSrv();
