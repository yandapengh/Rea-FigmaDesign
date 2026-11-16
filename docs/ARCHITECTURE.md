# ARCHITECTURE

> 這份文件描述系統的形狀與邊界。每個決定「為什麼這樣做」的理由見 [DECISIONS.md](DECISIONS.md)。

## 1. 分層

    Figma 文件
      │  figma.* API（QuickJS sandbox：有文件、無網路）
      ▼
    plugin/src/code.ts          遍歷、序列化、每 500 筆一批
      │  figma.ui.postMessage（唯一的跨沙箱通道）
      ▼
    plugin/ui.html              iframe：有 WebSocket、無 figma.*
      │  ws://127.0.0.1:8765
      ▼
    server/ws-server.ts         驗證訊息、每批一個 transaction、回 ACK
      │
      ▼
    data/rea-figma.sqlite       nodes / pages / components / variables / file_meta
      │
      ▼
    server/core/*               純函式：結構 hash、風格指紋、分類、變體軸
      ├── server/query.ts       CLI（人與 CI；--json envelope）
      ├── server/mcp.ts         MCP（stdio JSON-RPC；10 個工具）
      └── dsh-plugin/           DSH 斜線命令（設計師；零 token）

Figma 的雙沙箱是硬約束，不是設計選擇：**code.ts 永遠不碰 WebSocket，ui.html 永遠不碰 figma.***。違反的話 plugin 直接無法載入。

## 2. 邊界與契約

### 2.1 序列化（code.ts → NodeRow）

- 每批 500 筆，flush 後 **yield 一次事件迴圈**；QuickJS 會凍結，這是硬需求。
- figma.mixed 一律轉成字串 `"MIXED"`，不可進入陣列或 JSON。
- **不讀 vectorPaths / vectorNetwork**；≤64×64 且全為向量幾何的容器標記為 icon container 後停止遞迴。
- dynamic-page 模式：每個 page 先 await loadAsync；instance 用 getMainComponentAsync。

### 2.2 訊息（code.ts → ui.html → server）

    SYNC_START       開始一次完整抽取（server 會 truncate 圖譜）
    CHUNK_NODES      500 筆節點
    CHUNK_COMPONENTS / CHUNK_VARIABLES
    PAGE_CENSUS      頁面目錄（獨立動作，見 §7）
    SYNC_COMPLETE    總數對帳，寫入 file_meta

每個 chunk 都等 ACK；server 在交易提交後才回 ACK，所以「收到 ACK」等於「已落地」。

### 2.3 儲存（SQLite）

- WAL + synchronous=NORMAL；每批一個 transaction，使用 prepared INSERT OR REPLACE。
- 主鍵是 Figma node id；**child_index 是 z-order**，版面原型規則直接依賴它。
- `variables` 表通常為空：library 變數的定義不在檔案內，綁定只存在節點的 bound_variables_json。
- **不存向量幾何**：資料量會爆炸，而且對查詢沒有價值。

### 2.4 核心（core/*）

核心是純函式：不呼叫 process.exit、不寫檔、不讀 CLI 全域設定。

| 模組 | 責任 | 主要輸出 |
|---|---|---|
| core/graph.ts | 圖載入、children 排序、Merkle hash、style/slots/profile | Graph、StyleProfile |
| core/semantics.ts | 標註、世代投票、變體軸、彈窗標記 | GroupStats、DerivedFamily |
| core/analyze.ts | 組合查詢 | SheetCard、DiffResult、FindResult |

### 2.5 轉接頭（adapters）

| Adapter | 契約 |
|---|---|
| CLI | stdout 為人可讀文字；--json 回 {ok, data} 或 {ok:false, error:{code,message,fix}} |
| MCP | tools/call 回 content[0].text = 同一個 envelope；失敗時 isError:true |
| DSH plugin | handler 回 {kind:"success"|"error", text}；命令不吃參數 |

三個 adapter **只做參數解析與排版**；所有計算在 core。這是可被自動驗證的：**npm run test:parity** 比對 CLI 的 JSON 與 core 的結果是否逐位元相同。

## 3. 模組地圖

    server/
      db.ts              schema、WAL、批次寫入、page census 替換
      ws-server.ts       訊息驗證、ACK、生命週期
      audit-db.ts        唯讀稽核（完成標記、資料品質、頁面覆蓋）
      doctor.ts          前置檢查（runtime / data / labels / workspace / scripts）
      query.ts           CLI：18 支命令、envelope、錯誤碼
      mcp.ts             MCP：stdio JSON-RPC、10 個工具、呼叫紀錄
      verify-mock.ts     Phase 1 端到端驗證（不需 Figma）
      verify-parity.ts   CLI 與 core 的位元比對
      core/graph.ts      圖與特徵
      core/semantics.ts  標註與變體
      core/analyze.ts    組合查詢

    plugin/
      src/code.ts        遍歷與序列化（只有 figma.*）
      src/serializer.ts  mixed 守衛、顏色、icon 剪枝、NodeRow
      ui.html            iframe relay（只有 WebSocket）

    dsh-plugin/src/index.ts   斜線命令（spawn CLI，不重算）

    labels/              標註（來源，不是產物）
    data/ backups/ .scratch/   執行期資料與產物（皆不進版控）

## 4. 不變量

這些若被破壞，系統會靜默出錯，所以每一條都有對應的閘門：

| 不變量 | 由什麼守 |
|---|---|
| CLI 與 core 的計算完全一致 | test:parity（逐位元） |
| 輸出的每個 ID 都存在於樣本 | verify-source（掛在 sync 最後） |
| 產物只進 .scratch | CLI 的 --out 白名單 |
| labels 只能由 apply 改 | 檔案權限約定 + SKILL 鐵律 |
| 節點身份不依賴名稱 | 結構 hash；名稱只當排序先驗 |
| 500 筆一批且每批 yield | plugin 的 flush 邏輯（凍結保護） |
| ACK 在 commit 之後 | ws-server 的交易順序 |

## 5. 資料生命週期

    extract（一次性）
      → freeze sample（.backup + journal_mode=delete + manifest）
      → sheets（特徵表 + 去重）
      → propagate（kNN 傳播 + 信心分級）
      → review（HTML 看板 + review-queue.md）
      → 設計師複審（批次分類／備註 → Markdown）
      → apply（寫回 labels）
      → sync（重跑前五步 + parity + verify-source）

## 6. 擴充點

- **新增 chunk 類型**：改 shared/protocol.ts、plugin/ui.html 白名單、server/ws-server.ts、db.ts 四處；漏一處就會靜默丟資料。
- **新增查詢**：在 core 寫純函式，CLI/MCP 各加一層薄轉接，並在 verify-parity 加案例。
- **新增 adapter**：只 import core，不得自行計算；上線前跑 parity。
- **新增樣本**：凍結後寫 manifest（節點數、sha256、頁面清單），只發 manifest 不發 sqlite。

## 7. 已知缺陷

- **page census 與抽取脫鉤**：reset 不清 pages，PAGE_CENSUS 是獨立動作。後果是目錄可能過期（範例：28.4% 節點在目錄中不存在）。查詢層已改為從 nodes.page_name 聚合，plugin 端待修。
- **kNN 分類 LOO 57%**：只適合當複審佇列，不適合自動寫入。
- **無縮圖**：視覺判斷仍要回 Figma；看板只提供色票與型別比例。
