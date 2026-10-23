# Development Rules

## Editing TypeScript (Serena required)

- When reading, searching, or editing `.ts` / `.tsx` files, always use Serena's MCP tools.
- Start exploration with `get_symbols_overview`, then `find_symbol`, then `find_referencing_symbols`. Do not start by reading whole files or running grep.
- Edit with `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, or `rename_symbol`.
- You may use the built-in Edit / Write tools directly on `.ts` / `.tsx` files only when:
  - The change cannot be expressed at the symbol level (e.g. import cleanup, file header comments), or
  - Serena returns an error (in this case, briefly report the reason).
- If Serena is unavailable (tools not visible, or the project is not activated), report it before proceeding with any work.
