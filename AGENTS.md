## File Editing Rules
- Always use `apply_patch` for local file edits.
- Do NOT write or execute Python scripts, bash one-liners, or `cat` commands to read, create, or modify source files.
- Use a separate `apply_patch` call for each file so the user can approve or reject each file independently.
- Approval applies only to the specific file and changes approved. Approval for documentation does not authorize source-code changes, even when they belong to the same task.
- If approval is partial, denied, interrupted, or unclear, do not assume the remaining changes were approved. Check the actual file contents with a read-only tool before continuing or reporting completion.
- Never retry an unapproved edit through another tool, formatter, script, or command. Ask for approval of that specific edit before attempting it again.
- Use formatters only in check mode (for example, `cargo fmt --check`). Apply any formatting fixes through a separate `apply_patch` call for each affected file.
- After an edit, verify the resulting file contents. Report only changes that were approved and actually applied; explicitly distinguish pending or rejected changes.
