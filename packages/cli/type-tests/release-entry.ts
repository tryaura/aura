/**
 * `src/index.release.ts` hand-declares the published entry point so the emitted `.d.ts` never
 * reaches into Aura's private core package the way `src/run.ts` does. Nothing in the compiler
 * relates that declaration back to the implementation it stands for, so a signature change in
 * `runCli` would otherwise ship types that quietly disagree with the shipped runtime.
 *
 * Both directions are asserted: one-way assignability would still accept a declaration that
 * widened a parameter or narrowed the return type.
 */
type Implementation = typeof import("../src/run.js").runCli;
type Declaration = typeof import("../src/index.release.js").runCli;

declare const implementation: Implementation;
declare const declaration: Declaration;

export const declarationMatchesImplementation: Declaration = implementation;
export const implementationMatchesDeclaration: Implementation = declaration;
