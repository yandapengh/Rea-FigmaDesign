# VALIDATION

> 每個數字都能被第三者重跑。這份文件說明「用什麼方法證明什麼」，而不是只列結果。

## 1. 三類證據

| 類型 | 要回答的問題 | 方法 |
|---|---|---|
| 資料正確性 | 抽取出來的東西和 Figma 一致嗎？ | 全量對帳、實地抽查、來源檢查 |
| 方法可信度 | 判斷規則真的有效嗎？ | 人工標註、留一驗證、信心分級 |
| 流程可重現 | 換一個人／agent 能跑完嗎？ | 前置檢查、gate、兩次冷啟動測試 |

## 2. 資料正確性

### 2.1 全量抽取對帳

不抽樣。plugin 送完所有 chunk 後回報總數，server 寫入 `file_meta.total_nodes`：

    SYNC_COMPLETE  nodes=163601  pages=13  components=84  variables=3
    sqlite 實際     163601

兩邊一致才算完成。任何一批被拒絕，plugin 會顯示紅色的 **Incomplete**，不會假裝成功。

### 2.2 實地抽查 10/10

設計師在 Figma 裡逐一開啟節點，比對資料庫的預測狀態：

| 節點 | 畫面 | 類型 | 預測 | 文案 |
|---|---|---|---|---|
| 33:27783 | NFC | FRAME | success | Tap successful |
| 1:102789 | Withdraw | INSTANCE | success | Withdraw successful |
| 1:16993 | NFC | COMPONENT | success | Activation successful（master） |
| 1:63834 | Request money | INSTANCE | success | Payment successful |
| 1:102796 | Withdraw | INSTANCE | failed | Withdraw failed |
| 1:22374 | NFC | FRAME | failed | Activation failed |
| 1:63833 | Request money | INSTANCE | failed | Payment failed |
| 1:102810 | Withdraw | INSTANCE | processing | Withdraw processing |
| 1:84359 | Bank Topup | INSTANCE | processing | Topup processing |
| 1:84789 | Bank Topup | INSTANCE | MIXED | Topup failed + processing icon |

**10/10 與 Figma 畫面一致。**

### 2.3 工具自己抓到的檔案缺陷

`1:84789` 的標題寫「Topup failed」，但圖示是 processing 元件、內文描述 processing。這不是抽取錯誤，是**檔案本身的不一致**——工具第一次自己抓到的設計缺陷。

### 2.4 來源可追溯

`verify-source` 檢查三份資料的每個 ID 都存在、名稱與 DB 一致：

    42 labels + 249 predictions + 249 queue rows → 全部通過

任何一筆不存在就 FAIL，且掛在 `sync` 的最後一步，不可能被跳過。

## 3. 方法可信度

### 3.1 人工標註作為 ground truth

42 個畫面由設計師標註分類與新舊世代。版面原型在這個集合上：

    precision 1.00 / recall 1.00

### 3.2 留一驗證（leave-one-out）

每次拿掉一個標註，用其餘預測它：

| 信心等級 | 樣本數 | 準確率 |
|---|---|---|
| 全票（1.0） | 83 | 86% |
| 多數（0.67） | 133 | — |
| 分裂（≤0.33） | 33 | 不自動採用 |
| 整體 | 249 | 57% |

結論：只有全票可以當建議，其餘進人工複審。這是刻意的——**低準確率的自動化比沒有自動化更危險**。

### 3.3 已知偏差

- 標註由同一位設計師完成，沒有跨人一致性檢查
- 只涵蓋一個檔案、一個產品線
- 分類體系是這個團隊的，不是通用的

## 4. 流程可重現

### 4.1 四道 gate

| Gate | 證明什麼 |
|---|---|
| `npm run doctor` | 環境、資料、labels、腳本都可用；乾淨 checkout 也能通過（warning 提示要先抽取） |
| `npm run test:pipeline` | Phase 1 端到端（不需 Figma） |
| `npm run test:parity` | CLI 的 JSON 與 core 逐位元一致 |
| `npm run query -- verify-source` | 每個輸出的 ID 都存在 |

### 4.2 冷啟動測試

讓一個**全新的 agent**（無對話歷史）只讀 `docs/SKILL.md` 與 `docs/QUERY.md`，執行完整流程：

| 輪次 | 結果 | 發現 |
|---|---|---|
| 第一次 | 完成流程 | 7 個文件缺口（缺少格式範例、停止條件、taxonomy 用法） |
| 第二次 | 完成流程 | 8 個新缺口（錯誤路徑、批次備註、跨頁選取） |
| 修正後 | — | 15 個缺口全部補進 SKILL／QUERY |

冷啟動的價值不是「證明文件寫得好」，而是**用一個沒有記憶的讀者去測文件**。

## 5. 如何重跑

    npm run doctor
    npm run test:pipeline
    npm run test:parity
    npm run query -- verify-source
    npm run audit:db -- ./data/rea-figma.sqlite

資料位置見 [SAMPLES.md](SAMPLES.md)。沒有資料時，doctor 會以 warning 提示先跑抽取。
