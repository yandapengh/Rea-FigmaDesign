# TODO

## 已完成

- [x] A. 查詢層脫離 `pages` 表（一律從 `nodes.page_name` 聚合）
- [x] B. `labels → derive → classify` 迴圈
- [x] C. 變體軸自動抽取（vocabulary-free）
- [x] D. `find` 召回分層（L1 同構 / L2 近構 / L3 樣式近）
- [x] 版面原型 archetype（z-order 遮罩規則，42 個標註 precision/recall 1.00）
- [x] 可視化排查板（批次分類／備註、複製 ID、Figma 指令、動態分組）
- [x] `apply`（Markdown 回饋 → labels）+ `sync`（含 parity 與 verify-source 硬門）
- [x] CLI handler 改呼叫 `core/analyze.ts`，消除重複計算
- [x] MCP adapter（stdio JSON-RPC、9 工具、呼叫紀錄）
- [x] DSH plugin（`/rea-figma-review`、`/rea-figma-doctor`）
- [x] `docs/QUERY.md`、`docs/SKILL.md`、成功判準（PLAN §4.3）
- [x] 測試資料與 labels 移出 repo，doctor 支援乾淨初始狀態

## 下週一（2026-11-16）發布整備

對應 `PLAN.md` §8。**2026-11-16 完成**，另加了產品頁 `docs/index.html` 與 `docs/graph.html`。

- [x] `docs/DECISIONS.md` — 為什麼 Merkle hash 當身份、名字只是弱先驗、archetype 用 z-order、變體軸不做語意、MCP 不引 SDK、DSH 用 plugin 當主體、命令不吃參數、`unknown` 是合法結果
- [x] `docs/ARCHITECTURE.md` — 分層圖（plugin → relay → SQLite → core → CLI/MCP/DSH plugin）、每個邊界的資料契約、模組地圖
- [x] `README.md` 改寫 — 問題陳述、quickstart、命令表、工具拒絕做什麼、看板截圖
- [x] 驗證紀錄 — 10/10 實地檢查、42 個標註、三道 gate、兩次冷啟動測試與補洞
- [x] repo 衛生 — 確認 `data/`、`backups/`、`.scratch/`、`dsh-plugin/dist/` 未入版控；無密鑰；LICENSE
- [x] 樣本打包 — 只發 `*.manifest.json` 與 sha256，不發 SQLite

## 已完成（2026-11-17）

- [x] `docs/graph-concept.html`：用渲染的節點樹／家族／成本圖解釋圖譜（給非技術讀者）

- [x] `list_screens` 的缺口判定與 `DECISIONS.md` D13（列舉 / 單體 / 聚合三種查詢形狀）
- [x] `docs/QUERY.md`「工具約束與守則」：可強制 / 不可強制 / 真正的保證
- [x] schema 收緊：`archetype` enum、`limit` 範圍、`annotations`、`apply_labels.rows` 嚴格化
- [x] 新增 `npm run test:mcp`（工具數、enum、annotations、未知工具、server_info）並納入 `doctor`
- [x] **修復 PATH 依賴**：MCP 與 DSH plugin 改用 `node + tsx/dist/cli.mjs`，不再依賴 `.bin/tsx` 的 `env node`
## 2026-11-17：MCP 工具表面與約束

背景：寫 `docs/graph.html` 時發現 MCP 少了「列出全部畫面」這個原語，補了 `list_screens`（工具數 9 → 11，含先前的 `server_info`）。使用者問了三個問題，明天要回答並落地：

- [x] **`list_screens` 是不是漏掉的工具？** 是：MCP 原本只覆蓋「單頁 / 家族 / 待分類」，沒有列舉原語；列舉只在 CLI 的 `sheets --unique`。把這個判斷寫進 `docs/DECISIONS.md`（新增一條：工具表面要覆蓋「列舉、單體、聚合」三種查詢形狀）
- [x] **完善之後，別人的模型會守規矩嗎？** 需要把「schema 只能約束形狀、不能約束意圖」講清楚：
  - 可強制：型別、必填、enum、數值範圍、`additionalProperties:false`、`apply_labels` 的 `confirm:true`、server 端驗證與 error code
  - 不可強制：模型選哪個工具、怎麼解讀數字、會不會把結構答案說成語意答案
  - 真正的保證：數字由 server 計算、輸出帶可驗證 ID；說錯可被重跑抓出
- [x] **schema 有沒有對應約束？** 已加：`archetype` enum（page / overlay-panel / overlay / unknown）、`limit` 的 minimum/maximum、`annotations`（readOnlyHint / destructiveHint）、`apply_labels.rows` 的 `additionalProperties:false`。明天驗證 `tools/list` 實際輸出並補測試
- [x] 在 `docs/QUERY.md` 加一節「工具約束與守則」：上面「可強制 / 不可強制 / 真正的保證」三段
- [x] 重啟 MCP 子進程，確認 11 個工具與 annotations 生效（`kill` 後 client 會自動重連）
- [x] 評估是否再補 `verify_source`（來源檢查）與 `manifest`（工具表面）兩個工具；若不做，寫明理由
- [x] 把 `docs/graph.html` 的 04 節與新約束對照，確認敘述一致
- [x] 推送今天的 commit（2026-11-16 完成）

## 待你決定

- [ ] 補 2–3 組新舊世代標註（目前資料在 `~/Downloads/rea-figma-data-2026-11-13/labels`）
- [ ] `unknown` 的處理：人工複審 or 先放一邊

## 已知限制（寫進 README）

- [ ] `pages` 表與抽取脫鉤：`resetTxn` 不清 `pages`、`PAGE_CENSUS` 是獨立動作。查詢層已繞過，plugin 端待修（下次重跑前加 5 行）
- [ ] kNN 傳播 LOO 57%，只有全票（86%）可作建議
- [ ] 無縮圖；排查板用色票／型別比例／文案當視覺替代

## 之後（不著急）

- [x] 把 case-popup.html 改成對話式（使用者一句話 → 工具呼叫卡片 → 回傳 → 解釋）
- [ ] 工具約束的敘事頁（獨立的 HTML 專題，不併進 graph.html）

- [ ] 語意字典的增量維護做成 Skill，隨專案沉澱（核心不依賴）
- [ ] 縮圖匯出（plugin `exportAsync`）+ VLM，只在 AST 判不了時啟用
