import type {
  AuraConfigurationLayer,
  AuraConfigurationProvenance,
  AuraEffectiveCheckConfiguration,
  AuraEffectiveConfig,
  AuraEffectivePreset,
  AuraEffectiveValue,
  Check,
  JsonObject,
  JsonValue,
  Severity,
} from "@tryaura/aura-sdk";
import { defineOwnProperty } from "@tryaura/aura-sdk";

import {
  collectValues,
  lastAllowedSources,
  lastValues,
  type NamedLayer,
} from "./configuration-layers.js";

const EMPTY_THRESHOLDS: JsonObject = Object.freeze({});

export interface EffectiveConfigInput {
  readonly checks: readonly Check[];
  readonly cli?: AuraConfigurationLayer | undefined;
  readonly distro?: AuraConfigurationLayer | undefined;
  readonly knownMcpServers?: ReadonlySet<string> | undefined;
  readonly manifest?: AuraConfigurationLayer | undefined;
  readonly preset?: AuraConfigurationLayer | undefined;
  readonly selectedPreset?: AuraEffectivePreset | undefined;
}

export type EffectiveConfigResult =
  | { readonly config: AuraEffectiveConfig; readonly status: "ready" }
  | { readonly problems: readonly string[]; readonly status: "invalid" };

interface MutableCheckConfiguration {
  enabled: AuraEffectiveValue<boolean>;
  severity: AuraEffectiveValue<Severity>;
  thresholds: AuraEffectiveValue<JsonObject>;
}

/** Resolves every configuration layer and records the winner for every effective value. */
export function resolveEffectiveConfig(input: EffectiveConfigInput): EffectiveConfigResult {
  const defaults = provenance("default", "built-in defaults");
  const checks = new Map<string, MutableCheckConfiguration>();
  for (const check of input.checks) {
    checks.set(check.id, {
      enabled: effective(true, defaults),
      severity: effective(check.defaultSeverity, defaults),
      thresholds: effective(EMPTY_THRESHOLDS, defaults),
    });
  }

  const layers = namedLayers(input);
  const problems: string[] = [];
  for (const layer of layers) {
    applyChecks(checks, layer, problems);
  }
  validateThresholds(input.checks, checks, problems);
  validateRequiredMcpServers(layers, input.knownMcpServers, problems);
  if (problems.length > 0) {
    return { problems: Object.freeze(problems), status: "invalid" };
  }

  const effectiveChecks: Record<string, AuraEffectiveCheckConfiguration> = {};
  for (const [id, check] of checks) {
    defineOwnProperty(effectiveChecks, id, Object.freeze({ ...check }));
  }

  return {
    config: Object.freeze({
      ...lastAllowedSources(layers),
      checks: Object.freeze(effectiveChecks),
      ...(input.selectedPreset === undefined
        ? {}
        : { preset: Object.freeze({ ...input.selectedPreset }) }),
      requiredMcpServers: collectValues(layers, "requiredMcpServers"),
      skillDirectories: collectValues(layers, "skillDirectories"),
      skills: lastValues(layers, "skills"),
      snippets: lastValues(layers, "snippets"),
    }),
    status: "ready",
  };
}

/**
 * Returns one check's effective settings, falling back to what the check declares for itself.
 *
 * Every registered check is resolved at boot, so the fallback is for a check the configuration
 * never saw — a registry assembled after resolution, or a caller that resolved a subset. That is a
 * wiring mistake, not a user error, and reporting the check's own defaults tells the truth about
 * what will happen where raising would cost the user the whole command.
 */
export function effectiveCheckConfiguration(
  check: Check,
  config: AuraEffectiveConfig,
): AuraEffectiveCheckConfiguration {
  const defaults = provenance("default", "built-in defaults");
  return (
    config.checks[check.id] ??
    Object.freeze({
      enabled: effective(true, defaults),
      severity: effective(check.defaultSeverity, defaults),
      thresholds: effective(EMPTY_THRESHOLDS, defaults),
    })
  );
}

/** Filters the registry while retaining all checks in the effective configuration for explanation. */
export function enabledChecks(
  checks: readonly Check[],
  config: AuraEffectiveConfig,
): readonly Check[] {
  return Object.freeze(checks.filter((check) => config.checks[check.id]?.enabled.value !== false));
}

function namedLayers(input: EffectiveConfigInput): readonly NamedLayer[] {
  const selected = input.selectedPreset;
  return [
    ...(input.distro === undefined
      ? []
      : [{ config: input.distro, provenance: provenance("distro", "distribution defaults") }]),
    ...(input.preset === undefined
      ? []
      : [
          {
            config: input.preset,
            provenance: provenance("preset", selected?.name ?? "team preset"),
          },
        ]),
    ...(input.manifest === undefined
      ? []
      : [{ config: input.manifest, provenance: provenance("manifest", "user manifest") }]),
    ...(input.cli === undefined
      ? []
      : [{ config: input.cli, provenance: provenance("cli", "command line") }]),
  ];
}

// fallow-ignore-next-line complexity -- applies four independent check maps with identical layer precedence.
function applyChecks(
  checks: ReadonlyMap<string, MutableCheckConfiguration>,
  layer: NamedLayer,
  problems: string[],
): void {
  const configured = layer.config.checks;
  if (configured === undefined) {
    return;
  }
  for (const id of configured.enabled ?? []) {
    const check = checks.get(id);
    if (check === undefined) {
      problems.push(`Unknown check ID ${id} in ${layer.provenance.label}.`);
    } else {
      check.enabled = effective(true, layer.provenance);
    }
  }
  for (const id of configured.disabled ?? []) {
    const check = checks.get(id);
    if (check === undefined) {
      problems.push(`Unknown check ID ${id} in ${layer.provenance.label}.`);
    } else {
      check.enabled = effective(false, layer.provenance);
    }
  }
  for (const [id, severity] of Object.entries(configured.severity ?? {})) {
    const check = checks.get(id);
    if (check === undefined) {
      problems.push(`Unknown check ID ${id} in ${layer.provenance.label}.`);
    } else {
      check.severity = effective(severity, layer.provenance);
    }
  }
  for (const [id, thresholds] of Object.entries(configured.thresholds ?? {})) {
    const check = checks.get(id);
    if (check === undefined) {
      problems.push(`Unknown check ID ${id} in ${layer.provenance.label}.`);
    } else {
      check.thresholds = effective(freezeJsonObject(thresholds), layer.provenance);
    }
  }
}

/**
 * Rejects thresholds their own check refuses, naming the layer that set them.
 *
 * Only configured values are offered: the built-in default is empty, and asking a check to
 * validate the absence of a setting would make every tunable mandatory.
 */
function validateThresholds(
  registry: readonly Check[],
  checks: ReadonlyMap<string, MutableCheckConfiguration>,
  problems: string[],
): void {
  for (const check of registry) {
    const configured = checks.get(check.id);
    if (
      check.validateThresholds === undefined ||
      configured === undefined ||
      configured.thresholds.provenance.layer === "default"
    ) {
      continue;
    }
    const problem = check.validateThresholds(configured.thresholds.value);
    if (problem !== undefined) {
      problems.push(
        `Invalid thresholds for check ${check.id} in ${configured.thresholds.provenance.label}: ${problem}`,
      );
    }
  }
}

function validateRequiredMcpServers(
  layers: readonly NamedLayer[],
  known: ReadonlySet<string> | undefined,
  problems: string[],
): void {
  if (known === undefined) {
    return;
  }
  for (const layer of layers) {
    for (const id of layer.config.requiredMcpServers ?? []) {
      if (!known.has(id)) {
        problems.push(`Unknown required MCP server ${id} in ${layer.provenance.label}.`);
      }
    }
  }
}

function provenance(
  layer: AuraConfigurationProvenance["layer"],
  label: string,
): AuraConfigurationProvenance {
  return Object.freeze({ label, layer });
}

function effective<T>(value: T, source: AuraConfigurationProvenance): AuraEffectiveValue<T> {
  return Object.freeze({ provenance: source, value });
}

function freezeJsonObject(value: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    defineOwnProperty(result, key, freezeJsonValue(candidate));
  }
  return Object.freeze(result);
}

function freezeJsonValue(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    return Object.freeze(value.map(freezeJsonValue));
  }
  return typeof value === "object" && value !== null ? freezeJsonObject(value) : value;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
