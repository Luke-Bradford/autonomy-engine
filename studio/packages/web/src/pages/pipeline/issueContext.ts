import { createContext, useContext } from 'react';
import { subjectKey, type IssueSubject, type SubjectIssue } from './containerRules';

const NONE: readonly SubjectIssue[] = [];

/**
 * #863 — the canvas's issues by subject (`issuesBySubject`), handed to the boxes
 * React Flow renders.
 *
 * A context rather than a field on each node's `data`: `data` is rebuilt by the
 * reconcile effect in `FlowCanvas`, whose dependencies are chosen around
 * position carry-forward, and threading a value that changes on every param
 * keystroke through it would rebuild every node object for an edit that moved
 * none of them. A box reads its own entry here instead.
 */
export const SubjectIssuesContext = createContext<ReadonlyMap<string, SubjectIssue[]>>(new Map());

/** The issues attributed to one element — a stable empty list when it has none. */
export function useSubjectIssues(kind: IssueSubject['kind'], id: string): readonly SubjectIssue[] {
  return useContext(SubjectIssuesContext).get(subjectKey(kind, id)) ?? NONE;
}

/** The accessible statement of an issue count: "1 validation issue", "3 validation issues". */
export function issueCountLabel(count: number): string {
  return `${String(count)} validation issue${count === 1 ? '' : 's'}`;
}
