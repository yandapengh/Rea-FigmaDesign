# 查詢層與 MCP 使用說明（Rea-FigmaDesign）

唯讀 CLI 與 MCP，跑在已凍結或最新抽取的 SQLite 圖譜上。路徑一律以專案根目錄解析，**可從任何目錄執行**。

```bash
npm run query -- <command> [args] [--db path] [--json]
```

## 一、一鍵流程

```bash
npm run doctor        # 開工前：環境、資料、labels/screens-v2.json、腳本檢查
npm run sync          # health → review:board → test:parity → verify-source
```

## 架構

```
server/core/graph.ts       圖載入、Merkle hash、screenRoots、profile / slots / archetype（純函式）
server/core/semantics.ts   v2 標註讀寫/聚合、世代投票、變體軸（純函式）
server/core/health.ts      11 項資料庫完整性稽核（純函式）
server/core/analyze.ts     組合查詢（sheet / diff / find）
server/core/onion.ts       Tier 1.5 剝洋蔥正規化
server/core/ux.ts          15 項 UX 空間特徵
server/core/detach.ts      Detach 結構相似度
server/query.ts            CLI 轉接頭：參數、排版、寫檔
server/mcp.ts              MCP 轉接頭（stdio JSON-RPC，14 個工具）
```

核心模組不呼叫 `process.exit`、不寫檔、不讀 CLI 全域設定——CLI 與 MCP 都直接 import，**adapter 層不得自行重算**。

這條由 `npm run test:parity` 強制：它把 CLI 的 `--json` 輸出與 core 的計算結果逐位元比對，任何一方偷偷重算就會紅。

## MCP（stdio）

```bash
npm run mcp      # JSON-RPC 2.0 over stdio, 無需額外 SDK
```

14 個工具（12 唯讀／產出，1 標註寫入需確認）：

| 工具 | 讀/寫 | 說明 |
|---|---|---|
| `server_info` | 讀 | MCP 連線自證（pid / uptime / calls / log） |
| `list_samples` | 讀 | live db 與所有凍結樣本 |
| `list_categories` | 讀 | `labels/screens-v2.json` 全部分類與數量統計 |
| `category_report` | 讀 | 單一分類出現的所有 Figma 頁面與 node ID |
| `health_check` | 讀 | 11 項 SQLite 圖譜一致性檢查 |
| `list_screens` | 讀 | 所有唯一畫面 + 版面原型計數 + v2 標註欄位 |
| `screen_sheet` | 讀 | 單頁特徵卡（含 AST 判不了的清單） |
| `screen_family` | 讀 | 精確結構家族成員 |
| `screen_variants` | 讀 | 無詞彙變體軸 |
| `style_profile` | 讀 | 節點或整頁的風格指紋 |
| `diff_screens` | 讀 | 結構 + 風格差異 |
| `find_similar` | 讀 | 三層召回 |
| `build_review_board` | 寫 `.scratch/` | 生成可視化人工複審工作台 `.scratch/review.html` |
| `apply_labels` | **寫** | 寫入 `labels/screens-v2.json`；需 `confirm:true`，`dryRun:true` 可預覽 |

要點：MCP adapter 直接 import `server/core/*` 與 `generateReviewBoard`，並快取記憶體中的 `Graph` 實例；錯誤以 `{ok:false,error:{code,message}}` 回傳並標記 `isError`。

### 工具約束與守則

| 約束 | 在哪裡 | 效果 |
|---|---|---|
| 型別 / 必填 | `inputSchema` | 參數形狀不對，client 就在送出前擋下 |
| `enum` | `list_screens.archetype`、`apply_labels.rows[].generation` | 嚴格限制允許值 |
| `additionalProperties: false` | 所有工具與 `apply_labels.rows` | 打錯欄位名會被拒絕 |
| `annotations` | 全部工具 | `readOnlyHint` / `destructiveHint` 標記風險 |
| `confirm: true` | `apply_labels` | 沒有明確確認就不寫 `labels/screens-v2.json` |
| server 端驗證 | handler | 節點不存在、樣本不存在、分類無結果，都回 error |

上述約束由 `npm run test:mcp` 自動檢查。

### DSH 斜線命令（plugin）

| 命令 | 行為 |
|---|---|
| `/rea-figma-review` | 生成 `.scratch/review.html` 並開啟（不接受參數） |
| `/rea-figma-doctor` | 跑 preflight，回報 RESULT |

需要帶條件篩選（`--unlabeled`、`--category`、`--sample`、`--ids`）時，由 agent 呼叫 `build_review_board` 或 `npm run review:board -- ...`。

## 二、CLI 命令總表

### 常用報表與複審指令

| 指令 | 作用 |
|---|---|
| `npm run report:categories` | 列出 `labels/screens-v2.json` 全部大類／小類、畫面數、頁面數 |
| `npm run report:category -- <分類>` | 輸出該分類在各 Figma 頁面的 ID 清單，並存至 `.scratch/rea-figma-category-<分類>.md` |
| `npm run review:board -- [選項]` | 生成 `.scratch/review.html` 可視化人工複審工作台（`--unlabeled` / `--category` / `--sample` / `--ids` / `--page` / `--open`） |
| `npm run health` | 11 項圖譜完整性檢查 |
| `npm run tier1` | Tier 1 規則、Merkle 去重與版面原型回歸 |
| `npm run sample` | 跨頁抽樣 10 個畫面 |
| `npm run hidden` | 列出透明度 ≤35% 的隱藏畫面 |
| `npm run tier15` | Tier 1.5 剝洋蔥正規化摘要 |
| `npm run ux -- <node-id>` | 15 項 UX 空間特徵 |
| `npm run detach` | Detach 合成召回 |

### `npm run query -- <command>`

| 命令 | 作用 |
|---|---|
| `sheet <id>` | 單頁特徵卡：結構、風格、文案、變體軸、世代 |
| `sheets [--unique]` | 全樣本特徵表 → `.scratch/sheets.jsonl` + `.scratch/sheets.csv` |
| `family <id>` | 精確結構家族（Merkle hash）成員 |
| `variants` / `variant <id>` | 變體軸（無詞彙）：哪個 component 在成員間切換 |
| `profile <id \| --page X>` | 風格量化指紋 |
| `diff <a> <b>` | 結構 + 風格差異 |
| `find <id> --top N` | 三層召回：L1 同構 / L2 近構 / L3 樣式近 |
| `classify <id>` / `scan` / `derive` | 新舊世代分類（`labels/style.json` 驅動） |
| `cluster --k N [--archetype X]` | k-means 聚類（功能分類候選） |
| `verify-source` | 檢查 `labels/screens-v2.json` 的每個 ID 都存在於樣本圖譜 |
| `--help` | 印出完整工具清單與參數 |

## 三、資料位置

| 路徑 | 內容 | 進 git |
|---|---|---|
| `labels/screens-v2.json` | 畫面分類與世代標註（`major` / `minor` / `generation`） | ✅ 來源 |
| `labels/style.json` | 世代風格輔助標註 | ✅ 來源 |
| `data/<file-key>/graph.sqlite` | 本機抽取圖譜（工具自動挑最新） | ❌ 衍生 |
| `data/samples/*.sqlite` | 凍結的基準樣本 | ❌ 衍生 |
| `.scratch/*` | 複審看板、分類報表、特徵表、呼叫紀錄 | ❌ 產物 |

**產物一律進 `.scratch/`**，要清就 `rm -rf .scratch`。

## 四、設計師 ↔ Agent 迴圈

1. Agent 或設計師執行 `npm run review:board -- [--unlabeled | --category X | --sample 15] --open`。
2. 設計師在 `.scratch/review.html` 檢視：無問題直接留空，有問題在右側輸入框自由描述；需要回 Figma 看可一鍵複製 ID 或 Figma 定位腳本。
3. 點擊 **「複製為 Agent 提示詞」**，貼回給 Agent。
4. Agent 根據意見用 `apply_labels(dryRun: true)` 列出修改前後對照，經設計師確認後正式寫入 `labels/screens-v2.json`。
