# PLAN.md — Rea-FigmaDesign Phase 1 execution contract (as built)

> **Target executor:** DeepSeek V4.1 Flash via `dsh`  
> **Status:** COMPLETE — all five terminal assertions pass on Node 24.17.0 / macOS.  
> This is the enforceable contract behind this repository. The source of truth for shapes is `shared/protocol.ts` and `server/db.ts`; this file records the boundaries and the acceptance gates.

---

## 0. CRITICAL CONSTRAINTS — do not violate

1. **Dual-thread isolation**
   - `plugin/src/code.ts` runs in Figma’s QuickJS sandbox: `figma.*` only, **never** `WebSocket`, `window` or DOM.
   - `plugin/ui.html` runs in the iframe: `WebSocket` only, **never** `figma.*`.
   - One legal path: `code.ts → figma.ui.postMessage → ui.html → ws://localhost:8765` (server binds `127.0.0.1`).

2. **`documentAccess: "dynamic-page"`**
   - Manifest must keep `"documentAccess": "dynamic-page"`.
   - `await page.loadAsync()` before touching `page.children`.
   - `await instance.getMainComponentAsync()` — never sync `.mainComponent`.
   - `await figma.variables.getLocalVariablesAsync()` and `getLocalVariableCollectionsAsync()` — never sync getters.

3. **Guard `figma.mixed`**
   - `isMixed(v)` checks `v === figma.mixed` before arrays, maps or JSON.
   - Convert every mixed value to the literal string `"MIXED"`.

4. **Chunked streaming**
   - `BATCH_SIZE = 500`. Flush node rows as `CHUNK_NODES` after each full batch.
   - `await new Promise(r => setTimeout(r, 0))` after every flush.
   - Server commits each chunk in one `db.transaction()` using prepared `INSERT OR REPLACE`.

5. **Vector dehydration**
   - Never read `vectorPaths` or `vectorNetwork`.
   - If a container is ≤64×64 and every descendant is vector geometry, set `is_icon_container = 1` and stop walking its children.

6. **Stack lock**
   - Only `better-sqlite3`, `ws`, `esbuild`, `tsx`, TypeScript.
   - No Prisma / TypeORM / React / Vite / Webpack. `ui.html` is one self-contained file.

---

## 1. Target tree

```text
rea-figma/
├── package.json
├── tsconfig.json
├── shared/protocol.ts
├── server/db.ts
├── server/ws-server.ts
├── server/verify-mock.ts
├── plugin/manifest.json
├── plugin/ui.html
├── plugin/src/serializer.ts
└── plugin/src/code.ts
```

Plus the built `plugin/dist/code.js` (esbuild output, required by Figma) and the optional `docs/architecture-widget.html` walkthrough.

---

## 2. Contracts

### 2.1 Wire format (`shared/protocol.ts`)

| Type | Payload |
| --- | --- |
| `SYNC_START` | `FileMetaPayload` |
| `CHUNK_VARIABLES` | `VariableRow[]` |
| `CHUNK_COMPONENTS` | `ComponentRow[]` |
| `CHUNK_NODES` | `NodeRow[]` |
| `SYNC_COMPLETE` | `{ total_nodes: number; duration_ms: number }` |

`NodeRow` is 22 columns: identity/hierarchy, `visible`, `main_component_id`, `is_icon_container`, `layout_mode`, `layout_props_json`, bbox, `style_json`, `bound_variables_json`, text fields and `reactions_json`.

### 2.2 ACK envelope

Every accepted frame is acknowledged **after** the SQLite commit:

```json
{ "status": "OK", "receivedType": "CHUNK_NODES", "count": 500 }
```

Rejected frames: `{ "status": "ERROR", "receivedType": "...", "error": "..." }`. The UI marks the run incomplete on any rejected/dropped frame.

### 2.3 SQLite (`server/db.ts`)

- `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL`.
- Tables: `file_meta`, `variables`, `components`, `nodes`.
- Indexes: `idx_nodes_parent`, `idx_nodes_page`, `idx_nodes_type`, `idx_nodes_main_comp`, `idx_variables_name`.
- `SYNC_START`: one transaction deleting all four tables, then inserting the new `file_meta` row.
- Each chunk: one transaction over prepared `INSERT OR REPLACE` statements.
- `SYNC_COMPLETE`: `UPDATE file_meta SET total_nodes = ?`.
- Public API: `resetAndInitFile`, `insertVariablesBatch`, `insertComponentsBatch`, `insertNodesBatch`, `finalizeSync`, `getStats`, `close`.

---

## 3. Steps and terminal assertions

| Step | Implementation | Terminal assertion | Status |
| --- | --- | --- | --- |
| 1 | Scaffold, `package.json`, `tsconfig.json`, `shared/protocol.ts` | `npx tsc --noEmit shared/protocol.ts` | **PASS** |
| 2 | `AstGraphDB` + `startIngestServer` on `127.0.0.1:8765`, `maxPayload 50 MB` | `npx tsc --noEmit server/db.ts server/ws-server.ts` | **PASS** |
| 3 | `manifest.json`, `serializer.ts`, `code.ts` | `npm run build:plugin && test -s plugin/dist/code.js` | **PASS** (18.1 KB) |
| 4 | `ui.html` reconnect/progress relay | manual Figma UI; headless DOM/CDP interaction and exception check | **PASS** |
| 5 | `verify-mock.ts` headless full pipeline | `npm run test:pipeline` | **PASS** |

Extra gate: `npm run typecheck` (`tsc --noEmit -p tsconfig.json`) exits `0`.

---

## 4. Acceptance evidence (last run)

```text
streamed 7 frames in 24.0 ms
variables 10 · components 5 · nodes 1500
Button variant rows linked to set: 4
alias chain preserved in values_by_mode_json
AST diversity: icons=17, instances=150, mixed-text=50
recursive CTE: 1500 nodes, avg 0.636 ms, max 0.976 ms (< 10 ms)
journal_mode = wal
sqlite file: 688.0 KB (< 2 MB)
RESULT: PASS
```

Additional checks:

- `plugin/dist/code.js` contains no `new WebSocket` constructor.
- No `.vectorPaths` / `.vectorNetwork` access in `plugin/src`.
- No `*.sqlite` leftovers after the test.
- Widget interaction test: four stages, sample switching, keyboard navigation, zero console exceptions.

### 4.1 Real-file sample — 2026-11-13

Frozen artifact: `data/samples/2026-11-13-baipai-13p.sqlite` (+ `.manifest.json`).

```text
file            payment product (anonymised) (0:0), extracted 2026-11-13T01:51:16Z
SYNC_COMPLETE   YES
nodes           117,166 · roots 25 · depth max 20
pages           13 (12 content + 1 empty "BSC")
components      83 (72 COMPONENT + 11 COMPONENT_SET)
variables       0 — every binding points at a remote library variable
bound vars      13,575 nodes across 30+ library file keys
instances       45,895 (191 point at a local main component)
icon containers 12,945
payload         39.7 MB in-column · DB 462.5 MB (11.6x)
audit           orphan parents 0 · bbox NULL 0 · bad JSON 0
```

Largest pages: `NFC` 40,009 · `CSB & User payemnt` 12,260 · `Request money` 11,746.

Sample id `2026-11-13-baipai-13p`, sha256 `47497aed0beb60af7facd86130f6363a69b93cea0d6f4e5c43d9b93e39ae843b`.

### 4.2 Field validation — structure family + state mapping

Operator visually verified 10 sampled nodes in Figma on 2026-11-13. **All 10 matched** the database's predicted state, so the two derived artifacts below are accepted:

1. **Structural family**: `Payment result page` resolves to 32 nodes in 7 structural signatures (Merklized tree hash over `(type, ordered children)`).
2. **State dictionary**: status is carried by the `Payment-result` instance's `main_component_id` — `1:435` success · `1:467` failed · `1:451` processing — and agrees with the headline copy in 31/32 cases.

```text
33:27783  NFC            FRAME      success     Tap successful
1:102789  Withdraw       INSTANCE   success     Withdraw successful
1:16993   NFC            COMPONENT  success     Activation successful   (master)
1:63834   Request money  INSTANCE   success     Payment successful
1:102796  Withdraw       INSTANCE   failed      Withdraw failed
1:22374   NFC            FRAME      failed      Activation failed
1:63833   Request money  INSTANCE   failed      Payment failed
1:102810  Withdraw       INSTANCE   processing  Withdraw processing
1:84359   Bank Topup     INSTANCE   processing  Topup processing
1:84789   Bank Topup     INSTANCE   MIXED       Topup failed + processing icon
```

`1:84789` is a **confirmed in-file defect**, not an extraction error: its headline says `Topup failed` while its status icon is the processing component and its body copy describes processing. This is the first defect the tooling caught on its own.

Naming reliability on this sample (153 frames at 390×844): 27 distinct names vs **68 distinct structures**; 15 names span more than one structure (worst: 9 structures under one name); one structure is split across 2 names; one screen is auto-named `Frame 2147230435`. Names are therefore a weak prior, never an identity.

### 4.3 Project success criteria (agreed 2026-11-13)

The project succeeds when a designer can ask for a category, receive IDs that provably exist in the extracted graph, open them in Figma, and send corrections back without any layer inventing data. "Trustworthy" is defined as **provenance**, not prediction accuracy.

| # | Criterion | Enforced by |
|---|---|---|
| 1 | Every ID and name in any output exists in the sample; names are byte-identical to the DB | `verify-source` (last step of `sync`) |
| 2 | The AST baseline has exactly one implementation; adapters only format | `test:parity` (byte-identical CLI vs core) |
| 3 | The environment is inspectable before work starts | `npm run doctor` (non-zero blocks the run) |
| 4 | Only human-authored feedback changes labels; unknown IDs are rejected | `apply` (dry-run counts, unknown list) |
| 5 | Large categories are sampled explicitly, never truncated silently | `category` (>40 → 10, prints total/shown) |
| 6 | Artifacts cannot leak into the repo | `--out` allow-list + `.scratch` |
| 7 | The tool states what it cannot judge | `sheet.limits`, `unknown` as a legal verdict |

**Definition of done for a category request:** the agent returns IDs whose names match the graph, the designer verifies them in Figma by ID, and corrections flow back through `apply` → `sync` with provenance intact.

---

## 5. Operator runbook

```bash
npm install
npm run start:server          # terminal 1
npm run build:plugin          # terminal 2
```

Figma Desktop → **Plugins → Development → Import plugin from manifest…** → `plugin/manifest.json` → run → **Extract AST to Local SQLite**.

Headless acceptance: `npm run test:pipeline`.

Inspect: `sqlite3 ./data/rea-figma.sqlite`. The verification database is `data/test-rea-figma.sqlite` and is deleted automatically.

Freeze a verified run as a reusable sample (safe while the server is still up — SQLite online backup):

```bash
npx tsx server/audit-db.ts ./data/rea-figma.sqlite           # confirm SYNC_COMPLETE
mkdir -p data/samples
sqlite3 ./data/rea-figma.sqlite ".backup 'data/samples/<sample-id>.sqlite'"
sqlite3 ./data/samples/<sample-id>.sqlite 'pragma journal_mode=delete;'   # single self-contained file
```

Then record `counts`, per-page node counts and the sha256 next to the file as `<sample-id>.manifest.json`. Samples live under `data/samples/` (git-ignored); only the numbers go into §4.

Query layer — read-only, no server required:

```bash
npm run query -- family 33:27783            # exact structural family + variants
npm run query -- profile 33:27783           # quantified style fingerprint
npm run query -- profile --page NFC         # whole-page profile
npm run query -- diff 33:27783 1:22374      # structure + style delta
npm run query -- find 33:27783 --top 8      # candidate recall by structure + style
npm run query -- derive                      # labeled new/old split: features + leave-one-out
npm run query -- classify 49:157422          # new | old | unknown, with per-feature votes
npm run query -- scan --top 5                # classify every 390x844 screen in the sample
npm run query -- variants --top 5            # vocabulary-free variant axes per family
npm run query -- variant 33:27783            # which axis a node sits on, and what differs
npm run query -- sheet 33:27783              # one-screen feature card (text or --json)
```

`find` returns three layers instead of one ranked blob: **L1** exact structural hash, **L2** near structure (type-histogram cosine ≥ 0.9), **L3** style-only (palette/font/radius similarity ≥ 0.45). A flat list hid the difference between "same tree" and "same colours"; the layers make the recall claim auditable.

`sheet` is the intended external interface: one record per screen carrying structure, style, copy, variant axis and generation label, plus an explicit `limits` list of what the AST cannot judge.

`variants` / `variant` are deliberately **vocabulary-free**: an axis is a component that appears in some family members and not others, and the only output about it is which members it separates and which copy differs. Semantic names ("success", "pending review", "已激活") are a human layer on top — `--hint` prints a display-only guess and must never influence grouping, ranking or membership. This keeps the query layer usable on files whose vocabulary the tool has never seen.

Labels live in `labels/style.json` (tracked, not a test artifact). Classification is deliberately conservative: a node whose best score falls below `--floor` (default 0.55) or whose margin between groups is under 0.10 is reported as `unknown`, never guessed.

**Artifact policy.** Every generated report, dump or screenshot goes through `--out <path under .scratch/>`. The CLI rejects any destination outside `.scratch/`, and `.scratch/` is git-ignored — it is the only sanctioned place for test output, so cleanup is a single `rm -rf .scratch`.

---

## 6. Change boundaries for future agents

- Do **not** add `WebSocket` usage to `code.ts`; the iframe is the only network boundary.
- Do **not** replace async Figma APIs with sync ones; `dynamic-page` will throw at runtime.
- Do **not** remove the 500-row flush / `setTimeout(0)` yield; large files will freeze QuickJS.
- Do **not** serialize vector geometry; extend `isIconContainer` rather than reading paths.
- Keep the ACK after commit; the relay’s “complete” state depends on it.
- **Keep generated artifacts inside `.scratch/`.** Reports, dumps, screenshots and exports belong there and nowhere else (`docs/`, `server/`, repo root are off-limits). `server/query.ts` enforces this for its own `--out`.
- **Never key on, or fall back to, layer names.** Node identity is the structural Merkle hash over `(type, ordered children)`; names survive only as a ranking prior and as drift-report input. Rationale and measurements are in §4.2 — designers duplicate screens and rename inconsistently, so a name-keyed matcher both merges distinct structures and splits identical ones. When structure does not match, degrade to partial-structure similarity and then to "new family"; never degrade to name equality.
- Do **not** upgrade TypeScript: npm `latest` resolves TS 7, which rejects the explicit-file checks (`TS5112`) and removed `moduleResolution: node10`. The plan’s commands depend on TS 5.9 behavior.

---

## 7. Phase 2 hooks

- `startIngestServer({ port, dbPath, quiet })` is exported, so tools can boot isolated sinks.
- `AstGraphDB.getStats()` and the indexed `nodes` graph are the substrate for MCP reverse-engineering tools.
- Extend `WsMessage` and the `ui.html` whitelist together if new chunk types are introduced.
- `is_icon_container` and `bound_variables_json` already answer the first Phase 2 questions (icon inventory, token adoption) without re-extracting the file.
- **`variables` is not the adoption substrate.** The 2026-11-13 sample ships 0 rows there while 13,575 nodes carry bindings; measure token adoption from `bound_variables_json`, never from the `variables` table.
- Variable ids embed their owning library key (`VariableID:<fileKey>/<nodeId>`). Grouping by that prefix yields library fan-out — 33 distinct keys in the 2026-11-13 sample, so a single "design system" assumption is wrong.
- 45,704 of 45,895 instances reference main components outside the file. Coverage and variant questions must treat missing mains as expected, not as extraction loss.

---

## 8. Publication checklist — do this when the project is complete

The repo will be published to GitHub. The goal is that an outside reader can rebuild the reasoning, not just run the commands.

- [x] `docs/ARCHITECTURE.md` — the pipeline as a layered diagram (Figma plugin → iframe relay → SQLite graph → pure core → CLI/MCP adapters), the data contracts at each boundary, and the module map.
- [x] `docs/DECISIONS.md` — the reasoning the code encodes:
  - why node identity is a Merkle hash over `(type, ordered children)` and names are only a weak prior (§4.2 measurements);
  - why layout archetype is computed from z-order + a text-free frame-sized layer, not from area alone (the home-page false positive);
  - why variant axes are vocabulary-free and semantics live in a human layer;
  - why the MCP adapter imports core instead of spawning the CLI, and why there is no SDK dependency;
  - why `unknown` is a legal classification outcome;
  - why artifacts are confined to `.scratch/`.
- [x] `README.md` rewrite for an outside reader: one-paragraph problem statement, quickstart, command table, what the tool refuses to do, screenshots of the review board.
- [x] Validation write-up: the 10/10 field check (§4.2), the 42 operator labels, `doctor`/`parity`/`verify-source` gates, and the two cold-start skill tests with the gaps they exposed and how they were closed.
- [x] Repo hygiene: confirm `data/`, `backups/`, `.scratch/` are untracked; no secrets in `labels/`; LICENSE present; node version stated.
- [x] Sample packaging: publish `*.manifest.json` numbers and sha256 only, never the 462 MB SQLite files.

Completed 2026-11-16. Deliverables: docs/ARCHITECTURE.md, docs/DECISIONS.md, README.md, docs/VALIDATION.md, repo hygiene (.gitignore + LICENSE), docs/SAMPLES.md with docs/samples/*.manifest.json.
