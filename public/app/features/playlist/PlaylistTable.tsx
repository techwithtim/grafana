import { DragDropContext, Droppable, type DropResult } from '@hello-pangea/dnd';
import { useCallback, useState } from 'react';

import { t } from '@grafana/i18n';
import { FieldSet } from '@grafana/ui';

import { PlaylistTableRows } from './PlaylistTableRows';
import { type PlaylistItemUI } from './types';

interface Props {
  items: PlaylistItemUI[];
  deleteItem: (idx: number) => void;
  moveItem: (src: number, dst: number) => void;
  onVariablesChange: (index: number, variables?: Record<string, string[]>) => void;
}

export const PlaylistTable = ({ items, deleteItem, moveItem, onVariablesChange }: Props) => {
  // Rows are identified by position and the same dashboard may now appear several times with
  // different variables, so an editor left open across a move or a deletion would re-attach to a
  // different item. Every structural change therefore collapses all open editors.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleExpanded = useCallback((index: number) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const onDelete = (idx: number) => {
    setExpanded(new Set());
    deleteItem(idx);
  };

  const onDragEnd = (d: DropResult) => {
    setExpanded(new Set());
    if (d.destination) {
      moveItem(d.source.index, d.destination?.index);
    }
  };

  return (
    <FieldSet label={t('playlist-edit.form.table-heading', 'Dashboards')}>
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="playlist-list" direction="vertical">
          {(provided) => {
            return (
              <div ref={provided.innerRef} {...provided.droppableProps}>
                <PlaylistTableRows
                  items={items}
                  onDelete={onDelete}
                  expanded={expanded}
                  onToggleExpanded={toggleExpanded}
                  onVariablesChange={onVariablesChange}
                />
                {provided.placeholder}
              </div>
            );
          }}
        </Droppable>
      </DragDropContext>
    </FieldSet>
  );
};
