/**
 * `src/index.release.ts` hand-declares the published entry point so the emitted `.d.ts` never
 * reaches into Aura's private core package the way `src/run.boundary.ts` does. Nothing in the compiler
 * relates that declaration back to the implementation it stands for, so a signature change in
 * `runCli` would otherwise ship types that quietly disagree with the shipped runtime.
 *
 * Both directions are asserted: one-way assignability would still accept a declaration that
 * widened a parameter or narrowed the return type.
 */
type Implementation = typeof import("../src/run.boundary.js").runCli;
type Declaration = typeof import("../src/index.release.js").runCli;

declare const implementation: Implementation;
declare const declaration: Declaration;

export const declarationMatchesImplementation: Declaration = implementation;
export const implementationMatchesDeclaration: Implementation = declaration;

type StandaloneImplementation = typeof import("../src/run.boundary.js").runStandaloneCli;
type StandaloneDeclaration = typeof import("../src/index.release.js").runStandaloneCli;

declare const standaloneImplementation: StandaloneImplementation;
declare const standaloneDeclaration: StandaloneDeclaration;

export const standaloneDeclarationMatchesImplementation: StandaloneDeclaration =
  standaloneImplementation;
export const standaloneImplementationMatchesDeclaration: StandaloneImplementation =
  standaloneDeclaration;

type SinkImplementation = typeof import("../src/http-telemetry-sink.js").createHttpTelemetrySink;
type SinkDeclaration = typeof import("../src/index.release.js").createHttpTelemetrySink;

declare const sinkImplementation: SinkImplementation;
declare const sinkDeclaration: SinkDeclaration;

export const sinkDeclarationMatchesImplementation: SinkDeclaration = sinkImplementation;
export const sinkImplementationMatchesDeclaration: SinkImplementation = sinkDeclaration;
