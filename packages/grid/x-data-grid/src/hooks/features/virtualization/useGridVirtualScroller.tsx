import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { useForkRef } from '@mui/material/utils';
import { useGridApiContext } from '../../utils/useGridApiContext';
import { useGridRootProps } from '../../utils/useGridRootProps';
import { useGridSelector } from '../../utils/useGridSelector';
import {
  gridVisibleColumnDefinitionsSelector,
  gridColumnsTotalWidthSelector,
  gridColumnPositionsSelector,
} from '../columns/gridColumnsSelector';
import { gridDensityRowHeightSelector } from '../density/densitySelector';
import { gridFocusCellSelector, gridTabIndexCellSelector } from '../focus/gridFocusStateSelector';
import { gridEditRowsStateSelector } from '../editRows/gridEditRowsSelector';
import { useGridVisibleRows } from '../../utils/useGridVisibleRows';
import { GridEventListener } from '../../../models/events';
import { useGridApiEventHandler } from '../../utils/useGridApiEventHandler';
import { clamp } from '../../../utils/utils';
import { GridRenderContext, GridRowEntry } from '../../../models';
import { selectedIdsLookupSelector } from '../selection/gridSelectionSelector';
import { gridRowsMetaSelector } from '../rows/gridRowsMetaSelector';
import { GridRowId, GridRowModel } from '../../../models/gridRows';
import { getFirstNonSpannedColumnToRender } from '../columns/gridColumnsUtils';

// Uses binary search to avoid looping through all possible positions
export function binarySearch(
  offset: number,
  positions: number[],
  sliceStart = 0,
  sliceEnd = positions.length,
): number {
  if (positions.length <= 0) {
    return -1;
  }

  if (sliceStart >= sliceEnd) {
    return sliceStart;
  }

  const pivot = sliceStart + Math.floor((sliceEnd - sliceStart) / 2);
  const itemOffset = positions[pivot];
  return offset <= itemOffset
    ? binarySearch(offset, positions, sliceStart, pivot)
    : binarySearch(offset, positions, pivot + 1, sliceEnd);
}

function exponentialSearch(offset: number, positions: number[], index: number): number {
  let interval = 1;

  while (index < positions.length && positions[index] < offset) {
    index += interval;
    interval *= 2;
  }

  return binarySearch(offset, positions, Math.floor(index / 2), Math.min(index, positions.length));
}

export const getRenderableIndexes = ({
  firstIndex,
  lastIndex,
  buffer,
  minFirstIndex,
  maxLastIndex,
}: {
  firstIndex: number;
  lastIndex: number;
  buffer: number;
  minFirstIndex: number;
  maxLastIndex: number;
}) => {
  return [
    clamp(firstIndex - buffer, minFirstIndex, maxLastIndex),
    clamp(lastIndex + buffer, minFirstIndex, maxLastIndex),
  ];
};

interface UseGridVirtualScrollerProps {
  ref: React.Ref<HTMLDivElement>;
  disableVirtualization?: boolean;
  renderZoneMinColumnIndex?: number;
  renderZoneMaxColumnIndex?: number;
  onRenderZonePositioning?: (params: { top: number; left: number }) => void;
  getRowProps?: (id: GridRowId, model: GridRowModel) => any;
}

export const useGridVirtualScroller = (props: UseGridVirtualScrollerProps) => {
  const apiRef = useGridApiContext();
  const rootProps = useGridRootProps();
  const visibleColumns = useGridSelector(apiRef, gridVisibleColumnDefinitionsSelector);

  const {
    ref,
    disableVirtualization,
    onRenderZonePositioning,
    renderZoneMinColumnIndex = 0,
    renderZoneMaxColumnIndex = visibleColumns.length,
    getRowProps,
  } = props;

  const columnPositions = useGridSelector(apiRef, gridColumnPositionsSelector);
  const columnsTotalWidth = useGridSelector(apiRef, gridColumnsTotalWidthSelector);
  const rowHeight = useGridSelector(apiRef, gridDensityRowHeightSelector);
  const cellFocus = useGridSelector(apiRef, gridFocusCellSelector);
  const cellTabIndex = useGridSelector(apiRef, gridTabIndexCellSelector);
  const rowsMeta = useGridSelector(apiRef, gridRowsMetaSelector);
  const editRowsState = useGridSelector(apiRef, gridEditRowsStateSelector);
  const selectedRowsLookup = useGridSelector(apiRef, selectedIdsLookupSelector);
  const currentPage = useGridVisibleRows(apiRef, rootProps);
  const renderZoneRef = React.useRef<HTMLDivElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const handleRef = useForkRef(ref, rootRef);
  const [renderContext, setRenderContext] = React.useState<GridRenderContext | null>(null);
  const prevRenderContext = React.useRef<GridRenderContext | null>(renderContext);
  const scrollPosition = React.useRef({ top: 0, left: 0 });
  const [containerWidth, setContainerWidth] = React.useState<number | null>(null);
  const prevTotalWidth = React.useRef(columnsTotalWidth);

  const getNearestIndexToRender = React.useCallback(
    (offset) => {
      const lastMeasuredIndex = Math.max(0, apiRef.current.unstable_getLastMeasuredRowIndex());
      const allRowsMeasured = lastMeasuredIndex === Infinity;

      if (allRowsMeasured || rowsMeta.positions[lastMeasuredIndex] >= offset) {
        // If all rows were measured (when no row has "auto" as height) or all rows before the offset
        // were measured, then use a binary search because it's faster.
        return binarySearch(offset, rowsMeta.positions);
      }

      // Otherwise, use an exponential search.
      // If rows have "auto" as height, their positions will be based on estimated heights.
      // In this case, we can skip several steps until we find a position higher than the offset.
      // Inspired by https://github.com/bvaughn/react-virtualized/blob/master/source/Grid/utils/CellSizeAndPositionManager.js
      return exponentialSearch(offset, rowsMeta.positions, lastMeasuredIndex);
    },
    [apiRef, rowsMeta.positions],
  );

  const computeRenderContext = React.useCallback(() => {
    if (disableVirtualization) {
      return {
        firstRowIndex: 0,
        lastRowIndex: currentPage.rows.length,
        firstColumnIndex: 0,
        lastColumnIndex: visibleColumns.length,
      };
    }

    const { top, left } = scrollPosition.current!;

    // Clamp the value because the search may return an index out of bounds.
    // In the last index, this is not needed because Array.slice doesn't include it.
    const firstRowIndex = Math.min(getNearestIndexToRender(top), rowsMeta.positions.length - 1);

    const lastRowIndex = rootProps.autoHeight
      ? firstRowIndex + currentPage.rows.length
      : getNearestIndexToRender(top + rootRef.current!.clientHeight!);

    let hasRowWithAutoHeight = false;
    let firstColumnIndex = 0;
    let lastColumnIndex = columnPositions.length;

    const [firstRowToRender, lastRowToRender] = getRenderableIndexes({
      firstIndex: firstRowIndex,
      lastIndex: lastRowIndex,
      minFirstIndex: 0,
      maxLastIndex: currentPage.rows.length,
      buffer: rootProps.rowBuffer,
    });

    for (let i = firstRowToRender; i < lastRowToRender && !hasRowWithAutoHeight; i += 1) {
      const row = currentPage.rows[i];
      hasRowWithAutoHeight = apiRef.current.unstable_rowHasAutoHeight(row.id);
    }

    if (!hasRowWithAutoHeight) {
      firstColumnIndex = binarySearch(left, columnPositions);
      lastColumnIndex = binarySearch(left + containerWidth!, columnPositions);
    }

    return {
      firstRowIndex,
      lastRowIndex,
      firstColumnIndex,
      lastColumnIndex,
    };
  }, [
    disableVirtualization,
    getNearestIndexToRender,
    rowsMeta.positions.length,
    rootProps.autoHeight,
    rootProps.rowBuffer,
    currentPage.rows,
    columnPositions,
    visibleColumns.length,
    apiRef,
    containerWidth,
  ]);

  React.useEffect(() => {
    if (disableVirtualization) {
      renderZoneRef.current!.style.transform = `translate3d(0px, 0px, 0px)`;
    } else {
      // TODO a scroll reset should not be necessary
      rootRef.current!.scrollLeft = 0;
      rootRef.current!.scrollTop = 0;
    }
  }, [disableVirtualization]);

  React.useEffect(() => {
    setContainerWidth(rootRef.current!.clientWidth);
  }, [rowsMeta.currentPageTotalHeight]);

  const handleResize = React.useCallback<GridEventListener<'resize'>>(() => {
    if (rootRef.current) {
      setContainerWidth(rootRef.current.clientWidth);
    }
  }, []);

  useGridApiEventHandler(apiRef, 'resize', handleResize);

  const updateRenderZonePosition = React.useCallback(
    (nextRenderContext: GridRenderContext) => {
      const [firstRowToRender, lastRowToRender] = getRenderableIndexes({
        firstIndex: nextRenderContext.firstRowIndex,
        lastIndex: nextRenderContext.lastRowIndex,
        minFirstIndex: 0,
        maxLastIndex: currentPage.rows.length,
        buffer: rootProps.rowBuffer,
      });

      const [initialFirstColumnToRender] = getRenderableIndexes({
        firstIndex: nextRenderContext.firstColumnIndex,
        lastIndex: nextRenderContext.lastColumnIndex,
        minFirstIndex: renderZoneMinColumnIndex,
        maxLastIndex: renderZoneMaxColumnIndex,
        buffer: rootProps.columnBuffer,
      });

      const firstColumnToRender = getFirstNonSpannedColumnToRender({
        firstColumnToRender: initialFirstColumnToRender,
        apiRef,
        firstRowToRender,
        lastRowToRender,
        visibleRows: currentPage.rows,
      });

      const top = gridRowsMetaSelector(apiRef.current.state).positions[firstRowToRender];
      const left = gridColumnPositionsSelector(apiRef)[firstColumnToRender]; // Call directly the selector because it might be outdated when this method is called
      renderZoneRef.current!.style.transform = `translate3d(${left}px, ${top}px, 0px)`;

      if (typeof onRenderZonePositioning === 'function') {
        onRenderZonePositioning({ top, left });
      }
    },
    [
      apiRef,
      currentPage.rows,
      onRenderZonePositioning,
      renderZoneMinColumnIndex,
      renderZoneMaxColumnIndex,
      rootProps.columnBuffer,
      rootProps.rowBuffer,
    ],
  );

  React.useLayoutEffect(() => {
    if (renderContext) {
      updateRenderZonePosition(renderContext);
    }
  }, [renderContext, updateRenderZonePosition]);

  const updateRenderContext = React.useCallback(
    (nextRenderContext) => {
      setRenderContext(nextRenderContext);
      prevRenderContext.current = nextRenderContext;
    },
    [setRenderContext, prevRenderContext],
  );

  React.useEffect(() => {
    if (containerWidth == null) {
      return;
    }

    const initialRenderContext = computeRenderContext();
    updateRenderContext(initialRenderContext);

    const { top, left } = scrollPosition.current!;
    const params = { top, left, renderContext: initialRenderContext };
    apiRef.current.publishEvent('rowsScroll', params);
  }, [apiRef, computeRenderContext, containerWidth, updateRenderContext]);

  const handleScroll = (event: React.UIEvent) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    scrollPosition.current.top = scrollTop;
    scrollPosition.current.left = scrollLeft;

    // On iOS and macOS, negative offsets are possible when swiping past the start
    if (scrollLeft < 0 || scrollTop < 0 || !prevRenderContext.current) {
      return;
    }

    // When virtualization is disabled, the context never changes during scroll
    const nextRenderContext = disableVirtualization
      ? prevRenderContext.current
      : computeRenderContext();

    const topRowsScrolledSincePreviousRender = Math.abs(
      nextRenderContext.firstRowIndex - prevRenderContext.current.firstRowIndex,
    );
    const bottomRowsScrolledSincePreviousRender = Math.abs(
      nextRenderContext.lastRowIndex - prevRenderContext.current.lastRowIndex,
    );

    const topColumnsScrolledSincePreviousRender = Math.abs(
      nextRenderContext.firstColumnIndex - prevRenderContext.current.firstColumnIndex,
    );
    const bottomColumnsScrolledSincePreviousRender = Math.abs(
      nextRenderContext.lastColumnIndex - prevRenderContext.current.lastColumnIndex,
    );

    const shouldSetState =
      topRowsScrolledSincePreviousRender >= rootProps.rowThreshold ||
      bottomRowsScrolledSincePreviousRender >= rootProps.rowThreshold ||
      topColumnsScrolledSincePreviousRender >= rootProps.columnThreshold ||
      bottomColumnsScrolledSincePreviousRender >= rootProps.columnThreshold ||
      prevTotalWidth.current !== columnsTotalWidth;

    // TODO v6: rename event to a wider name, it's not only fired for row scrolling
    apiRef.current.publishEvent(
      'rowsScroll',
      {
        top: scrollTop,
        left: scrollLeft,
        renderContext: shouldSetState ? nextRenderContext : prevRenderContext.current,
      },
      event,
    );

    if (shouldSetState) {
      // Prevents batching render context changes
      ReactDOM.flushSync(() => {
        updateRenderContext(nextRenderContext);
      });
      prevTotalWidth.current = columnsTotalWidth;
    }
  };

  const handleWheel = (event: React.WheelEvent) => {
    apiRef.current.publishEvent('virtualScrollerWheel', {}, event);
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    apiRef.current.publishEvent('virtualScrollerTouchMove', {}, event);
  };

  const getRows = (
    params: {
      renderContext: GridRenderContext | null;
      minFirstColumn?: number;
      maxLastColumn?: number;
      availableSpace?: number | null;
      ignoreAutoHeight?: boolean;
    } = { renderContext },
  ) => {
    const {
      renderContext: nextRenderContext,
      minFirstColumn = renderZoneMinColumnIndex,
      maxLastColumn = renderZoneMaxColumnIndex,
      availableSpace = containerWidth,
      ignoreAutoHeight,
    } = params;

    if (!currentPage.range || !nextRenderContext || availableSpace == null) {
      return null;
    }

    const rowBuffer = !disableVirtualization ? rootProps.rowBuffer : 0;
    const columnBuffer = !disableVirtualization ? rootProps.columnBuffer : 0;

    const [firstRowToRender, lastRowToRender] = getRenderableIndexes({
      firstIndex: nextRenderContext.firstRowIndex,
      lastIndex: nextRenderContext.lastRowIndex,
      minFirstIndex: 0,
      maxLastIndex: currentPage.rows.length,
      buffer: rowBuffer,
    });

    const renderedRows: GridRowEntry[] = [];

    for (let i = firstRowToRender; i < lastRowToRender; i += 1) {
      const row = currentPage.rows[i];
      renderedRows.push(row);

      apiRef.current.unstable_calculateColSpan({ rowId: row.id, minFirstColumn, maxLastColumn });
    }

    const [initialFirstColumnToRender, lastColumnToRender] = getRenderableIndexes({
      firstIndex: nextRenderContext.firstColumnIndex,
      lastIndex: nextRenderContext.lastColumnIndex,
      minFirstIndex: minFirstColumn,
      maxLastIndex: maxLastColumn,
      buffer: columnBuffer,
    });

    const firstColumnToRender = getFirstNonSpannedColumnToRender({
      firstColumnToRender: initialFirstColumnToRender,
      apiRef,
      firstRowToRender,
      lastRowToRender,
      visibleRows: currentPage.rows,
    });

    const renderedColumns = visibleColumns.slice(firstColumnToRender, lastColumnToRender);

    const rows: JSX.Element[] = [];

    for (let i = 0; i < renderedRows.length; i += 1) {
      const { id, model } = renderedRows[i];
      const lastVisibleRowIndex = firstRowToRender + i === currentPage.rows.length - 1;
      const baseRowHeight =
        !apiRef.current.unstable_rowHasAutoHeight(id) || ignoreAutoHeight
          ? apiRef.current.unstable_getRowHeight(id)
          : 'auto';

      let isSelected: boolean;
      if (selectedRowsLookup[id] == null) {
        isSelected = false;
      } else if (typeof rootProps.isRowSelectable === 'function') {
        isSelected = rootProps.isRowSelectable(apiRef.current.getRowParams(id));
      } else {
        isSelected = true;
      }

      rows.push(
        <rootProps.components.Row
          key={id}
          row={model}
          rowId={id}
          rowHeight={baseRowHeight}
          cellFocus={cellFocus} // TODO move to inside the row
          cellTabIndex={cellTabIndex} // TODO move to inside the row
          editRowsState={editRowsState} // TODO move to inside the row
          renderedColumns={renderedColumns}
          visibleColumns={visibleColumns}
          firstColumnToRender={firstColumnToRender}
          lastColumnToRender={lastColumnToRender}
          selected={isSelected}
          index={currentPage.range.firstRowIndex + firstRowToRender + i}
          containerWidth={availableSpace}
          isLastVisible={lastVisibleRowIndex}
          {...(typeof getRowProps === 'function' ? getRowProps(id, model) : {})}
          {...rootProps.componentsProps?.row}
        />,
      );
    }

    return rows;
  };

  const needsHorizontalScrollbar = containerWidth && columnsTotalWidth > containerWidth;

  const contentSize = React.useMemo(() => {
    // In cases where the columns exceed the available width,
    // the horizontal scrollbar should be shown even when there're no rows.
    // Keeping 1px as minimum height ensures that the scrollbar will visible if necessary.
    const height = Math.max(rowsMeta.currentPageTotalHeight, 1);

    let shouldExtendContent = false;
    if (rootRef?.current && height <= rootRef?.current.clientHeight) {
      shouldExtendContent = true;
    }

    const size = {
      width: needsHorizontalScrollbar ? columnsTotalWidth : 'auto',
      height,
      minHeight: shouldExtendContent ? '100%' : 'auto',
    };

    if (rootProps.autoHeight && currentPage.rows.length === 0) {
      size.height = 2 * rowHeight; // Give room to show the overlay when there's no row.
    }

    return size;
  }, [
    rootRef,
    columnsTotalWidth,
    rowsMeta.currentPageTotalHeight,
    currentPage.rows.length,
    needsHorizontalScrollbar,
    rootProps.autoHeight,
    rowHeight,
  ]);

  React.useEffect(() => {
    apiRef.current.publishEvent('virtualScrollerContentSizeChange');
  }, [apiRef, contentSize]);

  if (rootProps.autoHeight && currentPage.rows.length === 0) {
    contentSize.height = 2 * rowHeight; // Give room to show the overlay when there no rows.
  }

  const rootStyle = {} as React.CSSProperties;
  if (!needsHorizontalScrollbar) {
    rootStyle.overflowX = 'hidden';
  }
  if (rootProps.autoHeight) {
    rootStyle.overflowY = 'hidden';
  }

  const getRenderContext = React.useCallback((): GridRenderContext => {
    return prevRenderContext.current!;
  }, []);

  apiRef.current.unstable_getRenderContext = getRenderContext;

  return {
    renderContext,
    updateRenderZonePosition,
    getRows,
    getRootProps: ({ style = {}, ...other } = {}) => ({
      ref: handleRef,
      onScroll: handleScroll,
      onWheel: handleWheel,
      onTouchMove: handleTouchMove,
      style: { ...style, ...rootStyle },
      ...other,
    }),
    getContentProps: ({ style = {} } = {}) => ({ style: { ...style, ...contentSize } }),
    getRenderZoneProps: () => ({ ref: renderZoneRef }),
  };
};
