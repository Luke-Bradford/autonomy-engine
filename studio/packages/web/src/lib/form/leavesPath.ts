import type { BlockerFunction } from 'react-router';

/**
 * Hold only a navigation to another path. For a page whose draft survives a
 * same-path change (a search or hash change re-renders the same instance), so
 * only leaving the path throws the draft away. The pipeline editor uses it.
 */
export const leavesPath: BlockerFunction = ({ currentLocation, nextLocation }) =>
  currentLocation.pathname !== nextLocation.pathname;
