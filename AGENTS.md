# Development Rules

## Editing TypeScript (Serena required)

- When reading, searching, or editing `.ts` / `.tsx` files, always use Serena's MCP tools.
- Start exploration with `get_symbols_overview`, then `find_symbol`, then `find_referencing_symbols`. Do not start by reading whole files or running grep.
- Edit with `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, or `rename_symbol`.
- You may use the built-in Edit / Write tools directly on `.ts` / `.tsx` files only when:
  - The change cannot be expressed at the symbol level (e.g. import cleanup, file header comments), or
  - Serena returns an error (in this case, briefly report the reason).
- If Serena is unavailable (tools not visible, or the project is not activated), report it before proceeding with any work.

## Delegating to other agents (herdr required)

- When delegating a task to another agent, always launch it through a herdr pane. Do not substitute built-in subagent features or directly spawned processes.
- Every delegation must include these three things in the task instructions:
  1. Goal (what "done" looks like)
  2. Scope (target files and directories)
  3. Rules to follow (pass along the contents of this file, or point to it explicitly)
- Delegate independent tasks in parallel. Delegate dependent tasks sequentially.
- Review the delegated agent's result yourself before adopting it. Do not report a task as complete before verifying.
- If herdr is unavailable, do not silently fall back to another method. Report the problem and wait for instructions.
