---
name: rea-figma-design
description: Query and audit a Rea-FigmaDesign Figma AST graph — screens, families, styles, taxonomy labels, per-category page/ID reports, generation labels and health checks.
whenToUse: Use inside the Rea-FigmaDesign repo, or when the user asks about Figma AST graph data, screen taxonomy categories, which pages contain a category, node ID lookup, graph health, or label coverage.
metadata:
  version: "1.2.0"
  owner: rea-figma
---

# Rea-FigmaDesign

Use the local SQLite graph exported from Figma. Never invent screen IDs, names or counts.

## Repo location (cross-directory)

- If your current working directory is the `rea-figma` repo, run `npm run ...` directly.
- If invoked from another directory via an installed skill, locate the checkout from `<skill-dir>/.repo-root` (written by `scripts/install-skill.sh`) or `$REA_FIGMA_ROOT`, and run `npm --prefix <repo-root> run ...`.

## Prerequisites

~~~bash
npm run doctor      # environment gate; stop on FAIL
npm run health      # graph consistency; stop on FAIL
~~~

- Graph lives at `data/<file-key>/graph.sqlite`; tools resolve the newest one automatically.
- The WebSocket server (`npm run start:server`) is only needed to ingest a new export, not for queries.
- Labels: `labels/screens-v2.json` (major + one-level minor + generation).

## Choose a tool

| Need | Use |
|---|---|
| Which categories exist right now? | MCP `list_categories` or `npm run report:categories` |
| Which pages contain category X, with IDs? | MCP `category_report` or `npm run report:category -- <category>` |
| Visual human review / spot-check / cold-start AST grouping | MCP `build_review_board` or `npm run review:board -- [--unlabeled \| --category X \| --sample N \| --ids a,b]` |
| Graph health / integrity audit | MCP `health_check` or `npm run health` |
| List screens by archetype / counts / v2 labels | MCP `list_screens` (or `npm run query -- sheets --unique`) |
| One screen feature card | MCP `screen_sheet` (or `npm run query -- sheet <id>`) |
| Structural family / variants | MCP `screen_family`, `screen_variants` |
| Compare two screens | MCP `diff_screens` (or `npm run query -- diff <a> <b>`) |
| Similar screens | MCP `find_similar` (or `npm run query -- find <id>`) |
| Style fingerprint | MCP `style_profile` (or `npm run query -- profile <id>`) |
| Update v2 labels (with preview & confirmation) | MCP `apply_labels` (`dryRun: true`, then `confirm: true`) |
| Tier 1 / sample / hidden | `npm run tier1`, `npm run sample`, `npm run hidden` |
| Tier 1.5 onion grouping | `npm run tier15` |
| UX spatial features (15) | `npm run ux -- <node-id>` |
| Detach synthetic recall | `npm run detach` |

If MCP is not mounted in the host environment, fall back to the corresponding CLI command above.

## Part 2 analysis (CLI only)

Tier 1.5 onion grouping, UX spatial features and detach recall are CLI tools; they are not exposed as MCP tools yet. Do not present them as production classifiers before the designer confirms the metric.

## Visual human-review workflow (important)

Whenever a task involves human review, spot-checking, cold-start AST labeling, or fixing misclassifications, generate the visual review workbench instead of asking the user to inspect raw IDs one by one in chat:

~~~bash
npm run review:board -- --unlabeled          # cold-start AST-grouped screens
npm run review:board -- --category 收銀台     # audit one category
npm run review:board -- --sample 15          # stratified spot-check
npm run review:board -- --ids 1:1,2:2 --open # targeted check & open browser
~~~

Tell the user to open `.scratch/review.html`, leave blank any item that looks fine, type freeform feedback only where something is wrong, and click **"複製為 Agent 提示詞"** to paste back. When the user pastes that prompt back, preview changes with `apply_labels(dryRun: true)` and wait for confirmation before writing `labels/screens-v2.json`.

## Category report (most common ask)

~~~bash
npm run report:categories
npm run report:category -- 收銀台
~~~

Output: total screens, page count, then one Figma page section with one node ID per line (saved to `.scratch/rea-figma-category-<category>.md`; pass `--no-file` for stdout only).
Report back with: category, total, page count, per-page counts, and at least 3 IDs as evidence.
Never silently truncate; always show total vs shown.

## Taxonomy

Six majors: `老UI`, `新UI`, `系統UI`, `彈窗類`, `頁面類`, `廢棄`.
Minor is exactly one level. Generation (`old`/`new`) is a separate axis, not a minor.
Page-class currently has 30 minors; read `labels/screens-v2.json` for the source of truth.

## Contracts

1. IDs must exist in SQLite; if missing, report the error instead of substituting.
2. Every count must be reproducible from the graph.
3. Attach node IDs so a designer can paste them back into Figma.
4. `unknown` is a valid answer; do not guess a category.
5. Read-only tools must not write the DB; writes need explicit confirmation.
6. No silent sampling; show total and shown counts.
7. Full agent manual: `docs/SKILL.md`.

## Stop conditions

- `health` FAIL (`staging > 0`, `SYNCING > 0`, page/node mismatch)
- requested ID not found in the graph
- category does not exist in `labels/screens-v2.json`
- asked to write labels without explicit confirmation

## Known limits

- Generation minors are mostly empty by design (generation and function are separate).
- Review board slash command (`/rea-figma-review`) needs the DSH plugin `dist` rebuilt/restarted after plugin code changes.
