interface ContradictionPattern {
  /** `$1`, `$2`, and so on are replaced with captured values from {@link regex}. */
  readonly polarity: string;
  readonly regex: RegExp;
}

export interface ContradictionAxis {
  /**
   * Renders one of this axis's polarities as the words a user would recognize.
   *
   * Owned by the axis rather than the reporting code, so that adding an axis cannot leak an
   * internal encoding such as `spaces:any` into a finding. Omit it when the polarity is already
   * the word to print.
   */
  readonly describePolarity?: ((polarity: string) => string) | undefined;
  readonly id: string;
  readonly label: string;
  readonly patterns: readonly ContradictionPattern[];
}

/** Cheap, curated contradiction classes. Additions require positive and near-miss fixtures. */
export const CONTRADICTION_AXES: readonly ContradictionAxis[] = [
  {
    describePolarity: (polarity) => {
      if (polarity === "spaces:any") {
        return "spaces";
      }
      return polarity.startsWith("spaces:")
        ? `${polarity.slice("spaces:".length)} spaces`
        : polarity;
    },
    id: "indentation",
    label: "indentation",
    patterns: [
      {
        polarity: "tabs",
        regex: /\b(?:always\s+)?(?:indent(?:ation)?\s+(?:with|using)|use|prefer)\s+tabs?\b/giu,
      },
      {
        polarity: "spaces:any",
        regex: /\b(?:always\s+)?(?:indent(?:ation)?\s+(?:with|using)|use|prefer)\s+spaces?\b/giu,
      },
      {
        polarity: "spaces:$1",
        regex:
          /\b(?:always\s+)?(?:indent(?:ation)?\s+(?:with|using)|use|prefer)\s+(\d+)[ -]spaces?\b/giu,
      },
    ],
  },
  {
    id: "package-manager",
    label: "package manager",
    patterns: [
      {
        polarity: "$1",
        regex:
          /\b(?:use|prefer|always\s+use|only\s+use|must\s+use)\s+(?:the\s+)?(npm|pnpm|yarn|bun)\b/giu,
      },
    ],
  },
  {
    describePolarity: (polarity) =>
      polarity === "always" ? "required semicolons" : "no semicolons",
    id: "semicolons",
    label: "semicolon",
    patterns: [
      {
        polarity: "always",
        regex: /\b(?:always\s+use|require|keep)\s+semicolons?\b/giu,
      },
      {
        polarity: "never",
        regex: /\b(?:never\s+use|avoid|omit|do\s+not\s+use|don't\s+use)\s+semicolons?\b/giu,
      },
    ],
  },
  {
    describePolarity: (polarity) =>
      polarity === "conventional" ? "conventional commits" : "free-form commits",
    id: "commit-style",
    label: "commit style",
    patterns: [
      {
        polarity: "conventional",
        regex: /\b(?:use|require|follow)\s+conventional commits?\b/giu,
      },
      {
        polarity: "free-form",
        regex:
          /\b(?:(?:use|allow|prefer)\s+free[- ]form commit messages?|(?:avoid|do\s+not\s+use|don't\s+use)\s+conventional commits?)\b/giu,
      },
    ],
  },
  {
    describePolarity: (polarity) => (polarity === "use" ? "use emojis" : "avoid emojis"),
    id: "emoji-policy",
    label: "emoji policy",
    patterns: [
      {
        polarity: "use",
        regex: /\b(?:use|include|allow)\s+(?:an?\s+)?emojis?\b/giu,
      },
      {
        polarity: "avoid",
        regex: /\b(?:avoid|never\s+use|do\s+not\s+use|don't\s+use|no)\s+emojis?\b/giu,
      },
    ],
  },
  {
    describePolarity: (polarity) => `${polarity} columns`,
    id: "line-width",
    label: "line-width",
    patterns: [
      {
        polarity: "$1",
        regex:
          /\b(?:line width|line length|maximum line (?:width|length)|max line (?:width|length))\s*(?::|is|of|to|at)?\s*(\d{2,3})\b/giu,
      },
    ],
  },
  {
    describePolarity: (polarity) => `${polarity} responses`,
    id: "response-detail",
    label: "response detail",
    patterns: [
      {
        polarity: "concise",
        regex:
          /\b(?:(?:be|keep (?:responses?|answers?))\s+(?:brief|concise)|(?:brief|concise)\s+(?:responses?|answers?))\b/giu,
      },
      {
        polarity: "detailed",
        regex:
          /\b(?:(?:be|provide|write)\s+(?:very\s+)?(?:detailed|thorough)|(?:detailed|thorough)\s+(?:responses?|answers?|explanations?))\b/giu,
      },
    ],
  },
];
