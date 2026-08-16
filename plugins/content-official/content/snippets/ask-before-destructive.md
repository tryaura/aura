# Ask before destructive operations

- Ask for confirmation before deleting files, discarding changes, rewriting history, force-pushing, or applying irreversible migrations.
- Name the exact targets and likely impact before requesting confirmation.
- Prefer a recoverable operation when it meets the same goal.
- Confirm that backups or rollback steps exist before changing durable data.
- Never bypass validation hooks or safety checks to make an operation succeed.
- Stop when the target or scope is ambiguous and request clarification.
