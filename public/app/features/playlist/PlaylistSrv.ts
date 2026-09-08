import { type Location } from 'history';
import { pickBy } from 'lodash';

import { locationUtil, urlUtil, rangeUtil, type UrlQueryValue } from '@grafana/data';
import { locationService, logWarning } from '@grafana/runtime';
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
    const queryParams = locationService.getSearchObject();
    const filteredParams = pickBy(queryParams, (value: unknown, key: string) => queryParamsToPreserve[key]);
    const nextDashboardUrl = locationUtil.stripBaseFromUrl(entry.url);

    this.index++;
    this.validPlaylistUrl = nextDashboardUrl;
    this.nextTimeoutId = setTimeout(() => this.next(), this.interval);

    // Given a map, the serializer decomposes a value whose `String()` is `[object Object]` into indexed
    // parameters, and that string is a legal variable value. A flat name/value list is encoded and
    // emitted verbatim instead, one parameter per value.
    const params: UrlQueryParam[] = [];
    const addParam = (name: string, value: UrlQueryValue) => {
      if (Array.isArray(value)) {
        for (const single of value) {
          params.push({ name, value: single });
        }
        return;
      }
      params.push({ name, value });
    };

    for (const [name, value] of Object.entries(filteredParams)) {
      addParam(name, value);
    }

    // A playlist is stored data, so its variables are untrusted: the budget bounds how much is
    // expanded into this one history entry. Pairs that exceed it are left out rather than
    // truncated, and playback continues with the rest. The budget measures a pair as one
    // `var-<name>=<value>` parameter per value, which is exactly what the flat list emits for the
    // string values it admits, so the measurement stays character for character the pushed query.
    const { pairs, dropped, uninspected } = boundedItemVariables(entry.variables);
    for (const [name, values] of pairs) {
      addParam(`var-${name}`, values);
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

  next() {
    clearTimeout(this.nextTimeoutId);

    const playedAllDashboards = this.index > this.entries.length - 1;
    if (playedAllDashboards) {
      this.numberOfLoops++;

      // This does full reload of the playlist to keep memory in check due to existing leaks but at the same time
      // we do not want page to flicker after each full loop.
      if (this.numberOfLoops >= 3) {
        window.location.href = this.startUrl;
        return;
      }
      this.index = 0;
    }

    this.navigateToDashboard();
  }

  prev() {
    this.index = Math.max(this.index - 2, 0);
    this.next();
  }

  locationUpdated(location: Location) {
    if (location.pathname !== this.validPlaylistUrl) {
      this.stop();
    }
  }

  async start(playlist: Playlist) {
    this.stop();

    this.startUrl = window.location.href;
    this.index = 0;

    this.setState({ isPlaying: true });

    this.locationListenerUnsub = locationService.getHistory().listen(this.locationUpdated);
    const entries: PlaylistUrlEntry[] = [];

    if (!playlist.spec?.items?.length) {
      return;
    }

    this.interval = rangeUtil.intervalToMs(playlist.spec?.interval);

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
      return;
    }

    this.entries = entries;
    this.setState({ isPlaying: true });

    // Replace current history entry with first dashboard instead of pushing
    // this is to avoid the back button to go back to the playlist start page which causes a redirection
    this.navigateToDashboard(true);
    return;
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
