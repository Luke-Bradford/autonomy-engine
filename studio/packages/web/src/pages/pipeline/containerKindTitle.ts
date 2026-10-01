import type { ContainerKind } from '@autonomy-studio/shared';

/**
 * #1396 — how a container KIND is named to the operator: the palette's word,
 * the ADF one. The stored kind (`loop`) is still what the doc holds and what
 * the validator's messages cite; this is only what a person reads. Every
 * surface naming a kind reads it here, `containerLabels` included, so the box
 * an operator drops as "Until" is not then called "loop 1".
 *
 * A leaf module so the palette and `containerRules` can both import it.
 */
export const CONTAINER_KIND_TITLE: Readonly<Record<ContainerKind, string>> = {
  foreach: 'ForEach',
  loop: 'Until',
  stage: 'Stage',
};
