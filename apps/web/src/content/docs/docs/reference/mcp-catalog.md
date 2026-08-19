---
title: MCP catalog
description: Plugin MCP server schema, credential references, and application compatibility.
---

An MCP catalog entry is a versioned JSON document describing one credential-safe server template.
A plugin references the file from its `mcpCatalog` contribution; Aura validates it before making
the server available to setup or team presets.

```json
{
  "schemaVersion": 1,
  "id": "acme/source-control",
  "name": "Acme source control",
  "serverName": "acme-source-control",
  "description": "Search Acme repositories, pull requests, and code owners.",
  "docsUrl": "https://engineering.acme.example/mcp/source-control",
  "credentialEnv": [
    {
      "name": "ACME_SOURCE_TOKEN",
      "description": "Authenticates to Acme source control.",
      "setupUrl": "https://engineering.acme.example/tokens"
    }
  ],
  "supportedApps": ["acme-agent", "claude-code", "codex", "cursor"],
  "transportTemplate": {
    "type": "http",
    "url": "https://mcp.acme.example/source-control",
    "headers": {
      "Authorization": "Bearer ${ACME_SOURCE_TOKEN}"
    }
  }
}
```

## Catalog fields

| Field               | Required | Meaning                                                                                         |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `schemaVersion`     | Yes      | Must be `1`.                                                                                    |
| `id`                | Yes      | Stable plugin-namespaced catalog ID, such as `acme/source-control`.                             |
| `name`              | Yes      | Human-readable catalog name.                                                                    |
| `serverName`        | Yes      | Default configuration key. It may contain letters, digits, `.`, `_`, and `-`.                   |
| `description`       | Yes      | One sentence describing what the server provides.                                               |
| `docsUrl`           | Yes      | Absolute HTTP(S) documentation URL without embedded credentials.                                |
| `credentialEnv`     | Yes      | Credential environment variables used by the transport. Use an empty array when there are none. |
| `supportedApps`     | No       | Adapter IDs this template supports. Omit it when the catalog imposes no application limit.      |
| `transportTemplate` | Yes      | Credential-safe `stdio` or `http` transport written into desired state when selected.           |

`serverName` cannot contain `..` or use the reserved names `__proto__`, `prototype`, or
`constructor`. Every `supportedApps` entry is a unique lowercase application ID.

The catalog document and its plugin contribution both carry `id`, `name`, and `description`.
All three values must match exactly. Aura rejects the entry rather than showing metadata for one
server and installing another.

`supportedApps` is a catalog-level compatibility allowlist. When present, setup offers the server
only for those adapter IDs. The adapter must still be available, detected, managed by Aura, on a
supported version, and able to write MCP configuration. When omitted, those ordinary eligibility
checks apply without an additional catalog restriction.

## Credentials

`credentialEnv` contains objects with these fields:

| Field         | Required | Meaning                                                               |
| ------------- | -------- | --------------------------------------------------------------------- |
| `name`        | Yes      | Uppercase environment-variable name, never `NAME=value` or the value. |
| `description` | Yes      | Why the server needs the credential.                                  |
| `setupUrl`    | No       | Absolute HTTP(S) page where a user can configure the credential.      |

Every variable referenced by the transport must be declared exactly once in `credentialEnv`.
Definitions must never contain credential values in commands, arguments, URLs, headers, metadata,
or the compiled binary.

## Transport templates

A stdio transport accepts these fields:

| Field     | Required | Meaning                                                                  |
| --------- | -------- | ------------------------------------------------------------------------ |
| `type`    | Yes      | Must be `"stdio"`.                                                       |
| `command` | Yes      | Non-empty executable name or absolute path without a credential literal. |
| `args`    | No       | Command arguments. Credential literals are rejected.                     |
| `env`     | No       | Unique environment-variable names also declared in `credentialEnv`.      |

Entries such as `"TOKEN=value"` are invalid in `env`: the array contains names, not assignments.

An HTTP transport accepts these fields:

| Field     | Required | Meaning                                                                        |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `type`    | Yes      | Must be `"http"`.                                                              |
| `url`     | Yes      | Absolute HTTP(S) endpoint without embedded credentials or credential literals. |
| `headers` | No       | Header names mapped to credential-reference templates.                         |

Header values use templates such as `"Authorization": "Bearer ${TOKEN}"`. Every value must
contain at least one `${TOKEN}` environment-variable reference declared in `credentialEnv`; a
literal token is never valid. Text outside references is limited to short authentication-scheme
framing rather than arbitrary secret-bearing content.
