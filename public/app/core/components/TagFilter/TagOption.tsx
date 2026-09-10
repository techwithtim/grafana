import { css, cx } from '@emotion/css';
import { type OptionProps } from 'react-select';

import { type GrafanaTheme2 } from '@grafana/data';
import { t } from '@grafana/i18n';
import { useStyles2 } from '@grafana/ui';

import { TagBadge } from './TagBadge';

export interface TagSelectOption {
  value: string;
  label: string;
  count: number;
}

/**
 * What the option is called, for anything that cannot see the badge.
 *
 * Every option used to be named "Tag option", so a list of them was a list of identical names and
 * a screen-reader user had no way to tell `qa-final (2)` from `qa-final-ui (1)`. The name now
 * carries what the badge shows — the tag, and the number of dashboards carrying it where the filter
 * reports one (it reports zero for a tag that is already selected, whose count the badge hides too).
 *
 * Escaping is turned off for these interpolations alone: tag names are free-form stored text, and
 * i18next's default escaping would announce `a&b` as `a&amp;b`. It is safe here because React sets
 * the result as an attribute value, which is never parsed as HTML.
 */
function tagOptionLabel(tag: string | undefined, count: number): string {
  if (tag === undefined) {
    return t('tag-filter.tag-option-label', 'Tag option');
  }

  return count > 0
    ? t('tag-filter.tag-option-label-with-count', 'Tag option {{tag}} ({{tagCount}})', {
        tag,
        tagCount: count,
        interpolation: { escapeValue: false },
      })
    : t('tag-filter.tag-option-label-tag', 'Tag option {{tag}}', { tag, interpolation: { escapeValue: false } });
}

export const TagOption = ({ data, className, label, isFocused, innerProps }: OptionProps<TagSelectOption>) => {
  const styles = useStyles2(getStyles);

  return (
    <div
      className={cx(styles.option, isFocused && styles.optionFocused)}
      aria-label={tagOptionLabel(typeof label === 'string' ? label : undefined, data.count ?? 0)}
      {...innerProps}
    >
      <div className={cx(styles.optionInner, className)}>
        {typeof label === 'string' ? <TagBadge label={label} removeIcon={false} count={data.count ?? 0} /> : label}
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  return {
    option: css({
      padding: theme.spacing(0.5),
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      borderLeft: '2px solid transparent',
      borderRadius: theme.shape.radius.default,
      '&:hover': {
        background: theme.colors.action.hover,
      },
    }),
    optionFocused: css({
      background: theme.colors.action.focus,
      borderStyle: 'solid',
      borderTop: 0,
      borderRight: 0,
      borderBottom: 0,
      borderLeftWidth: '2px',
    }),
    optionInner: css({
      position: 'relative',
      textAlign: 'left',
      width: '100%',
      display: 'block',
      cursor: 'pointer',
      padding: '2px 0',
    }),
  };
};
