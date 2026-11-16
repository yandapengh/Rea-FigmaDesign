# 查詢層使用說明（Rea-FigmaDesign Phase 2）

唯讀 CLI，跑在已凍結的 SQLite 圖譜上。路徑一律以專案根目錄解析，**可從任何目錄執行**。

```bash
npm run query -- <command> [args] [--db path] [--json]
```

## 一、一鍵流程

```bash
npm run doctor        # 開工前：環境、資料、labels、路徑檢查（非 0 退出＝不要動手）
npm run sync          # sheets --unique → propagate → review → test:parity，並開瀏覽器
```

## 架構

```
server/core/graph.ts       圖載入、Merkle hash、profile / slots / archetype（純函式）
server/core/semantics.ts   標註、世代投票、變體軸、彈窗標記（純函式）
server/query.ts            CLI 轉接頭：參數、排版、寫檔、開瀏覽器
```

核心模組不呼叫 `process.exit`、不寫檔、不讀 CLI 全域設定——CLI 與 MCP 都直接 import，**adapter 層不得自行重算**。

這條由 `npm run test:parity` 強制：它把 CLI 的 `--json` 輸出與 core 的計算結果逐位元比對，任何一方偷偷重算就會紅。

## MCP（stdio）

```bash
npm run mcp      # JSON-RPC 2.0 over stdio, 無需額外 SDK
```

11 個工具，唯讀 10 個、變更 1 個：

| 工具 | 讀/寫 | 說明 |
|---|---|---|
| `list_samples` | 讀 | live db 與所有凍結樣本 |
| `list_screens` | 讀 | 所有唯一畫面 + 版面原型計數（可依 archetype 過濾） |
| `screen_sheet` | 讀 | 單頁特徵卡（含 AST 判不了的清單） |
| `screen_family` | 讀 | 精確結構家族成員 |
| `screen_variants` | 讀 | 無詞彙變體軸 |
| `style_profile` | 讀 | 節點或整頁的風格指紋 |
| `diff_screens` | 讀 | 結構 + 風格差異 |
| `find_similar` | 讀 | 三層召回 |
| `review_queue` | 讀 | 上次 propagate 的待分類清單 |
| `apply_labels` | **寫** | 寫入 labels/screens.json；需 `confirm:true`，`dryRun:true` 可預覽 |

要點：MCP adapter 直接 import `server/core/*`，**不 spawn CLI**；錯誤以 `{ok:false,error:{code,message}}` 回傳並標記 `isError`。

### DSH 斜線命令（plugin）

確定性操作不需要模型，做成命令可以零 token、即時執行：

| 命令 | 行為 |
|---|---|
| `/rea-figma-review` | 生成 `.scratch/review.html` 並開啟（不接受參數） |
| `/rea-figma-doctor` | 跑 preflight |
| `/rea-figma-doctor` | 跑 preflight，回報 RESULT |

安裝（本機）：

```bash
npm run build:dsh-plugin
mkdir -p ~/.dsh/profiles/node_modules/dsh-plugin-rea-figma/dist
cp dsh-plugin/package.json ~/.dsh/profiles/node_modules/dsh-plugin-rea-figma/
cp dsh-plugin/dist/index.js ~/.dsh/profiles/node_modules/dsh-plugin-rea-figma/dist/
```

在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: rea-figma-commands
      name: dsh-plugin-rea-figma
      config:
        root: /path/to/rea-figma
```

重啟 DSH 後，輸入 `/rea-figma` 應看到兩個命令。命令在 UI 命令平面執行，輸出**不進模型歷史、不消耗 token**。

**命令刻意不吃參數。** 要只看某個分類時，用自然語言跟 agent 說，由 agent 讀 `labels/screens.json` 的 taxonomy、補正錯字，再回填 CLI 參數：

```text
使用者：review 首ye        ← 錯字
agent：解析為「首頁」→ npm run query -- review --category 首頁
```

這樣「穩定」與「方便」各自歸位：命令是固定動作，分類名稱的模糊匹配交給模型；CLI 只接受精確分類，錯了會回 `did you mean: 首頁`。

### 在 DSH 註冊 MCP（本機）

DSH 用 `@deepseek-ai/dsh-mcp-client`，每個 server 一個 plugin 實例。在 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: mcp-rea-figma
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: rea-figma
    transport: stdio
    command: /path/to/rea-figma/node_modules/.bin/tsx
    args:
      - /path/to/rea-figma/server/mcp.ts
    cwd: /path/to/rea-figma
    failOnStartupError: true
```

重啟 DSH 後，工具以 `mcp__rea-figma__<name>` 註冊（例：`mcp__rea-figma__screen_sheet`）。

已用官方 SDK client（`@modelcontextprotocol/sdk` 1.29.0）驗證：`initialize` → `tools/list`（9 個）→ `tools/call` 正常，錯誤路徑回 `isError: true`。

### 如何確認「這次呼叫真的走了 MCP」

三個獨立證據，任一即可：

| 方法 | 怎麼看 |
|---|---|
| 呼叫紀錄 | `tail -f .scratch/mcp-calls.jsonl` — 每次呼叫一行（ts / pid / tool / args / ms / ok） |
| 連線自證 | 呼叫 `mcp__rea-figma__server_info` — 回 pid、startedAt、uptime、calls、log 路徑 |
| 工具名稱 | transcript 顯示的是 `mcp__rea-figma__*`，不是 CLI |

呼叫紀錄由 server 自己在 `tools/call` 時寫入，所以「有紀錄」等於「請求真的經過 MCP server 的 handler」。失敗的呼叫也會記錄（`ok:false`）。

改完 `server/mcp.ts` 後不必重啟 DSH：kill 掉子進程，client 會在 500ms 後自動重連並重新同步工具（`mcp-client(rea-figma): reconnected`）。

## 輸出契約

所有命令支援 `--json`，回傳統一 envelope：

```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": { "code": "not_found", "message": "...", "fix": "..." } }
```

- 錯誤碼：`invalid_argument` / `not_found` / `missing_input` / `guard_rejected` / `internal`
- 失敗時 exit code = 1，成功 = 0
- 查詢工具清單：`npm run query -- manifest`（或 `--json`）

## 二、命令總表

| 命令 | 作用 |
|---|---|
| `sheet <id>` | 單頁特徵卡：結構、風格、文案、變體軸、世代 |
| `sheets [--unique]` | 全樣本特徵表 → `.scratch/sheets.jsonl` + `.scratch/sheets.csv` |
| `family <id>` | 精確結構家族（Merkle hash）成員 |
| `variants` / `variant <id>` | 變體軸（無詞彙）：哪個 component 在成員間切換 |
| `profile <id \| --page X>` | 風格量化指紋 |
| `diff <a> <b>` | 結構 + 風格差異 |
| `find <id> --top N` | 三層召回：L1 同構 / L2 近構 / L3 樣式近 |
| `classify <id>` / `scan` / `derive` | 新舊世代分類（標註驅動） |
| `cluster --k N [--archetype X]` | k-means 聚類（功能分類候選） |
| `markers` | 從標註學「彈窗專用元件」（實驗用，未套用） |
| `propagate` | 以標註做 kNN 傳播，輸出信心分級 |
| `review` | 產生可視化排查板 `.scratch/review.html`；左側導航依資料動態分組（預設預測分類） |
| `review --category X` | 只生成某一分類；若該分類沒有待分類項目，改為列出已標註的該分類畫面（唯讀檢視） |
| `review --group-by archetype` | 改以版面原型分組（page / overlay-panel / overlay） |
| `apply --md <file>` | 解析設計師回饋的 Markdown 表，寫回 `labels/screens.json` |
| `category <name>` | 列出某分類的畫面；超過 40 張自動抽樣 10 個（`--all` 全量） |
| `verify-source` | 檢查 labels／predictions／queue 的 ID 與名稱都存在於樣本 |
| `--help` | 任何命令加 `--help` 印出完整工具清單與參數 |

## 三、資料位置（初始狀態）

**這個 repo 不含任何資料庫。** 抽取出來的 SQLite、凍結樣本、備份與測試產物都放在 repo 外面：

```
~/Downloads/rea-figma-data-<date>/     # 外部資料根（建議）
  ├── live/        data/rea-figma.sqlite
  ├── samples/     *.sqlite + *.manifest.json
  ├── backups/     *.sqlite
  └── scratch/     review.html、sheets.jsonl、predictions.jsonl …
```

新 checkout 的初始狀態是：`data/`、`backups/`、`.scratch/` 都是空的，`doctor` 會把它當成 warning（不是 failure），並提示先跑抽取。

抽取時**不需要手動放檔**：`npm run start:server` 會自動建立 `data/rea-figma.sqlite`（含父目錄），plugin 連上就開始寫入。路徑以 repo 根目錄解析，從哪個目錄啟動都一樣。

要沿用外部既有資料，用環境變數指定：

```bash
REA_DB_PATH=~/Downloads/rea-figma-data-2026-11-13/live/rea-figma.sqlite npm run start:server
```

## 資料位置

| 路徑 | 內容 | 進 git |
|---|---|---|
| `labels/style.json` | 新舊世代的標註 | ✅ 來源 |
| `labels/screens.json` | 頁面分類標註（設計師回饋寫這裡） | ✅ 來源 |
| `labels/archetype.json` | 從標註學到的彈窗元件（實驗紀錄） | ✅ |
| `data/samples/*.sqlite` | 凍結的樣本 | ❌ 衍生 |
| `.scratch/*` | 特徵表、聚類、預測、排查板 | ❌ 產物 |

**產物一律進 `.scratch/`**，要清就 `rm -rf .scratch`。CLI 的 `--out` 只接受 `.scratch/` 路徑，寫到別處會直接拒絕。

## 四、版面原型（archetype）

`page` / `overlay-panel` / `overlay` 由規則算出，不用聚類：

1. 只有一個滿版子節點時往內拆（wrapper）
2. 找**與畫布同尺寸（±3px）且不含文字**的子節點＝遮罩
3. 遮罩之上還有更小的兄弟節點（面積 <50%）＝彈窗面板

驗證：42 個人工標註，precision 1.00 / recall 1.00。

## 五、設計師 ↔ Agent 迴圈

1. 設計師開 `.scratch/review.html`：左側按版面原型導航，表格第一欄是 ID
2. 勾選（Shift 連選）→ 批次套用分類／備註
3. 需要回 Figma 看：勾選後按「複製 Figma 指令」，貼進 plugin 執行（會按頁面分組切換）
4. 按「複製 Markdown」→ 貼給 agent
5. Agent：`npm run query -- apply --md feedback.md` → `npm run sync`

## 六、已知限制

- 語意分類（首頁／收銀台…）不能自動命名，只能聚類出候選，由人命名
- kNN 傳播目前 LOO 57%，僅 unanimous（86%）可作建議，其餘需人工複審
- 沒有縮圖；排查板用色票 + 型別比例 + 文案當視覺替代
- `pages` 表可能過期（census 與抽取脫鉤），查詢層一律從 `nodes.page_name` 聚合
