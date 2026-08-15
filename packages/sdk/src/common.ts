export type Scope = "global" | "project";

export type Severity = "error" | "info" | "warn";

export type Fixability = "auto" | "guided" | "manual";

export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type JsonObject = Readonly<Record<string, JsonValue>>;
