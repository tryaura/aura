# Acme release checklist

A reference file in a nested skill directory. Nothing lists it by name: `build.mjs` derives every
content entrypoint from the directory, so adding a file here is enough to get it into the binary.

- Confirm `service.yaml` names a current owner and deployment target.
- Confirm the release checks passed on the commit being shipped, not on a later one.
- Confirm the rollback plan names a specific prior version.
- Confirm the rollout window avoids an existing change freeze.
