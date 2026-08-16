interface ContradictionPattern {
  /** `$1`, `$2`, and so on are replaced with captured values from {@link regex}. */
  readonly polarity: string;
  readonly regex: RegExp;
}

export interface ContradictionAxis {
  readonly id: string;
  readonly label: string;
  readonly patterns: readonly ContradictionPattern[];
}

/** Cheap, curated contradiction classes. Additions require positive and near-miss fixtures. */
export const CONTRADICTION_AXES: readonly ContradictionAxis[] = [
  {
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
