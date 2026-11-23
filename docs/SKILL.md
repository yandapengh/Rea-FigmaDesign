# SKILL — Rea-FigmaDesign 圖譜操作

> 給 agent 的工具說明書。只寫「用哪個工具、契約、證據」，不寫實作細節。
> 流程有變時，先改這份，再改程式。

## 1. 何時使用

- 在 Figma AST 圖譜上查結構、風格、分類、家族、差異
- 回答「某分類出現在哪些頁面、幾個、ID 是什麼」
- 做資料健康檢查、世代（老UI/新UI）統計、標註覆蓋率
- 把設計師的分類回饋整理成可驗證的清單

不適用：需要即時讀 Figma 檔案本身（要先由插件匯出到 SQLite）。

## 2. 環境與資料

- 圖譜在 data/<file-key>/graph.sqlite；不要假設固定檔名 data/rea-figma.sqlite
- 路徑解析一律交給 CLI（會挑最新的 data/*/graph.sqlite）
- 只有匯入資料時需要啟動 server：npm run start:server（port 8765）
- 查詢、報表、健康檢查都是唯讀，不需要 server
- 標註來源：labels/screens-v2.json（新版）；labels/screens.json 是舊格式、目前為空

## 3. 工具表面

### 3.1 CLI（npm scripts）

| 指令 | 用途 | 讀寫 | 產物 |
|---|---|---|---|
| npm run doctor | 開工前環境檢查 | 唯讀 | 終端機 |
| npm run health | 全量一致性檢查（頁數、節點、staging、狀態） | 唯讀；--fix 可修計數 | 終端機 |
| npm run tier1 | Tier 1 回歸（screen 規則、Merkle、archetype） | 唯讀 | 終端機 |
| npm run sample | 跨頁抽 10 個畫面供人工抽檢 | 唯讀 | 終端機 |
| npm run tier15 | Tier 1.5 剝洋蔥正規化摘要（唯讀） | 終端機 |
| npm run ux -- node-id | 15 項 UX 空間特徵（唯讀） | 終端機 |
| npm run detach | Detach 合成召回（唯讀） | 終端機 |
| npm run hidden | 列出透明度 ≤35% 的隱藏畫面 | 唯讀 | 終端機 |
| npm run report:categories | 列出全部大類/小類、畫面數、頁面數 | 唯讀 | 終端機 |
| npm run report:category -- <分類> | 分類 × Figma 頁面 × node ID | 唯讀 | ~/Downloads/rea-figma-category-<分類>.md |
| npm run audit:db -- <db> | 深層資料品質統計 | 唯讀 | 終端機 |
| npm run query -- <cmd> | 舊版查詢層（sheet/family/diff/category…） | 依命令 | 終端機/.scratch |
| npm run mcp | 啟動 MCP server（stdio） | 唯讀查詢/標註寫入 | MCP |
| npm run start:server | 啟動插件匯入用 WebSocket server | 寫入 DB | data/… |

### 3.2 MCP 工具（11 個）

| 工具 | 回答什麼 |
|---|---|
| list_screens | 檔案有哪些畫面、各 archetype 數量 |
| screen_sheet | 單一畫面的結構/風格/文案特徵卡 |
| screen_family | 同一結構家族的所有成員 |
| screen_variants | 家族內的變體軸與差異 |
| diff_screens | 兩個畫面的結構/風格差異 |
| find_similar | 長得像的畫面（分層召回） |
| style_profile | 頁面或節點的風格指紋 |
| review_queue | 待分類佇列 |
| apply_labels | 寫入分類/備註（需 confirm 或 dryRun） |
| list_samples | 列出可用樣本 |
| server_info | MCP 連線與版本 |

規則：能列舉就不要猜 ID；「有多少」先 list_screens，不要自己掃 DB。

### 3.3 DSH 斜線命令（零 token）

| 命令 | 動作 |
|---|---|
| /rea-figma-review | 重生成 .scratch/review.html 並開啟 |
| /rea-figma-doctor | 跑 doctor 並回報結果 |

命令不吃參數；分類名稱由 agent 解析後呼叫 CLI。

## 4. 核心契約

1. 不得編造 ID、名稱、數量；每個數字都要能從 SQLite 重現。
2. ID 必須一一對應 DB；找不到就報錯，不要用鄰近資料補。
3. 回答分類問題要附 node ID，讓設計師能貼回 Figma 驗證。
4. 不確定就回 unknown；unknown 是合法答案，不是失敗。
5. 分類只來自主檔 taxonomy（major + minor 一層），不要自創。
6. 任何抽樣都要同時顯示 total 與 shown；不得靜默截斷。
7. 唯讀工具不得寫 DB；要寫入必須明確標示並取得確認。

## 5. 標註 v2（labels/screens-v2.json）

~~~json
{
  "version": 2,
  "screens": [
    { "id": "11676:420992", "label": "收銀台", "major": "頁面類", "minor": "收銀台", "generation": "" }
  ]
}
~~~

六個 major：老UI、新UI、系統UI、彈窗類、頁面類、廢棄。
minor 只有一層；generation 只放 old/new（世代軸，與 major 分開）。
頁面類目前 30 個 minor；完整清單見 labels/screens-v2.json。

## 6. 常用流程

### 6.1 查某分類的頁面與 IDs

~~~bash
npm run report:category -- 收銀台
~~~

輸出固定格式：總數、出現頁面數、每個頁面的 ID 陣列（一行一個，可直接複製到 Figma）。
回報時要包含：分類、total、頁面數，以及至少前 3 個 ID 當證據。

### 6.2 查畫面特徵

用 MCP：先 list_screens 縮小範圍，再 screen_sheet / screen_family / diff_screens。
不要一次把所有畫面 dump 給使用者。

### 6.3 健康檢查與驗收

~~~bash
npm run health
npm run tier1
npm run sample
~~~

驗收回報格式：RESULT 行 + 關鍵計數（頁數/節點/staging/狀態）。

## 7. 證據與回報

- 指令輸出：附 RESULT 行與 exit code
- 分類查詢：total、頁面數、IDs
- 健康檢查：失敗項目與修復建議
- 不得用「已完成」代替輸出

## 8. 停止條件

- health FAIL（staging > 0、SYNCING > 0、頁面/節點不一致）
- ID 在 DB 找不到
- MCP 工具回 unknown 比例異常
- 需要寫入 labels 但沒有明確確認

## 9. 已知限制（下週要補）

1. labels/screens-v2.json 尚未接進 query/MCP；舊 labels/screens.json 仍是空檔。
2. 舊 query 層（apply/review/propagate）仍依賴舊 taxonomy page/dialog，不要在新流程使用。
3. 分類文件尚未同步到 docs/QUERY.md；以 labels/screens-v2.json 為準。
4. 老UI/新UI 的 minor 多數為空，屬預期（世代與功能分開）。

## 10. 快速範例

使用者：「收銀台出現在哪些頁？各幾個？」

1. npm run report:category -- 收銀台
2. 回報：28 個畫面 / 5 頁；8月 Cashier 15、(持续) AI Assistant 7、…；附 ID。

使用者：「這份資料健康嗎？」

1. npm run health
2. 回報 RESULT 與失敗原因。

