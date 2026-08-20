import type { ResolvedSkillListing } from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import type { DirectoryTruncation } from "./index-schema.js";
import type { DirectorySkillVerification } from "./listing-verification.js";

/** How a listing may use the on-disk catalog cache. */
export interface DirectoryListingOptions {
  /** Bypass catalog cache reads and writes for this run. */
  readonly noCache?: boolean | undefined;
}

/** Everything one directory listing produced, including why it produced nothing. */
export interface DirectorySkillListingResult {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly listings: readonly ResolvedSkillListing[];
  /** How the source should appear in a picker when it cannot be listed. */
  readonly status:
    | { readonly kind: "available" }
    | { readonly hint: string; readonly kind: "unavailable" };
  /** Set when the source advertised more entries than the listing cap could read. */
  readonly truncation?: DirectoryTruncation | undefined;
  /** Background verification for rows whose repository may have stopped publishing. */
  readonly verification?: DirectorySkillVerification | undefined;
}
