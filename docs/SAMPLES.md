# SAMPLES

> 凍結樣本讓「昨天的結論」可以被重跑。SQLite 本身不進 repo，只有 manifest 與 sha256。

## 1. 已凍結的樣本

| 樣本 | 節點 | 頁 | 元件 | 變數 | 大小 | sha256（前 12 碼） |
|---|---|---|---|---|---|---|
| 2026-11-13-baipai-13p | 117,166 | 13 | 83 | 0 | 484,954,112 | `47497aed0beb` |
| 2026-11-13-baipai-14p-newold | 163,601 | 13 | 84 | 3 | 484,954,112 | `382ae8928aca` |

完整 manifest（節點型別、頁面組成、深度、instance 數、token 綁定數）：

- [samples/2026-11-13-baipai-13p.manifest.json](samples/2026-11-13-baipai-13p.manifest.json)
- [samples/2026-11-13-baipai-14p-newold.manifest.json](samples/2026-11-13-baipai-14p-newold.manifest.json)

兩個樣本來自同一份生產檔案（payment product (anonymised)）的不同抽取時點：13p 是 09:56、14p 是 10:40。14p 多了「新舊頁面對比測試集」頁面，這也是 page census 缺陷被發現的樣本。

## 2. 發布策略

| 發布 | 不發布 |
|---|---|
| `*.manifest.json`（3–4 KB） | `*.sqlite`（462 MB） |
| sha256 | 節點內容 |
| 統計數字 | 頁面截圖 |

原因：repo 要能被 clone，而不是被下載 1 GB。manifest 足以驗證「你手上的樣本是不是這一份」。

## 3. 凍結流程

    npm run query -- sample <id>        # 產生 data/samples/<id>.sqlite
    # 1. VACUUM INTO 或 backup API（不直接複製執行中的 WAL 檔）
    # 2. PRAGMA journal_mode=DELETE     # 讓檔案可被單獨攜帶
    # 3. 計算 sha256、寫 manifest（節點數、頁面、型別分佈）
    # 4. manifest 進 repo；sqlite 進外部資料夾

manifest 的 `artifact.sha256` 是驗證的錨點：任何人拿到 sqlite 都可以重算並比對。

## 4. 接回樣本

    mkdir -p data/samples
    cp <external>/2026-11-13-baipai-14p-newold.sqlite data/samples/
    npm run query -- sheet <id> --sample 2026-11-13-baipai-14p-newold

或把整個外部資料夾接回：

    REA_DB_PATH=<external>/live/rea-figma.sqlite npm run start:server

## 5. 為什麼要凍結

| 問題 | 凍結樣本的回答 |
|---|---|
| 「上週的 249 個待分類怎麼來的？」 | 同一份 sqlite + 同一個 commit，重跑 |
| 「換一個 agent 會得到一樣結果嗎？」 | 會，因為核心是決定性的 |
| 「你的數字是不是挑過的？」 | manifest 有 sha256，樣本可下載重算 |

活資料庫（`data/rea-figma.sqlite`）會隨每次抽取改變；凍結樣本不會。
