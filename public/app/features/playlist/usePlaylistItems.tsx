import { useCallback, useState } from 'react';
import { useAsync } from 'react-use';

import { type DashboardPickerDTO } from 'app/core/components/Select/DashboardPicker';

import { type PlaylistItemUI } from './types';
import { loadDashboards } from './utils';

export function usePlaylistItems(playlistItems?: PlaylistItemUI[]) {
  const [items, setItems] = useState<PlaylistItemUI[]>(playlistItems ?? []);

  useAsync(async () => {
    for (const item of items) {
      if (!item.dashboards) {
        const loaded = await loadDashboards(items);
        // Merge into the latest state instead of replacing it with the snapshot taken before
        // the await, which would discard any edit made while the search was in flight.
        // `loadDashboards` derives an item's dashboards from its type and value alone, so
        // matching on that pair attaches the right result to each item, even when the same
        // dashboard is listed more than once. Every other property is left untouched.
        setItems((prev) => {
          let merged = false;
          const next = prev.map((prevItem) => {
            const match = loaded.find(
              (loadedItem) => loadedItem.type === prevItem.type && loadedItem.value === prevItem.value
            );
            if (!match) {
              return prevItem;
            }
            merged = true;
            return { ...prevItem, dashboards: match.dashboards };
          });
          // A load that resolves after the items it described are gone matches nothing. Returning
          // the same array leaves the state identity untouched, so this effect — which depends on
          // `items` — is not re-run by an update that changed nothing.
          return merged ? next : prev;
        });
        return;
      }
    }
  }, [items]);

  const addByUID = useCallback(
    (dashboard?: DashboardPickerDTO) => {
      if (!dashboard) {
        return;
      }

      setItems([
        ...items,
        {
          type: 'dashboard_by_uid',
          value: dashboard.uid,
        },
      ]);
    },
    [items]
  );

  const addByTag = useCallback(
    (tags: string[]) => {
      const tag = tags[0];
      if (!tag || items.find((item) => item.value === tag)) {
        return;
      }

      const newItem: PlaylistItemUI = {
        type: 'dashboard_by_tag',
        value: tag,
      };
      setItems([...items, newItem]);
    },
    [items]
  );

  const moveItem = useCallback(
    (src: number, dst: number) => {
      if (src === dst || !items[src]) {
        return;
      }
      const update = Array.from(items);
      const [removed] = update.splice(src, 1);
      update.splice(dst, 0, removed);
      setItems(update);
    },
    [items]
  );

  const deleteItem = useCallback(
    (index: number) => {
      const copy = items.slice();
      copy.splice(index, 1);
      setItems(copy);
    },
    [items]
  );

  const updateItemVariables = useCallback((index: number, variables?: Record<string, string[]>) => {
    setItems((prev) => {
      if (!prev[index]) {
        return prev;
      }

      return prev.map((item, i) => {
        if (i !== index) {
          return item;
        }

        // An item may be owned by the caller or by the RTK Query cache, so build a new object
        // rather than mutating this one. An empty map drops the property altogether, so an item
        // without variables keeps the variable-less payload shape.
        const { variables: _replaced, ...rest } = item;
        return variables && Object.keys(variables).length > 0 ? { ...rest, variables } : rest;
      });
    });
  }, []);

  return { items, addByUID, addByTag, deleteItem, moveItem, updateItemVariables };
}
