# 02：簡易版結帳系統

一套可以在本機執行的結帳系統。使用者輸入 Product ID、選擇數量、下單，再用 mock 的信用卡付款。付款失敗可以重新付款。有數量限制的商品保證不會超賣。

技術：PHP 8.5（以 `docker/app/Dockerfile` 為準）、Laravel 13、Pest、Vue 3 + Vue Router + Element Plus（皆用最新穩定版）、Vite（最新穩定版）、PostgreSQL 16、Docker Compose。不使用 Redis 和 Queue。

## 文件

建議依照下列順序閱讀：

| # | 文件 | 內容 |
|---|---|---|
| 1 | [requirements.md](./requirements.md) | 目標、商品類型、範圍、頁面、驗收標準、Demo 腳本 |
| 2 | [architecture.md](./architecture.md) | 架構圖、元件職責、程式碼結構、時序圖、可靠性、資料庫連線數 |
| 3 | [database-schema.md](./database-schema.md) | ER 圖、DDL、每張表的設計重點 |
| 4 | [state-machines.md](./state-machines.md) | 訂單與付款的狀態機、連動規則、併發控制 |
| 5 | [checkout-flow.md](./checkout-flow.md) | 每個操作的交易步驟與 SQL、Mock 金流、Idempotency、API 合約（§九） |
| 6 | [extensibility.md](./extensibility.md) | 庫存策略、計價 pipeline；限時優惠價與促銷碼的未來設計 |
| 7 | [trade-offs.md](./trade-offs.md) | 39 項設計決策的取捨 |
| 8 | [tasks.md](./tasks.md) | 開發任務清單：里程碑、相依順序、驗收條件、對應的驗收標準與不變量 |
| 9 | [design-review.md](./design-review.md) | 設計審查的意見與每一輪的處理紀錄 |

完整的系統設計討論（鎖的比較、partition、架構演進）見 [01-checkout/docs](../../01-checkout/docs/)。

## 一句話說明各項保證

| 保證 | 做法 |
|---|---|
| 不超賣 | 條件式 UPDATE `WHERE available >= :qty`，加上 `CHECK (available >= 0)` |
| 不重複下單、不重複扣款 | Idempotency-Key 加明確命名的 UNIQUE；付款在 `FOR UPDATE` 之後再查一次 key；partial unique index：每筆訂單同時只有一筆進行中的付款，最多一筆成功的付款 |
| 不重複確認或釋放庫存 | 訂單狀態 CAS，加上 ledger 的 unique key |
| 結果不明時不誤判 | `UNKNOWN` 狀態加上對帳任務；在結果確定之前，不能重新付款，也不能取消；請求最長 30 秒，遠小於對帳的安全等待時間 |
| 自動流程處理不了的付款不會被吞掉 | handler 標記 `needs_review_at`，用 SQL 查得到；對帳不再重複掃描 |
| 付款和取消不會互相干擾 | 兩邊都對同一筆訂單 `SELECT ... FOR UPDATE` |
