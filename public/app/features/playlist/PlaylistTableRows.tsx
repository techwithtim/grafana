import { css } from '@emotion/css';
import { Draggable } from '@hello-pangea/dnd';
import pluralize from 'pluralize';
import { useId, type ReactNode } from 'react';

import { type GrafanaTheme2 } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { Trans, t } from '@grafana/i18n';
import { Icon, IconButton, useStyles2, Spinner, type IconName } from '@grafana/ui';
import { TagBadge } from 'app/core/components/TagFilter/TagBadge';

import { PlaylistItemVariables, inLogicalOrder } from './PlaylistItemVariables';
import { type PlaylistItemUI } from './types';

interface Props {
  items: PlaylistItemUI[];
  /**
   * One key per item, in the same order, each following its own item across a reorder. Supplied by
   * `PlaylistTable` from `usePlaylistItemKeys`, because a key derived from the position would leave
   * the dragged row's focus and DOM node behind on whichever item took its place.
   */
  itemKeys: string[];
  onDelete: (idx: number) => void;
  expanded: Set<number>;
  onToggleExpanded: (index: number) => void;
  onVariablesChange: (index: number, variables?: Record<string, string[]>) => void;
}

/**
 * Variable pairs a collapsed row names before its summary is elided.
 *
 * Two is what tells apart the rows of the arrangement this feature exists for — one dashboard
 * listed several times, each entry pinned to a different host — without turning a row into a
 * paragraph.
 */
const SUMMARY_PAIRS = 2;

/** Code points of variable text a collapsed row shows before its summary is elided. */
const SUMMARY_LENGTH = 48;

const ELLIPSIS = '…';

/**
 * The variable content of one item, short enough to sit in its row and in that row's accessible
 * name, or `undefined` for an item that holds no variables — which is what leaves a row without
 * any exactly as it was.
 *
 * A playlist may list one dashboard several times with a different variable set on each entry, so
 * the count of variables leaves those rows indistinguishable whenever the counts match: neither
 * their text nor their accessible name says which entry plays which host. The values themselves
 * are what separates them.
 *
 * The work is bounded the way `variableLimits` bounds its own walks over the same stored map: own
 * keys only, at most `SUMMARY_PAIRS` of them, and each pair's values joined only until they are
 * past the length this elides at. A stored map arrives as JSON rather than from the editor, so a
 * value list that is not an array of strings is summarized by its name alone instead of throwing
 * inside the row rendering it.
 *
 * Names and values pass through `inLogicalOrder`, because this summary puts several pieces of
 * free text into one string: a bidirectional override in any of them would otherwise reorder the
 * display of the `name=` it belongs to, of the pairs after it, and of the row's own name below.
 */
function summarizeVariables(variables?: Record<string, string[]>): string | undefined {
  if (!variables) {
    return undefined;
  }

  const pairs: string[] = [];
  let elided = false;
  for (const name in variables) {
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
      continue;
    }
    if (pairs.length === SUMMARY_PAIRS) {
      // Reaching this proves the map holds more pairs than the summary shows: the walk only gets
      // here when the iterator produced another name.
      elided = true;
      break;
    }

    const values = variables[name];
    let joined = '';
    if (Array.isArray(values)) {
      for (const value of values) {
        if (typeof value !== 'string') {
          continue;
        }
        const text = inLogicalOrder(value);
        joined = joined === '' ? text : `${joined}, ${text}`;
        // A code point is at most two UTF-16 units, so twice the elision length always holds as
        // many code points as the summary can show: joining beyond it cannot change the result.
        if (joined.length > SUMMARY_LENGTH * 2) {
          break;
        }
      }
    }
    // A name that is nothing but bidirectional controls has no text left to summarize, so its
    // values stand for the pair rather than an `=` with nothing in front of it.
    const label = inLogicalOrder(name);
    pairs.push(label === '' ? joined : joined === '' ? label : `${label}=${joined}`);
  }

  // Nothing renderable — an item with no variables, and the payload-only case of a name and values
  // that are both invisible. The row then reads exactly as a row without variables does, except
  // for the count beside it, which is rendered from the map itself.
  const summary = pairs.filter((pair) => pair !== '').join('; ');
  if (summary === '') {
    return undefined;
  }

  // Elided by code point rather than by string index, so a name or value ending in an astral
  // character is not cut in half into a character that renders as a replacement glyph.
  const codePoints = Array.from(summary);
  if (codePoints.length > SUMMARY_LENGTH) {
    return `${codePoints.slice(0, SUMMARY_LENGTH).join('')}${ELLIPSIS}`;
  }

  return elided ? `${summary}${ELLIPSIS}` : summary;
}

/**
 * The accessible name of one row.
 *
 * The item's type and value are what identify it, and its variable summary is named alongside them
 * when it has one: a dashboard listed twice answers to one name otherwise, so assistive technology
 * reports both entries identically however different the variables they play are. A row without
 * variables keeps exactly the name it has always had.
 *
 * An item's type and value are stored data, and the summary is built from stored variable text, so
 * both names interpolate text this component does not control. Two things are done to that text.
 * i18next escapes an interpolated value for HTML by default, which would name the row after the
 * entity spelling of the value rather than the value itself; escaping is turned off for these
 * interpolations alone, not for the instance, because the default guards every t() result in the
 * product that does reach HTML, and it is safe here because React sets this string as an attribute
 * value, which is never parsed as HTML. And the item's value goes through `inLogicalOrder`, so a
 * bidirectional override stored in it cannot reorder the rest of the row's name — the summary is
 * already built from text that has been through it.
 */
function itemLabel(item: PlaylistItemUI, variablesSummary?: string): string {
  const itemValue = inLogicalOrder(item.value);
  if (variablesSummary === undefined) {
    return t('playlist.playlist-table-rows.aria-label-playlist-item', 'Playlist item, {{itemType}}, {{itemValue}}', {
      itemType: item.type,
      itemValue,
      interpolation: { escapeValue: false },
    });
  }

  return t(
    'playlist.playlist-table-rows.aria-label-playlist-item-variables',
    'Playlist item, {{itemType}}, {{itemValue}}, {{variablesSummary}}',
    { itemType: item.type, itemValue, variablesSummary, interpolation: { escapeValue: false } }
  );
}

export const PlaylistTableRows = ({
  items,
  itemKeys,
  onDelete,
  expanded,
  onToggleExpanded,
  onVariablesChange,
}: Props) => {
  const styles = useStyles2(getStyles);
  // A hook cannot run inside the items loop, so one unique prefix is generated here and each row
  // derives its panel id from it, keeping the ids unique across several tables on a page.
  const panelIdPrefix = useId();

  if (!items?.length) {
    return (
      <div>
        <em>
          <Trans i18nKey="playlist-edit.form.table-empty">Playlist is empty. Add dashboards below.</Trans>
        </em>
      </div>
    );
  }

  const renderItem = (item: PlaylistItemUI, variablesSummary?: string) => {
    let icon: IconName = item.type === 'dashboard_by_tag' ? 'apps' : 'tag-alt';
    const info: ReactNode[] = [];

    const first = item.dashboards?.[0];
    if (!item.dashboards) {
      info.push(<Spinner key="spinner" />);
    } else if (item.type === 'dashboard_by_tag') {
      info.push(<TagBadge key={item.value} label={item.value} removeIcon={false} count={0} />);
      if (!first) {
        icon = 'exclamation-triangle';
        info.push(
          <span key="no-dashboards">
            &nbsp;{' '}
            <span key="info">
              <Trans i18nKey="playlist.playlist-table-rows.no-dashboards-found">No dashboards found</Trans>
            </span>
          </span>
        );
      } else {
        info.push(<span key="info">&nbsp; {pluralize('dashboard', item.dashboards.length, true)}</span>);
      }
    } else if (first) {
      info.push(
        item.dashboards.length > 1 ? (
          <span key="multiple-dashboards">
            &nbsp;{' '}
            <span key="info">
              <Trans i18nKey="playlist.playlist-table-rows.multiple-dashboards-found" values={{ items: item.value }}>
                Multiple items found: {'{{items}}'}
              </Trans>
            </span>
          </span>
        ) : (
          <span key="info">{first.name ?? item.value}</span>
        )
      );
    } else {
      icon = 'exclamation-triangle';
      info.push(
        <span key="not-found">
          &nbsp;{' '}
          <span key="info">
            <Trans i18nKey="playlist.playlist-table-rows.not-found" values={{ items: item.value }}>
              Not found: {'{{items}}'}
            </Trans>
          </span>
        </span>
      );
    }
    const variableCount = Object.keys(item.variables ?? {}).length;
    return (
      <>
        <Icon name={icon} className={styles.rightMargin} key="icon" />
        {info}
        {item.type === 'dashboard_by_uid' && variableCount > 0 && (
          <>
            {/*
             * The count comes from the stored map rather than from the summary beside it, because
             * the summary can be empty for a map that does hold variables: a name and values made
             * only of invisible formatting characters leave no text to preview, and the item still
             * has as many variables as it has.
             */}
            <span key="variables-count" className={styles.variablesSummary}>
              {t('playlist.playlist-table-rows.variables-count', '', {
                count: variableCount,
                defaultValue_one: '{{count}} variable',
                defaultValue_other: '{{count}} variables',
              })}
            </span>
            {/*
             * The count is the same string on every entry of a dashboard listed several times with
             * one variable each, so the values it counts are named beside it: this is the row that
             * plays `host=Host1` and the next one is `host=Host2`, readable without opening either.
             * The separator is hidden from assistive technology because the row's own accessible
             * name below carries the same summary without it.
             */}
            {variablesSummary !== undefined && (
              <span key="variables-preview" className={styles.variablesSummary}>
                <span aria-hidden="true">{'· '}</span>
                {variablesSummary}
              </span>
            )}
          </>
        )}
      </>
    );
  };

  return (
    <>
      {items.map((item, index) => {
        // Only dashboard_by_uid items support this editor, so tag rows and the deprecated
        // dashboard_by_id rows are excluded. The item type allows variables on any item, so a
        // payload may carry them elsewhere, but the UI and the runtime apply them to UID items only.
        const hasVariableEditor = item.type === 'dashboard_by_uid';
        const isExpanded = expanded.has(index);
        const panelId = `${panelIdPrefix}-${index}`;
        // Positions are counted the way the list reads, from one, because they are announced to a
        // person: they are what tells two entries of one dashboard apart in the name of a control
        // that would otherwise be named identically in both.
        const itemPosition = index + 1;
        const variablesSummary = hasVariableEditor ? summarizeVariables(item.variables) : undefined;

        return (
          <Draggable key={itemKeys[index]} draggableId={itemKeys[index]} index={index}>
            {(provided) => (
              // The draggable root is the list item, and the row inside it is a plain flex
              // container: one item owns its name, its controls and — while it is expanded — its
              // variables editor, and a `listitem` is the structure that may hold a `region`
              // beside the row's own content. A `role="row"` may hold neither: it may own nothing
              // but cells, and outside a table, grid or rowgroup it has no valid parent to sit in.
              // The index attribute lets the table find this row again after a structural change,
              // so focus can be moved to a surviving control instead of being dropped on the
              // document.
              <div
                ref={provided.innerRef}
                {...provided.draggableProps}
                data-playlist-item-index={index}
                role="listitem"
                aria-label={itemLabel(item, variablesSummary)}
              >
                <div className={styles.row}>
                  <div className={styles.actions}>{renderItem(item, variablesSummary)}</div>
                  <div className={styles.actions}>
                    {hasVariableEditor && (
                      <IconButton
                        name={isExpanded ? 'angle-down' : 'angle-right'}
                        size="md"
                        onClick={() => onToggleExpanded(index)}
                        aria-expanded={isExpanded}
                        // Named in both states, which is what a disclosure is: the panel below is
                        // in the document whether or not it is open, so this always resolves to the
                        // element it names rather than to an id nothing answers to.
                        aria-controls={panelId}
                        // The name is given as aria-label rather than as a tooltip, which an
                        // IconButton renders as a portal overlay that stays open while the button
                        // holds focus: after a click it lingers over the next row's disclosure,
                        // delete and drag controls and over the panel's first variable row, and
                        // swallows the click aimed at them. The aria-label form renders no overlay
                        // and carries the same accessible name.
                        aria-label={t('playlist-edit.form.variables-toggle', 'Template variables')}
                      />
                    )}
                    <IconButton
                      name="times"
                      size="md"
                      onClick={() => onDelete(index)}
                      data-testid={selectors.pages.PlaylistForm.itemDelete}
                      tooltip={t('playlist-edit.form.table-delete', 'Delete playlist item')}
                    />
                    <div {...provided.dragHandleProps} data-playlist-item-drag-handle="">
                      <Icon
                        title={t('playlist-edit.form.table-drag', 'Reorder playlist item')}
                        name="draggabledots"
                        size="md"
                      />
                    </div>
                  </div>
                </div>
                {hasVariableEditor && (
                  // The panel the disclosure above names. It stays in the document while the row
                  // is collapsed, and is hidden — so it is out of the accessibility tree, out of
                  // the tab sequence and out of layout, exactly as an absent panel would be, while
                  // the disclosure's `aria-controls` still resolves to a real element. The editor
                  // itself is mounted only while the row is open: it is the part that holds state,
                  // renders a control per variable and registers with the form's commit scope.
                  <div
                    id={panelId}
                    role="region"
                    hidden={!isExpanded}
                    // The item value alone names both panels of a dashboard listed twice, leaving
                    // a screen-reader user unable to tell which row's editor they are in, so the
                    // row's position is part of the name. It is stable for as long as the panel is
                    // open: every reorder and every deletion collapses the open editors.
                    aria-label={t(
                      'playlist.playlist-table-rows.variables-panel',
                      'Template variables for {{itemValue}}, item {{itemPosition}}',
                      { itemValue: inLogicalOrder(item.value), itemPosition, interpolation: { escapeValue: false } }
                    )}
                    className={styles.variables}
                  >
                    {isExpanded && (
                      <PlaylistItemVariables
                        variables={item.variables}
                        itemPosition={itemPosition}
                        onChange={(variables) => onVariablesChange(index, variables)}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </Draggable>
        );
      })}
    </>
  );
};

function getStyles(theme: GrafanaTheme2) {
  return {
    row: css({
      padding: theme.spacing(0.75),
      background: theme.colors.background.secondary,
      borderRadius: theme.shape.radius.default,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: '3px',

      border: `1px solid ${theme.colors.border.medium}`,
      '&:hover': {
        border: `1px solid ${theme.colors.border.strong}`,
      },
    }),
    rightMargin: css({
      marginRight: '5px',
    }),
    actions: css({
      alignItems: 'center',
      justifyContent: 'center',
      display: 'flex',
    }),
    settings: css({
      label: 'settings',
      textAlign: 'right',
    }),
    variables: css({
      paddingInlineStart: theme.spacing(3),
    }),
    // The summary shares a flex cell with the dashboard name, so left to shrink and wrap it broke
    // the phrase itself across two lines beside a long wrapped title. It holds its one line here and
    // the name, which wraps correctly already, absorbs the remaining width.
    variablesSummary: css({
      marginInlineStart: theme.spacing(1),
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      whiteSpace: 'nowrap',
      flexShrink: 0,
      // The summary is built out of stored variable text. Isolating it keeps whatever direction
      // that text resolves to inside this element, so it cannot reorder the dashboard name or the
      // count it sits beside — the counterpart, inside the string, of dropping the explicit
      // bidirectional controls.
      unicodeBidi: 'isolate',
    }),
  };
}
