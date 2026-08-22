# Automatic updates for standalone distributions

Status: implemented. This document describes what was built; where the implementation departed from
the original proposal, the text says so and why.

## Goal

Allow Aura's official standalone binary and enterprise standalone distributions to install a
newer release automatically at startup without updating package-manager-owned executions.

The design must:

- update only an explicitly identified standalone executable;
- never update an `npx`, `pnpm dlx`, npm-global, or source invocation;
- bind the selected version, platform artifact, size, and SHA-256 digest to one release;
- verify a staged executable before replacing the current one;
- replace the executable atomically and retain one recovery copy;
- treat update availability and installation failures as non-fatal to the requested command; and
- let an enterprise distribution authenticate without embedding a reusable credential.

## Non-goals

- Updating the published `@tryaura/aura-cli` package.
- Inferring ownership from `npm_execpath`, `PATH`, the command name, or other ambient heuristics.
- Elevating privileges or invoking `sudo`.
- Updating Windows executables in the first version. Current standalone releases target macOS and
  Linux.
- Hot-swapping the process that is already running. A successful update is used by the next
  invocation.
- Automatically rolling back after a later command fails for an application-level reason.

## Architecture

The shared updater owns eligibility, caching, locking, download limits, verification, extraction,
and atomic installation. A release provider only turns distribution-specific release metadata into
a validated candidate.

```text
standalone bootstrap
  -> eligibility gate
  -> distribution release provider
       official Aura: public GitHub latest release
       enterprise: private GitHub/GHES release or signed HTTPS manifest
  -> validated update candidate
  -> shared download and installer transaction
  -> next invocation uses the new executable
```

The compiled entry point calls `runStandaloneCli(distro, updates, process)`. The npm entry calls
`runCli`, whose signature has no update source or executable, so it cannot reach installation code.

## Public contract

The type boundary, as shipped:

```ts
export type CliUpdates = {
  readonly manualUpdateUrl?: string | undefined;
  readonly tokenEnvironmentVariable?: string | undefined;
} & (
  | {
      readonly apiBaseUrl?: string | undefined;
      readonly kind: "github-release";
      readonly owner: string;
      readonly repository: string;
    }
  | {
      readonly kind: "signed-manifest";
      readonly manifestUrl: string;
      readonly trustedPublicKeys: readonly string[];
    }
);

export declare function runStandaloneCli(
  distro: CliDistro,
  updates: CliUpdates,
  current: Pick<NodeJS.Process, "arch" | "execPath" | "platform">,
  runtime?: CliRuntime,
): Promise<CliExitCode>;
```

Only `CliUpdates` and `runStandaloneCli` are public. Release targets, validated candidates, and
installation state remain private. GitHub always requires immutable releases; its API base defaults
to `https://api.github.com`.

`manualUpdateUrl` was added during implementation: the failure message has to name somewhere to go,
and deriving a releases page from a source URL only works for one of the two provider kinds. It
falls back to `CliBranding.docsUrl`, and the sentence is dropped when a distribution defines
neither.

The updater normalizes platform and architecture to these release targets:

| Runtime platform | Runtime architecture | Release target |
| ---------------- | -------------------- | -------------- |
| `darwin`         | `arm64`              | `darwin-arm64` |
| `darwin`         | `x64`                | `darwin-x64`   |
| `linux`          | `arm64`              | `linux-arm64`  |
| `linux`          | `x64`                | `linux-x64`    |

An update provider returns only a fully validated private candidate. Credential-bearing headers
travel beside it, and the cache records only a failed version rather than reusable download data:

```ts
interface UpdateCandidate {
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly size: number;
  readonly version: string;
}
```

Provider responses are unknown input. Implementations must narrow every field without unchecked
assertions and reject ambiguous releases, duplicate target assets, non-canonical versions, missing
digests, or unexpected download origins.

## Eligibility policy

Automatic installation runs only when all of the following are true:

- the entry point called `runStandaloneCli` with its process and update source;
- the distribution version is canonical semver and is not `0.0.0`;
- the target is one of the four supported targets;
- the executable path identifies a regular file rather than a symlink;
- the invocation is a real command rather than root help, explicit help, or version output;
- the command-derived disable variable is not `off`, `0`, `false`, or `no`;
- `CI` is not set; and
- the run owns an interactive terminal, meaning all three of stdin, stdout, and stderr.

The final two constraints keep CI and scripts pinned to the binary they selected. A later explicit
`upgrade` command may support non-interactive installation, but startup mutation should remain an
interactive behavior.

## Official Aura provider

The shared GitHub provider reads a frozen policy under `distros/aura` that selects `tryaura/aura`;
private distributions cannot redirect the official binary to another repository.

It requests:

```text
GET https://api.github.com/repos/tryaura/aura/releases/latest
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
User-Agent: aura/<current-version>
```

The response is accepted only when:

- `draft` and `prerelease` are false;
- `immutable` is true;
- `tag_name` is `v` followed by canonical semver;
- the version is greater than the running version;
- exactly one uploaded asset has the expected name `aura-<target>.tar.gz`;
- the asset has a positive bounded size;
- `digest` is exactly `sha256:<64 lowercase hexadecimal characters>`; and
- `browser_download_url` is the expected immutable path under
  `https://github.com/tryaura/aura/releases/download/<tag>/`.

The GitHub API response supplies version selection and the digest in one document. No Aura web
endpoint, moving binary URL, custom update manifest, or long-lived signing key is required.

GitHub documents that public release assets can be downloaded without authentication, that asset
responses may be either `200` or `302`, and that release asset metadata carries a SHA-256 digest:

- <https://docs.github.com/en/rest/releases/assets>
- <https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases>

The trust boundary is GitHub's TLS API plus immutable-release enforcement. The existing build
provenance attestations remain useful for independent verification, but embedding a Sigstore
verifier is not required for the first updater.

### Official release workflow

Repository release immutability must be enabled before automatic installation ships. It applies
only to releases published after the setting is enabled.

The release workflow changes from direct publication to GitHub's recommended immutable sequence:

1. Build and smoke-test all four native targets as it does today.
2. Package `aura` and `LICENSE` into `aura-<target>.tar.gz`.
3. Generate `SHA256SUMS` for the shell installer and manual verification.
4. Generate the existing build provenance attestations.
5. Create a draft GitHub release for the existing tag.
6. Attach every archive and `SHA256SUMS` to the draft.
7. Confirm the draft contains the exact expected asset set.
8. Publish the draft, making its tag and assets immutable.

The updater uses GitHub's per-asset `digest`; `SHA256SUMS` remains part of the public release because
the shell installer already verifies it.

## Enterprise providers

Enterprise distributions reuse the shared updater and opt into one of two release sources.

### Private GitHub or GitHub Enterprise Server

Use the `github-release` source when the distribution is released from a private GitHub
repository or GitHub Enterprise Server instance.

The distribution configures:

- its optional API base URL, owner, and repository; and
- the name of an environment variable containing a read-only token.

The token must have only repository Contents read permission. It is read at request time, is never
stored in the update cache, and is never included in a diagnostic, subprocess environment, URL, or
cache key.

Private asset downloads use the asset API URL with `Accept: application/octet-stream`. GitHub may
return the bytes directly or redirect to a temporary signed URL. Redirect handling must:

- permit only HTTPS;
- cap the number of hops;
- strip `Authorization` before following a cross-origin redirect;
- never forward arbitrary response headers; and
- enforce the declared and absolute download-size limits while streaming.

If the server does not expose both immutable-release state and a SHA-256 asset digest, this provider
fails closed. That deployment must use the signed-manifest source instead of weakening the common
installer.

### Signed HTTPS manifest

Use the `signed-manifest` source for an internal artifact service or a GitHub Enterprise version
that lacks immutable releases or asset digests.

One stable URL returns an envelope:

```json
{
  "schemaVersion": 1,
  "payload": "<base64url encoded UTF-8 JSON>",
  "signature": "<base64url Ed25519 signature>"
}
```

The signature covers the decoded payload bytes exactly. The payload contains:

```json
{
  "version": "1.4.0",
  "expiresAt": 1760000000000,
  "assets": {
    "darwin-arm64": {
      "downloadUrl": "https://releases.acme.example/acmedev/v1.4.0/acmedev-darwin-arm64.tar.gz",
      "sha256": "<64 lowercase hexadecimal characters>",
      "size": 12345678
    }
  }
}
```

`expiresAt` is required, is epoch milliseconds, and must be in the future by no more than
`MAX_MANIFEST_FRESHNESS_MS` (30 days). A signature proves who wrote a manifest, never that it is the
newest one they wrote: without a window, anything that can serve a stale-but-valid copy freezes a
fleet on one release indefinitely, and the updater says nothing because "no newer release" is its
quiet path. The ceiling exists because a publisher who dates a manifest a decade out has satisfied
the field and rebuilt the problem. Publishers re-sign on a schedule shorter than the window.

The GitHub provider needs no equivalent: its freshness comes from an authenticated TLS request to
the API plus immutable releases, which is the trust boundary a manifest deliberately moves.

The distribution embeds one or more trusted public keys. Supporting multiple keys allows a release
signed by the old key to distribute a binary that trusts the replacement key before the old key is
retired. Private signing keys stay in release infrastructure and are never embedded in source,
metadata, or binaries.

The provider accepts credentials only through a named environment variable. As with the GitHub
provider, credentials are read at request time and are not cached or forwarded across origins.

### Enterprise release workflow

An enterprise release pipeline must:

1. Build and test every supported target on its native platform.
2. Package the executable and its license into one archive per target.
3. Compute SHA-256 and byte size for every final archive.
4. Publish archives at immutable, version-specific URLs.
5. Either publish an immutable GitHub release exposing asset digests or produce and sign the HTTPS
   manifest.
6. Move the stable latest-manifest reference only after every artifact is available.
7. Re-sign and republish the manifest on a schedule shorter than its `expiresAt` window, so a fleet
   that is genuinely current does not expire into silence.

The updater never accepts an asset URL that is merely "latest" after version resolution. Candidate
URLs must remain pinned to the selected release so a publication race cannot change the downloaded
bytes.

## Cache and check cadence

Update outcomes are cached under:

```text
~/agents/.cache/distribution-updates/<sha256(source-identity)>
```

The source identity includes the complete build-time provider and trust configuration plus the
distribution command. It includes credential variable names but never their values.

Cache policy:

- a successful current-version check is fresh for 24 hours;
- an update candidate is never installed from cache; only its failed version and attempt count are
  retained for backoff, and the source is re-resolved before every retry;
- the ETag is preserved but offered with `If-None-Match` only when the cached answer was "nothing
  newer"; an install failure asks unconditionally, since a `304` would otherwise hide the candidate
  that needs to be retried;
- transient check failures retry after one hour and remain silent;
- installation failures use bounded exponential backoff per candidate version;
- a future timestamp, oversized entry, invalid JSON, or changed source identity is a cache miss;
- cache directories use mode `0700`, files use `0600`, and writes use temporary-file rename.

## Download and installation transaction

The installer performs these steps after a provider returns a newer candidate:

1. Acquire a per-executable lock using exclusive creation. A stale lock is recoverable only after
   checking that its recorded process no longer exists and its age exceeds the timeout.
2. Re-read the installed binary's version. If another process already installed the candidate,
   stop successfully.
3. Verify that the target is still the same regular file inspected during eligibility checks.
4. Create archive and extraction temporary paths next to the executable so the final rename stays
   on one filesystem.
5. Stream the archive to disk while counting bytes and computing SHA-256. Abort on timeout, excess
   bytes, an unexpected final length, too many redirects, or digest mismatch.
6. Extract only the expected executable and `LICENSE`. The extractor allow-lists the two entry
   names and refuses everything else — absolute paths, parent traversal, duplicates, symlinks, hard
   links, directories, devices, and extension records — so no header field decides where a byte
   lands. The staged `LICENSE` replaces one the installation already keeps and is otherwise
   discarded, rather than adding a file the original install never wrote, and it carries over the
   replaced file's permissions rather than the `0600` every extracted entry starts at. An entry
   counts as extracted once its bytes are on disk, so a stream that ends mid-body fails the
   required-entry check rather than staging a truncated program.
7. Set the staged executable to the mode of the executable being replaced, and require it to be a
   regular file.
8. Run the staged executable with `--version` and automatic updates disabled. Require exact equality
   with the candidate version.
9. Sync and close the staged file.
10. Create an adjacent temporary hard link or copy of the current executable, then atomically rename
    it to `<command>.previous`.
11. Atomically rename the staged executable over the current path.
12. Sync the containing directory where supported, clean temporary files, and release the lock.

Every temporary path the transaction can create — archive, license, staged executable, and the
recovery copy — is invented in one place, so the cleanup names all of them. A path built deeper in
is a path a failed rename leaves behind, and each one is a full copy of the executable.

The currently executing process continues with its original in-memory image. It must not spawn or
re-execute the newly downloaded program in the first implementation.

## User experience

When an update is found:

```text
Updating Aura 0.5.0 -> 0.5.1...
Updated Aura to 0.5.1. The new version will be used on your next run.
```

While the archive streams, a percentage is painted between those lines and erased before the
outcome line:

```text
  Downloading… 42%
```

Drawn through `terminal-frame.ts` like the check scan's surface, and only when stderr is a terminal.
A captured or piped run is byte-identical to one where the frame never existed.

Enterprise output uses distribution branding rather than the word Aura.

Behavior by outcome:

| Outcome                        | Message                        | Requested command                           |
| ------------------------------ | ------------------------------ | ------------------------------------------- |
| Current or fresh cached check  | None                           | Runs normally                               |
| Metadata network failure       | None                           | Runs normally                               |
| Update installed               | Concise success                | Runs with the old in-memory version         |
| Download or permission failure | Warning plus manual update URL | Runs normally                               |
| Digest or signature failure    | Explicit security warning      | Runs normally; candidate is never installed |
| Another updater holds the lock | None                           | Runs normally                               |

Updater failures never change the requested command's exit code. Output goes to stderr so it cannot
corrupt stdout, but startup updates are disabled for non-interactive and machine-oriented runs in
the first version.

### Tracing a distribution that will not update

Every refusal above is silent, which is correct for a user and useless for whoever wired the
distribution up. The command-derived debug variable — `AURA_UPDATE_DEBUG` for `aura` — writes one
line per step:

```text
update: skipped: unsupported-target
update: resolved: candidate
update: installed: installed
```

Every step names its own reason rather than collapsing into one word, because the failures a
distribution author has to tell apart all look identical from the outside — a silent nothing:

| Step        | Reasons                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skipped`   | `unstamped-version`, `unsupported-target`, `informational-run`, `disabled`, `continuous-integration`, `not-a-terminal`, `not-a-regular-file`, `cached-current`, `cached-check-failed`, `cached-install-failed`, `unexpected-error` |
| `resolved`  | `candidate`, `current`, `network`, `invalid-release`, `untrusted-release`, `stale-manifest`                                                                                                                                        |
| `installed` | `installed`, `skipped`, `refused`, `failed: <reason>`                                                                                                                                                                              |

`failed:` carries the step that gave up: `lock-unavailable` (an install directory this user cannot
write to), `not-a-regular-file`, `download-network`, `download-too-large`, `download-insecure-url`,
`download-unexpected-length`, `unreadable-archive`, `unexpected-entry`, `too-large`,
`missing-executable`, `staged-version`, or `replace-failed`. `stale-manifest` is kept apart from
`untrusted-release` for the same reason: a manifest dated beyond `MAX_MANIFEST_FRESHNESS_MS` is a
publisher mistake with a publisher fix, and reporting it as a failed signature sends them hunting
for an attack.

The disable variable is the uppercased command, non-alphanumeric runs replaced by `_`, plus
`_UPDATE`; tracing appends `_DEBUG`. Both are off by default and outside the message contract.

### The wait a user actually experiences

`STARTUP_UPDATE_BUDGET_MS` bounds the whole startup update, not each step. Per-step ceilings do not
add up to a promise: metadata, a probe of the installed binary, the transfer, and a probe of the
staged one each finishing just inside their own limit is a command that has not started yet. The
budget is anchored at the moment the check begins, and the download — the one step with no natural
ceiling — is given whatever the earlier steps did not spend. A budget already exhausted yields a
transfer that aborts at once, which the transaction reports like any other failed download, and the
backoff in `cache.ts` keeps the next attempt from landing on the following command.

## Recovery

Every successful replacement retains one `<command>.previous` executable beside the installed
binary. The first implementation documents manual recovery:

```sh
mv /path/to/aura.previous /path/to/aura
```

The updater must not perform that replacement itself without explicit user confirmation. A future
`upgrade --rollback` command can validate the previous binary's version and perform the same atomic
transaction in reverse.

## Implementation layout

Proposed ownership:

```text
packages/cli/src/update/
  types.ts                 public update config and private candidate/target types
  limits.ts                every bound the updater enforces, in one place
  narrow.ts                narrowing helpers for unknown provider responses
  target.ts                release-target mapping and canonical version comparison
  eligibility.ts           the gate, resolved before any request
  cache.ts                 private update metadata cache and check cadence
  provider.ts              provider contract, dispatch, and source identity
  metadata.ts              shared bounded metadata fetch, credentials, version verdict
  github-release.ts        GitHub provider, asset selection, and URL pinning
  signed-manifest.ts       signed manifest provider and Ed25519 verification
  host.ts                  process capabilities the installer needs, as an interface
  host.boundary.ts         the real process seam: pid, signal, fork
  download.boundary.ts     bounded streaming download and redirect policy
  archive.ts               allow-listed tar extraction
  tar-header.ts            the one tar header shape accepted
  lock.ts                  concurrent updater exclusion
  stage.ts                 download, digest, extract, and verify the staged program
  install.ts               the atomic replacement transaction
  diagnostics.ts           the debug trace and the download progress frame
  run.ts                   startup orchestration and messages
  tar-fixture.ts           test-only tar writer, shared by the extractor suites
  testing.ts               test-only wired distribution, shared by the startup suites

distros/aura/src/update/
  official-source.ts       frozen tryaura/aura GitHub policy

distros/aura/src/
  standalone-main.boundary.ts  compiled-only `runStandaloneCli` bootstrap
  main.ts                      non-standalone entry without update capability
```

The two files that read ambient process state are named `*.boundary.ts`, which is the repository's
convention for making that exception visible in review rather than routing around the lint ban.

`distros/aura/build-binary.mjs` compiles `standalone-main.boundary.ts`. The public npm CLI continues
to use `packages/cli/src/bin.ts` and cannot enter the installer.

## Verification plan

### Unit tests

- Narrow valid and hostile GitHub release responses from `unknown`.
- Reject mutable, draft, prerelease, malformed, duplicate, oversized, and mismatched assets.
- Verify target mapping and canonical semver ordering, including prereleases.
- Verify signed envelopes, altered payloads, unknown keys, and key rotation.
- Verify credential headers are absent from caches, messages, redirects, and subprocesses.
- Verify ETag caching, future timestamps, stale retries, and failure backoff.
- Verify redirect limits, HTTPS enforcement, authorization stripping, length limits, and digests.
- Verify lock contention and stale-lock recovery.
- Verify symlink refusal, staged-version mismatch, atomic replacement, recovery copy, and cleanup.

### Integration tests

- Exercise official and authenticated enterprise providers against loopback fixtures only.
- Install over a temporary standalone executable and prove the next invocation reports the new
  version.
- Prove the current invocation completes with its original version and exit code.
- Prove `npx`-shaped, npm-global-shaped, source, CI, non-TTY, and `0.0.0` runs do not make update
  requests or filesystem changes.
- Run concurrent invocations and prove only one download and replacement succeeds.
- Cover read-only directories and interrupted downloads without damaging the installed executable.

All of the above landed together, in `packages/cli/src/update/*.test.ts`.
`install.integration.test.ts` exercises the whole chain — real narrowing, real streaming download,
real extraction, a real fork to verify the staged program, and a real rename — against loopback
fixtures through `runStandaloneCli`.

### Release and binary verification

- Extend workflow verification to require the exact four archive names and `SHA256SUMS` before a
  release is published.
- Read each built archive back with `scripts/verify-archive.mjs`, which parses the tar the way the
  extractor does and asserts exactly `aura` and `LICENSE` as plain files. `tar -t` cannot do this
  job: it merges AppleDouble sidecars back in and reports nothing. macOS packaging sets
  `COPYFILE_DISABLE=1` so `bsdtar` does not write one for the executable's extended attributes in
  the first place; the read-back is what would catch it if a future step reintroduced one.
- Assert every draft asset exposes a usable SHA-256 digest before publishing, and that the published
  release is immutable afterwards. Immutability is the one assertion that cannot run against a
  draft — GitHub decides it at publication — so a failure there means fixing the repository setting
  and cutting a new tag rather than correcting the release in place.
- Extend compiled smoke tests to inject a local update source and verify update eligibility without
  contacting GitHub.
- Run the full repository gate with `pnpm verify` and compiled verification with
  `pnpm verify:binary`.

## Delivery

Everything below shipped together rather than in stages; the sequence is kept as the review order.

1. Publication changed to draft, attach, verify, publish, then assert immutability and per-asset
   digests. **Repository immutable releases must be enabled in Settings → General before the first
   release ships**, or the workflow's final assertion fails the release.
2. Shared update types, the explicit standalone capability, the cache, and the installer
   transaction.
3. The GitHub release provider, public and authenticated.
4. The compiled official entry point, with binary smoke coverage and a test pinning the wiring.
5. The enterprise GitHub/GHES configuration, documented and compiled in
   `examples/acme-distribution`, which the clean-room packaging check builds from the packed
   tarballs.
6. The signed-manifest provider.
7. The CLI UX contract, distribution guide, installation page, and recovery instructions.

Automatic updates become effective one release after the updater first ships: the first release
contains the updater, and the following immutable release is the first candidate it can install.
