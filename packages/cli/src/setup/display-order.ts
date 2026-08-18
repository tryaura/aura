/**
 * Orders picker rows for display: primary group, then name, then id as the tiebreaker.
 *
 * Groups must be adjacent because the renderer only heads a run of adjacent rows — registry order
 * interleaves two contributors sharing a group and repeats its heading.
 */
export function sortForDisplay<T>(
  rows: readonly T[],
  key: (row: T) => readonly [string, string, string],
): readonly T[] {
  return [...rows].sort((left, right) => {
    const [leftGroup, leftName, leftId] = key(left);
    const [rightGroup, rightName, rightId] = key(right);
    return (
      compare(leftGroup, rightGroup) || compare(leftName, rightName) || compare(leftId, rightId)
    );
  });
}

function compare(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
