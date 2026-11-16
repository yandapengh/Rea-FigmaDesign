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

對應 `PLAN.md` §8。順序刻意：先寫決策，再寫架構，最後改 README。

- [ ] `docs/DECISIONS.md` — 為什麼 Merkle hash 當身份、名字只是弱先驗、archetype 用 z-order、變體軸不做語意、MCP 不引 SDK、DSH 用 plugin 當主體、命令不吃參數、`unknown` 是合法結果
- [ ] `docs/ARCHITECTURE.md` — 分層圖（plugin → relay → SQLite → core → CLI/MCP/DSH plugin）、每個邊界的資料契約、模組地圖
- [ ] `README.md` 改寫 — 問題陳述、quickstart、命令表、工具拒絕做什麼、看板截圖
- [ ] 驗證紀錄 — 10/10 實地檢查、42 個標註、三道 gate、兩次冷啟動測試與補洞
- [ ] repo 衛生 — 確認 `data/`、`backups/`、`.scratch/`、`dsh-plugin/dist/` 未入版控；無密鑰；LICENSE
- [ ] 樣本打包 — 只發 `*.manifest.json` 與 sha256，不發 SQLite

## 待你決定

- [ ] 補 2–3 組新舊世代標註（目前資料在 `~/Downloads/rea-figma-data-2026-11-13/labels`）
- [ ] `unknown` 的處理：人工複審 or 先放一邊

## 已知限制（寫進 README）

- [ ] `pages` 表與抽取脫鉤：`resetTxn` 不清 `pages`、`PAGE_CENSUS` 是獨立動作。查詢層已繞過，plugin 端待修（下次重跑前加 5 行）
- [ ] kNN 傳播 LOO 57%，只有全票（86%）可作建議
- [ ] 無縮圖；排查板用色票／型別比例／文案當視覺替代

## 之後（不著急）

- [ ] 語意字典的增量維護做成 Skill，隨專案沉澱（核心不依賴）
- [ ] 縮圖匯出（plugin `exportAsync`）+ VLM，只在 AST 判不了時啟用
