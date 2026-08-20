import type { ResolvedSkillListing } from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import type { DirectorySkillVerification } from "./listing-verification.js";

/** Everything one directory listing produced, including why it produced nothing. */
export interface DirectorySkillListingResult {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly listings: readonly ResolvedSkillListing[];
  /** How the source should appear in a picker when it cannot be listed. */
  readonly status:
    | { readonly kind: "available" }
    | { readonly hint: string; readonly kind: "unavailable" };
  /** Background verification for rows whose repository may have stopped publishing. */
  readonly verification?: DirectorySkillVerification | undefined;
}
