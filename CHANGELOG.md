# Changelog

## v0.2.0 — 2026-11-20

### Part 1 完成：全量 Figma 檔穩定入庫

- 插件：頁面勾選、狀態、ACK 背壓、逐頁載入、進度與失敗診斷
- 伺服器：per-file 資料夾、staging 原子換頁、複合鍵、中斷 rollback、heartbeat
- 全量實戰：75 頁 / 889,342 節點 / 51 DONE + 24 空頁 / 0 幽靈
- 匯出 opacity，支援隱藏稿偵測

### 標註與分類

- 標註 2,581 個畫面，6 大類 + 一層小類
- 頁面類收斂到 30 個小類
- 老UI/新UI：顏色 + 結構模型，人工標籤 LOO 99%
- 隱藏稿 51 個自動標為廢棄

### 工具

- 新增 health / tier1 / sample / hidden / report:category
- 重寫 docs/SKILL.md；新增可安裝 DSH Skill（.dsh/skills/rea-figma-design）
- MCP 11 工具與 DSH 命令維持可用

### 清理

- 移除掃描隱藏稿特例；一次性腳本歸檔
- 修正 total_nodes 計數、頁面身份合併、狀態刷新

## Unreleased

- Part 2 階段 4：Tier 2 基線分析
- labels v2 接進 query/MCP

