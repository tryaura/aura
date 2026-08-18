---
name: acme-release
description: Prepare and validate an Acme service release.
metadata:
  version: 1.0.0
---

# Acme release

1. Read `service.yaml` and identify the owner and deployment target.
2. Run the repository's release checks.
3. Summarize the version, rollout plan, and rollback plan.
4. Stop before publishing or deploying unless the user explicitly asks for it.
