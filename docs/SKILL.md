# SKILL — Rea-FigmaDesign 圖譜操作

> 這份文件只寫**判斷**與**契約**，不寫步驟細節。步驟已固化在 `npm run sync`。
> 如果你是 agent：先讀〈鐵律〉，跑 `npm run doctor`，再照〈流程契約〉執行。

## 何時用

- 在 Figma AST 圖譜上做結構／風格／分類查詢
- 把設計師的分類回饋寫回 labels
- 判斷「這批頁面是不是同一類、哪個是例外」

## 鐵律

1. **路徑由 CLI 解析**，不要自己拼絕對路徑，也不要要求使用者先 `cd`。
2. **產物只能進 `.scratch/`**；其他地方一律算錯。
3. **`labels/` 是來源**，只有 `apply`（或人工確認後的編輯）可以改，改完要 commit。
4. **不要用圖層名稱當識別依據**；身份是結構 hash。
5. **不確定就回報**；`unknown` 是合法結果。
6. **adapter 不得重算核心**；改動後必須跑 `npm run test:parity`。
7. **斜線命令不吃參數。** 命令是固定動作（開板、檢查），只接受零參數。分類名稱這類模糊輸入由 agent 解析後「回填 CLI 參數」，不要讓使用者在命令後面打分類名——DSH 的命令輸入只有非結構化文字，沒有補全、沒有拼字檢查，打錯只會靜默失敗。

> 三層分工：**命令**（固定動作、零 token）→ **agent**（自然語言 → 精確分類）→ **CLI**（exact match，錯了回 `did you mean`，絕不猜）。

## 開工前

```bash
npm run doctor
```

非 0 退出 → 停止，貼 FAIL 行與 fix 提示，不要繞過。

## 流程契約

| # | 指令 | 通過條件 | 不通過就 |
|---|---|---|---|
| 1 | `npm run doctor` | 末行 `RESULT: OK`、exit 0 | 停止，貼 FAIL 行與 fix |
| 2 | `npm run sync` | 末行 `RESULT: OK — CLI output is byte-identical to core`、exit 0 | 停止，貼最後 10 行 |
| 3 | 設計師在 `.scratch/review.html` 操作 | 產出回饋 Markdown（格式見下） | 等待，不要代為判斷 |
| 4 | `npm run query -- apply --md <file> --dry-run` | `unknown=0` 且 `updated+added` = 你動過的列數 | 停止，貼 unknown 清單 |

**「動過」的定義**：分類與現有標註不同、或備註非空。同一 ID 出現多列只算一列（最後一列為準）。
| 5 | `npm run query -- apply --md <file>` | 印出 `written ...` | 停止 |
| 6 | `npm run sync` | 同第 2 步 | 停止 |

**第 2、6 步的 parity 是硬門**：證明 CLI 與 core 逐位元相同。紅了代表 baseline 分岔，不許繞過、不許重跑、直接回報。

## 回饋 Markdown 格式

`apply` 以**欄名**解析，不依賴欄位順序。最少需要 `ID` 與 `正確分類` 兩欄：

```markdown
| ID | 正確分類 | 備註 |
|---|---|---|
| 1:102789 | 支付結果頁 | Withdraw 流程的成功頁 |
| 1:114768 | 抽屜彈窗 | 底部拉起，不是通用彈窗 |
```

- `ID`：Figma 節點 ID，格式必須是 `數字:數字`
- `正確分類`：取自 `labels/screens.json` 的 taxonomy（見下）
- `備註`：可省略；空白或 `-` 代表沒有
- 也可以直接貼 review 板「複製 Markdown」的六欄版本，多餘欄位會被忽略
- 同一 ID 出現多列時，**以最後一列為準**，且只計一次
- 分類同時存在於 page 與 dialog 兩組 taxonomy 時，`apply` 會拒絕（先改名）

**沒有設計師在場時**：不要自己發明回饋。可以從 `.scratch/predictions.jsonl`（或 `.scratch/review-queue.md`）取 ID 做 **dry-run 演練**，但：

- 只能用 `--dry-run`，**不得實際寫入**
- 必須在回報中標明「演練，未取得設計師確認」
- 不得把演練結果描述成「設計師已確認」

## added 與 unknown 的差別

| 情況 | apply 行為 | 你要做什麼 |
|---|---|---|
| ID 在樣本內、但還沒標註 | `added`：新增一列 | 正常，繼續 |
| ID 在樣本內、已有標註 | `updated`：修改分類／備註 | 正常，繼續 |
| ID 不在樣本內 | `unknown`：不寫入 | **停止**，確認是否打錯或跨檔 |

看到 `unknown > 0` 就不准往下寫入。

## 分類規則

1. 分類必須來自 `labels/screens.json` 的 `taxonomy`（`page` / `dialog` 兩組）。
2. 沒有合適分類時，用 `其他`，並在備註寫原因；**不要自創分類**。
3. 要新增分類，先問使用者，再改 taxonomy。

## 抽查規則

使用者問「把某分類的頁面找出來」時：

1. 先跑 `npm run query -- category <名稱>`。
2. 該分類 **≤ 40 張**：直接全量列出。
3. **> 40 張**：預設給 **10 個抽查**，並在回覆中明寫 `total=N shown=10`。
4. 使用者說要全量，才加 `--all`。

不得靜默截斷：任何抽樣都必須同時顯示總數與實際顯示數。抽樣是為了讓設計師用有限時間判斷，不是為了省 token 而藏資料。

## 來源完整性

ID 與名稱必須一一對應 SQLite 樣本，不得自行生成或改名。

- `npm run query -- verify-source` 會檢查 labels／predictions／review-queue 的每個 ID 是否存在、名稱是否與 DB 一致
- `npm run sync` 最後一步已包含這個檢查；失敗即整條流程失敗
- 抽查時若某個 ID 在 DB 找不到，直接報錯，不要用鄰近資料補

## 停止條件

除了流程表的失敗條件，遇到這些也要停：

- `unknown > 0`
- `updated + added` 與你動過的列數不符
- review 佇列中 confidence < 0.4 的比例超過 20%（代表標註不足，先補標註，不要批次套用）
- parity 紅字
- `labels/` 有未提交變更：能 commit 就先 commit；**若被指示不得修改／commit，則停止並回報**，不要在有未提交變更的狀態下繼續

## 偏離處理

如果因為指示或環境必須跳過某一步（例如不寫入、不開瀏覽器）：

1. 在回報中明寫「偏離：跳過第 N 步」
2. **仍然要確保 parity 跑過**：第 6 步的 `sync` 已內含 parity；只有在你跳過 `sync` 時，才需要單獨跑 `npm run test:parity`
3. 不得把偏離後的狀態描述成「流程完成」

## 證據要求

每個動作回覆時要附：

- `doctor` 的 `RESULT` 行與 exit code
- `sync` 最後 5 行
- `apply` 的 `updated=` / `added=` / `unknown=` 計數行

需要機讀時再加 `--json`；人類可讀的預設輸出已經包含上述計數。不要用「已完成」代替輸出。

## 失敗處理

| 症狀 | 處理 |
|---|---|
| `--out must stay inside .scratch/` | 改路徑，不要放寬限制 |
| node not found | ID 來自舊樣本，確認樣本或重跑抽取 |
| `predictions not found` | 先跑 `sync` |
| `labels/*.json invalid` | 從 git 還原，不要手改結構 |
| `quick_check` 失敗 | 樣本損壞，重新凍結 |
| 不確定指令參數 | `npm run query -- <command> --help` |

## 不要做

- 不要為了讓流程跑通而修改 `server/db.ts` 的 schema
- 不要把分類寫進程式碼（那是 labels 的責任）
- 不要在沒有 `doctor` 與 parity 通過的情況下宣稱完成
