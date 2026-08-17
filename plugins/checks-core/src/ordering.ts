/**
 * Compares strings by Unicode code points without depending on the host locale.
 *
 * Allocation-free on purpose: this is the comparator behind every sort in the plugin, including
 * one over the pair edges of a duplicate cluster, which the caller documents as reaching tens of
 * thousands of entries. Materializing both operands as code-point arrays per comparison measured
 * an order of magnitude slower than scanning them in place.
 */
export function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const leftUnit = left.charCodeAt(index);
    const rightUnit = right.charCodeAt(index);
    if (leftUnit === rightUnit) {
      continue;
    }
    // Below the surrogate range a code unit is its own code point, so their orders agree. A
    // surrogate on either side means the difference may straddle a pair, and only a walk over
    // whole code points decides it correctly.
    return isSurrogate(leftUnit) || isSurrogate(rightUnit)
      ? compareByCodePoint(left, right)
      : leftUnit - rightUnit;
  }
  return left.length - right.length;
}

function isSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdfff;
}

function compareByCodePoint(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex) ?? 0;
    const rightPoint = right.codePointAt(rightIndex) ?? 0;
    if (leftPoint !== rightPoint) {
      return leftPoint - rightPoint;
    }
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  return left.length - leftIndex - (right.length - rightIndex);
}
