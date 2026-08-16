import type { ParagraphMatch } from "./matches.js";

export interface MatchCluster {
  readonly matches: readonly ParagraphMatch[];
  readonly members: readonly number[];
}

/** Groups duplicate-pair edges into transitive connected components. */
export function clusterMatches(matches: readonly ParagraphMatch[]): readonly MatchCluster[] {
  const parent = new Map<number, number>();

  const find = (member: number): number => {
    const current = parent.get(member);
    if (current === undefined) {
      parent.set(member, member);
      return member;
    }
    if (current === member) {
      return member;
    }
    const root = find(current);
    parent.set(member, root);
    return root;
  };

  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
    }
  };

  for (const match of matches) {
    union(match.left, match.right);
  }

  const membersByRoot = new Map<number, number[]>();
  for (const member of parent.keys()) {
    const root = find(member);
    const members = membersByRoot.get(root) ?? [];
    members.push(member);
    membersByRoot.set(root, members);
  }

  return [...membersByRoot.values()]
    .map((members) => {
      const sortedMembers = members.sort((left, right) => left - right);
      const memberSet = new Set(sortedMembers);
      return {
        matches: matches.filter((match) => memberSet.has(match.left) && memberSet.has(match.right)),
        members: sortedMembers,
      };
    })
    .sort((left, right) => (left.members[0] ?? 0) - (right.members[0] ?? 0));
}
