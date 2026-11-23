---
name: rea-figma-design
description: Query and audit a Rea-FigmaDesign Figma AST graph — screens, families, styles, taxonomy labels, per-category page/ID reports, generation labels and health checks.
whenToUse: Use inside the Rea-FigmaDesign repo, or when the user asks about Figma AST graph data, screen taxonomy categories, which pages contain a category, node ID lookup, graph health, or label coverage.
metadata:
  version: "1.0.0"
  owner: rea-figma
---

# Rea-FigmaDesign

Use the local SQLite graph exported from Figma. Never invent screen IDs, names or counts.

## Prerequisites

~~~bash
npm run doctor      # environment gate; stop on FAIL
npm run health      # graph consistency; stop on FAIL
~~~

- Graph lives at data/<file-key>/graph.sqlite; tools resolve the newest one automatically.
- The WebSocket server (npm run start:server) is only needed to ingest a new export, not for queries.
- Labels: labels/screens-v2.json (major + one-level minor + generation).

## Choose a tool

| Need | Use |
|---|---|
| Which pages contain category X, with IDs? | npm run report:category -- <category> |
| Which categories exist right now? | npm run report:categories |
| List screens by archetype / counts | MCP list_screens |
| One screen feature card | MCP screen_sheet |
| Structural family / variants | MCP screen_family, screen_variants |
| Compare two screens | MCP diff_screens |
| Similar screens | MCP find_similar |
| Style fingerprint | MCP style_profile |
| Pending taxonomy queue | MCP review_queue |
| Health / regression | npm run health, npm run tier1 |
| Random human spot-check list | npm run sample |
| Hidden (opacity <=35%) screens | npm run hidden |
| Tier 1.5 onion grouping | npm run tier15 |
| UX spatial features (15) | npm run ux -- node-id |
| Detach synthetic recall | npm run detach |

## Part 2 analysis (CLI only)

Tier 1.5 onion grouping, UX spatial features and detach recall are CLI tools; they are not exposed as MCP tools yet. Do not present them as production classifiers before the designer confirms the metric.

## Category report (most common ask)

~~~bash
npm run report:category -- 收銀台
~~~

Output: total screens, page count, then one Figma page section with one node ID per line.
Report back with: category, total, page count, per-page counts, and at least 3 IDs as evidence.
Never silently truncate; always show total vs shown.

## Taxonomy

Six majors: 老UI, 新UI, 系統UI, 彈窗類, 頁面類, 廢棄.
Minor is exactly one level. Generation (old/new) is a separate axis, not a minor.
Page-class currently has 30 minors; read labels/screens-v2.json for the source of truth.

## Contracts

1. IDs must exist in SQLite; if missing, report the error instead of substituting.
2. Every count must be reproducible from the graph.
3. Attach node IDs so a designer can paste them back into Figma.
4. unknown is a valid answer; do not guess a category.
5. Read-only tools must not write the DB; writes need explicit confirmation.
6. No silent sampling; show total and shown counts.
7. Full agent manual: docs/SKILL.md.

## Stop conditions

- health FAIL (staging > 0, SYNCING > 0, page/node mismatch)
- requested ID not found in the graph
- category does not exist in labels/screens-v2.json
- asked to write labels without explicit confirmation

## Known limits

- MCP / legacy query commands still read labels/screens.json (empty); screens-v2 is the new source.
- Generation minors are mostly empty by design (generation and function are separate).
- review board command needs the DSH plugin dist rebuilt/restarted after changes.

