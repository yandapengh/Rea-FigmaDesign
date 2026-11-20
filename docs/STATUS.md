# Rea-FigmaDesign · 專案狀態（v0.2.0）

> 2026-11-20 · Part 1 完成、Part 2 待啟動

## 背景

一份跑了兩年的支付設計檔，頁面與畫面數量早已超過人工翻閱的負荷。
Figma 擅長畫，不擅長「查」：改名、複製、隱藏稿、新舊版本交錯，讓「這頁到底屬於哪一類」變成只能靠記憶的工作。

這個專案把 Figma 的 AST 抽成本地 SQLite 圖譜，讓：

1. 設計師用 node ID 與分類快速複審、回貼 Figma 驗證
2. agent 用 CLI／MCP 直接查結構、家族、風格、分類
3. 分類語意留在 labels，AST 圖譜本身不被任何團隊的命名污染

## 目前做什麼

### 抽取

- Figma 雙執行緒插件：一次只載入一頁、迭代遍歷、250 筆或 ~1MB 送出一批、每批等 ACK
- 本機 WebSocket server 寫入 SQLite：單頁 staging → 原子覆蓋，不會有幽靈 ID
- 一檔一資料夾：data/<file-key>/graph.sqlite；複合鍵支援拆檔合併
- 匯出 opacity；空頁標 SKIPPED；中斷自動 rollback

### 分析

- Tier 1：Merkle 結構 hash、z-order 版面原型（page / overlay-panel / overlay）
- 分類：6 大類（老UI、新UI、系統UI、彈窗類、頁面類、廢棄）+ 一層小類
- 年代軸：顏色 + 結構 kNN，人工標籤 LOO 99%
- 隱藏稿：opacity ≤ 35% 自動標廢棄

### 工具

- CLI：doctor / health / tier1 / sample / hidden / report:category / audit
- MCP：11 個查詢與標註工具
- DSH Skill：.dsh/skills/rea-figma-design（可安裝、自動載入）
- DSH 命令：/rea-figma-review、/rea-figma-doctor

## 目前資料（2026-11-20）

| 項目 | 數值 |
|---|---|
| Pages | 75（51 有內容 + 24 空頁） |
| Nodes | 889,342 |
| Labels | 2,581 個畫面 |
| 大類 | 老UI 1,710 · 頁面類 340 · 新UI 336 · 廢棄 100 · 彈窗類 91 · 系統UI 4 |
| 頁面小類 | 30 種 |
| 彈窗小類 | 15 種 |
| 健康檢查 | PASS（staging 0、SYNCING 0、0 幽靈） |

## 迭代方向

### Part 2（下一步）

1. 階段 4：用 labels v2 重跑 Tier 2 基線、抽 5–8 筆錯分、定達標指標
2. 階段 5：剝洋蔥正規化 + Tier 1.5 鬆弛指紋
3. 階段 6：Detach 變異組件溯源
4. 階段 7：UX 版面體檢表
5. 階段 8：收編與回歸

### 工程債

- labels/screens-v2.json 尚未接進 query/MCP（舊 labels/screens.json 仍是空檔）
- 舊 query 命令（apply/review/propagate）是 legacy，需移除或改寫
- taxonomy 尚未同步到 docs/QUERY.md
- DSH 市集上架前需先評估插件形式與打包

## 設計原則

1. AST 圖譜是唯一 baseline；團隊語意只放 labels
2. 匯出失敗不可破壞舊資料；單頁原子覆蓋
3. 不確定就 unknown，不硬猜
4. 所有數字要能從 SQLite 重現，ID 可回貼 Figma
5. 先本地實驗，通過 A/B 才收編

