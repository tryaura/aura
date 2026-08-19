const BEGIN_MARKER = "<!-- supported-apps:begin -->";
const END_MARKER = "<!-- supported-apps:end -->";

/**
 * The legend lives inside the generated fragment so it cannot drift from the tables it explains,
 * and so a second copy in another document cannot fall out of step with the first.
 */
const LEGEND = [
  "Paths beginning with `~` are user-level configuration; paths beginning with `.` are read",
  "relative to the directory where Aura runs. A path is read only when the application it belongs",
  "to is detected, and a missing one is never an error.",
].join("\n");

/**
 * How each declared file kind is described to a reader deciding what Aura touches.
 *
 * A probe is how an adapter picks between candidates for one slot — it looks at each without
 * opening it, then reads the one the application would use. A path that is never more than a
 * probe here is one no synthesised machine selected, not one Aura declines to read.
 */
const KIND_LABELS = Object.freeze({
  config: "Settings",
  instructions: "Instructions",
  mcp: "MCP servers",
  probe: "Candidate, read when selected",
  skills: "Skills",
});

function escapeCell(value) {
  return value.replaceAll("|", "\\|");
}

function code(value) {
  return `\`${escapeCell(value)}\``;
}

function renderTable(rows) {
  const widths = rows[0].map((_cell, index) =>
    Math.max(...rows.map((row) => row[index].length), 3),
  );
  const renderRow = (row) =>
    `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
  const divider = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [renderRow(rows[0]), divider, ...rows.slice(1).map(renderRow)].join("\n");
}

function readFor(path) {
  const label = KIND_LABELS[path.kind];
  if (label === undefined) {
    throw new Error(`No documentation label for file kind ${path.kind}.`);
  }
  return path.platforms === undefined ? label : `${label} (${path.platforms.join(", ")} only)`;
}

export function renderApplicationsTable(apps) {
  return renderTable([
    ["Adapter ID", "Application", "Supported versions"],
    ...apps.map((app) => [code(app.id), escapeCell(app.displayName), code(app.supportedRange)]),
  ]);
}

export function renderPathsTable(apps) {
  return renderTable([
    ["Application", "Path", "Read for"],
    ...apps.flatMap((app) =>
      app.paths.map((path) => [escapeCell(app.displayName), code(path.path), readFor(path)]),
    ),
  ]);
}

export function renderSupportedApps(apps) {
  return [
    LEGEND,
    "",
    renderApplicationsTable(apps),
    "",
    "### Paths read",
    "",
    renderPathsTable(apps),
  ].join("\n");
}

function markerOffsets(source, marker) {
  const offsets = [];
  let offset = source.indexOf(marker);
  while (offset !== -1) {
    offsets.push(offset);
    offset = source.indexOf(marker, offset + marker.length);
  }
  return offsets;
}

export function replaceSupportedAppsFragment(source, fragment) {
  const starts = markerOffsets(source, BEGIN_MARKER);
  const ends = markerOffsets(source, END_MARKER);
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(
      `Expected exactly one supported-apps marker pair; found ${String(starts.length)} begin and ${String(ends.length)} end markers.`,
    );
  }
  if (starts[0] >= ends[0]) {
    throw new Error("The supported-apps end marker must follow its begin marker.");
  }

  const before = source.slice(0, starts[0]);
  const after = source.slice(ends[0] + END_MARKER.length);
  return `${before}${BEGIN_MARKER}\n\n${fragment.trimEnd()}\n\n${END_MARKER}${after}`;
}
