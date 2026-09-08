import { css } from '@emotion/css';
import { Draggable } from '@hello-pangea/dnd';
import pluralize from 'pluralize';
import { useId, type ReactNode } from 'react';

import { type GrafanaTheme2 } from '@grafana/data';
import { selectors } from '@grafana/e2e-selectors';
import { Trans, t } from '@grafana/i18n';
import { Icon, IconButton, useStyles2, Spinner, type IconName } from '@grafana/ui';
import { TagBadge } from 'app/core/components/TagFilter/TagBadge';

import { PlaylistItemVariables } from './PlaylistItemVariables';
import { type PlaylistItemUI } from './types';

interface Props {
  items: PlaylistItemUI[];
  onDelete: (idx: number) => void;
  /** Indexes whose template variable editor is open. Owned by `PlaylistTable`, which collapses
   * every editor on a reorder or a deletion so an open one cannot end up attached to another item. */
  expanded: Set<number>;
  onToggleExpanded: (index: number) => void;
  onVariablesChange: (index: number, variables?: Record<string, string[]>) => void;
}

export const PlaylistTableRows = ({ items, onDelete, expanded, onToggleExpanded, onVariablesChange }: Props) => {
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

  const renderItem = (item: PlaylistItemUI) => {
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
          <span key="variables-count" className={styles.variablesSummary}>
            {t('playlist.playlist-table-rows.variables-count', '', {
              count: variableCount,
              defaultValue_one: '{{count}} variable',
              defaultValue_other: '{{count}} variables',
            })}
          </span>
        )}
      </>
    );
  };

  return (
    <>
      {items.map((item, index) => {
        // Only dashboards added by UID can carry template variables, so the deprecated
        // dashboard_by_id type and tag items are matched out rather than assumed away.
        const hasVariableEditor = item.type === 'dashboard_by_uid';
        const isExpanded = expanded.has(index);
        const panelId = `${panelIdPrefix}-${index}`;

        return (
          <Draggable key={`${index}/${item.value}`} draggableId={`${index}`} index={index}>
            {(provided) => (
              // The draggable root is a plain wrapper rather than the row itself, so the variables
              // panel can be a sibling of the row: nested inside it, the panel would read as a cell
              // of that row and its controls would belong to the row's accessibility tree.
              <div ref={provided.innerRef} {...provided.draggableProps}>
                <div className={styles.row} role="row">
                  <div
                    className={styles.actions}
                    role="cell"
                    aria-label={t(
                      'playlist.playlist-table-rows.aria-label-playlist-item',
                      'Playlist item, {{itemType}}, {{itemValue}}',
                      { itemType: item.type, itemValue: item.value }
                    )}
                  >
                    {renderItem(item)}
                  </div>
                  <div className={styles.actions}>
                    {hasVariableEditor && (
                      <IconButton
                        name={isExpanded ? 'angle-down' : 'angle-right'}
                        size="md"
                        onClick={() => onToggleExpanded(index)}
                        aria-expanded={isExpanded}
                        aria-controls={panelId}
                        tooltip={t('playlist-edit.form.variables-toggle', 'Template variables')}
                      />
                    )}
                    <IconButton
                      name="times"
                      size="md"
                      onClick={() => onDelete(index)}
                      data-testid={selectors.pages.PlaylistForm.itemDelete}
                      tooltip={t('playlist-edit.form.table-delete', 'Delete playlist item')}
                    />
                    <div {...provided.dragHandleProps}>
                      <Icon
                        title={t('playlist-edit.form.table-drag', 'Reorder playlist item')}
                        name="draggabledots"
                        size="md"
                      />
                    </div>
                  </div>
                </div>
                {hasVariableEditor && isExpanded && (
                  <div
                    id={panelId}
                    role="region"
                    aria-label={t(
                      'playlist.playlist-table-rows.variables-panel',
                      'Template variables for {{itemValue}}',
                      { itemValue: item.value }
                    )}
                    className={styles.variables}
                  >
                    <PlaylistItemVariables
                      variables={item.variables}
                      onChange={(variables) => onVariablesChange(index, variables)}
                    />
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
      // Indents the editor to the start of its row's label, past the type icon, so the panel reads
      // as belonging to the row above it. The editor draws its own surface, so nothing else is set.
      paddingInlineStart: theme.spacing(3),
    }),
    variablesSummary: css({
      marginInlineStart: theme.spacing(1),
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
  };
}
