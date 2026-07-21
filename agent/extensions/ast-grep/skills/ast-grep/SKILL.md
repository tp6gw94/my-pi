---
name: ast-grep
description: |
  AST-structured code search and rewrite using ast_grep_search /
  ast_grep_replace tools. Use when the pattern depends on code
  structure (function/class/import/call shape) rather than plain text.
---

# ast-grep

## When to use these tools vs built-in grep

- Use `ast_grep_search` when the search depends on code structure: "find all
  `console.log` calls", "find all functions named `parse`", "find imports from
  a specific module". Plain-text grep misses structure.
- Use the built-in `grep`/`bash` `rg`/`ag`/`grep` for plain-text, regex, or
  cross-language searches where AST awareness is not needed.
- `ast_grep_replace` rewrites code structurally across many files. Prefer it
  over per-file `edit` for bulk structural changes.

## Pattern rules

- Patterns must be **complete AST nodes** — valid code in the target language.
- `$VAR` matches a **single AST node** (expression, statement, identifier).
- `$$$` matches **zero or more AST nodes** (e.g., function arguments, statement
  list).
- Patterns use meta-variables, not regex. `$MSG` is not `(.*)`.

## Tools

### ast_grep_search

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | string | AST pattern (required) |
| `lang` | string | Target language (see below) |
| `paths` | string[] | Paths to search (default: cwd) |
| `globs` | string[] | Include/exclude globs (prefix `!` to exclude) |
| `context` | number | Context lines around each match |

Returns file:line:column locations with surrounding code.

### ast_grep_replace

Same params plus:

| Param | Type | Description |
|-------|------|-------------|
| `rewrite` | string | Replacement using $VAR from pattern |
| `dryRun` | boolean | Preview only (default: **true**). Pass `false` to apply. |

`executionMode: "sequential"` — runs one at a time, never parallel.

## Languages

25 supported: bash, c, cpp, csharp, css, elixir, go, haskell, html, java,
javascript, json, kotlin, lua, nix, php, python, ruby, rust, scala, solidity,
swift, typescript, tsx, yaml.

## Prerequisite

`sg` must be on PATH. Install:

```shell
brew install ast-grep
# or: npm install -g @ast-grep/cli
# or: cargo install ast-grep --locked
```

The extension disables itself (with a console warning) if `sg` is missing.

## Examples

### Good patterns (AST-aware)

```
console.log($MSG)              → finds all console.log calls
function $NAME($$$) { $$$ }    → finds any function
import { $THING } from "..."   → finds named imports
$LEFT = $RIGHT                 → finds any assignment
class $NAME { $$$ }            → finds any class
```

### Bad patterns (plain text, not AST)

```
console\.log\(.*\)              → use ast_grep_search instead: console.log($MSG)
function\s+\w+\s*\(            → use pattern: function $NAME($$$) { $$$ }
import.*from                    → use pattern: import { $$$ } from $SRC
```
