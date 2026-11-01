# 需求與範圍

## 一、目標

### 1.1 作業的原始要求

| 要求 | 對應的文件 |
|---|---|
| 用 AI 建立簡易的結帳系統，約 2～3 次 prompt 產出可以執行的版本 | 本文件「七、開發順序」 |
| 能在本機執行；使用者能完成付款，第三方金流可以 mock | [architecture.md](./architecture.md)、[checkout-flow.md](./checkout-flow.md) §五 |
| 結帳頁可以輸入 Product ID 或商品資訊 | 本文件「四、頁面」 |
| UX 不限定，可以自己設計 | 使用 Element Plus |
| 面試時要介紹設計與架構，並且可能被要求新增功能 | [trade-offs.md](./trade-offs.md)、[extensibility.md](./extensibility.md) |

### 1.2 自訂的工程品質目標

以下目標不是作業明確要求的，而是這次練習自己選擇的：

1. **不超賣**：有數量限制的商品，在多人同時結帳時，有效的庫存保留不會超過可以賣的數量
2. **付款失敗可以重試**：沿用原本的訂單和庫存保留，建立一筆新的付款嘗試
3. **明確的狀態機**：訂單和付款各自有合法的狀態轉換，訂單的每一次轉換都有紀錄
4. **冪等**：HTTP 重送不會重複建立訂單或重複扣款；重複的付款通知不會重複確認庫存
5. **容易擴充**：之後加入限時優惠價和促銷碼時，不需要修改核心流程

**原則**：先用 PostgreSQL 的 transaction 保證正確性。只有在拿到效能數據、確認瓶頸之後，才討論 Redis、Queue 這類優化。

---

## 二、商品類型

| 類型 | `inventory_policy` | 範例 | 下單時 | 防超賣 |
|---|---|---|---|---|
| 有數量限制 | `LIMITED` | 限量周邊、實體商品 | 條件式 UPDATE 保留庫存，庫存不足時拒絕下單 | ✅ |
| 無數量限制 | `UNLIMITED` | 數位商品、贊助方案 | 不碰庫存 | 不需要 |

兩種類型都有單筆訂單的購買上限（`max_quantity_per_order`）。

---

## 三、範圍

| 要做 | 不做 |
|---|---|
| 用 Product ID 載入商品；每筆訂單一個商品，可以選擇數量 | 購物車、一筆訂單包含多個商品（資料表已經支援） |
| 兩種商品類型：有數量限制、無數量限制 | 商品規格、組合商品、預購 |
| 結帳資訊只有姓名和 Email | 會員登入、收件地址、運費、發票 |
| 用原價計價，並預留擴充點 | **限時優惠價、促銷碼**（只設計，不實作，見 [extensibility.md](./extensibility.md)） |
| Mock 信用卡付款：成功、失敗、逾時（結果不明） | 串接真實金流、3D Secure、ATM、超商代碼付款 |
| 付款失敗後重新付款 | 退款、退貨、爭議款 |
| 取消訂單、逾時後釋放庫存 | 後台管理介面 |
| 背景對帳：查出結果不明的付款 | Redis、Message Queue、微服務、讀寫分離、partition |
| 訂單狀態歷史、庫存流水帳、webhook 原始紀錄 | |

---

## 四、頁面

UI 使用 Element Plus 元件，不寫自訂 CSS。

| 路徑 | 內容 |
|---|---|
| `/` | 輸入 Product ID；下方列出所有商品，方便 Demo |
| `/checkout?product_id=1` | 商品名稱、價格、類型、可以賣的數量（只有 LIMITED 商品會顯示）；選擇數量、填寫姓名和 Email；顯示應付金額；「確認下單」 |
| `/orders/:id` | 用 `el-steps` 顯示訂單進度、倒數計時、輸入卡號付款、付款紀錄、狀態歷史；付款失敗時可以重新付款；付款狀態是 `PROCESSING` 或 `UNKNOWN` 時，每 2 秒輪詢一次；可以取消訂單 |
| `/demo` | 只在 local 環境開放（自動化測試的 `testing` 環境也開放，以便測試這些端點，參考 trade-offs.md #30）：各商品的 `available`／`reserved`／`sold`、ledger 對帳結果；以及「執行逾時釋放」「執行對帳」「送出 webhook」「重設資料」這幾個按鈕 |

`/demo` 面板讓面試時不必等 10 分鐘的保留期限，或 2 分鐘的對帳等待時間，按一下就能觸發。它呼叫的指令和 Scheduler 執行的是**同一個 command**。

---

## 五、驗收標準

**基本流程**

- [x] `docker compose up` 之後，就能從頭到尾完成付款
- [x] LIMITED 商品付款成功後：訂單是 `PAID`，`reserved` 減少數量 q，`sold` 增加數量 q
- [x] UNLIMITED 商品付款成功後：訂單是 `PAID`，不會產生任何庫存異動
- [x] 第一次付款失敗、第二次付款成功：只有一筆訂單、兩筆付款紀錄，庫存只確認一次

**防超賣**

- [x] 庫存不足時，下單回傳 `409 OUT_OF_STOCK`
- [x] LIMITED 商品剩下 5 件時，同時送出 20 個購買 1 件的請求：剛好 5 筆成功，`reserved = 5`，`available = 0`
- [x] 同時對 UNLIMITED 商品送出 20 個請求：全部成功
- [x] 購買數量超過 `max_quantity_per_order` 時，回傳 422

**冪等**

- [x] 用同一個 Idempotency-Key 重送下單或付款請求：不會建立第二筆資料（訂單／付款的筆數不變）；回應指向同一筆訂單／付款（回應的 `id` 與第一次相同），內容是該資源**目前**的狀態，不是第一次回應的快照（例如第一次回 `UNKNOWN`，對帳後用同一個 Key 重送會拿到 `SUCCEEDED`；理由參考 trade-offs.md #27）
- [x] 同一個 key 帶著不同的請求內容：回傳 422
- [x] 付款成功的 webhook 送兩次：庫存只變動一次，`payment_events` 只有一筆驗簽成功的紀錄

**例外情況**

- [x] 使用逾時卡號時：付款是 `UNKNOWN`，不能重新付款，也不能取消訂單；對帳之後才會轉成正確的終止狀態
- [x] 有 `UNKNOWN` 付款的訂單即使過期，也不會被釋放；要等對帳完成後才會處理
- [x] 訂單到期而且沒有進行中的付款時：轉成 `CANCELLED`（`TIMEOUT`），庫存被釋放
- [x] 已經是終止狀態的訂單，不能再付款，也不能取消
- [x] 簽章錯誤的 webhook 回傳 401，並且被記錄下來

**一致性**

- [x] 任何時間點，ledger 的加總都等於 `inventories` 的三個欄位
- [x] 訂單的每一次狀態轉換，都有一筆 `order_status_histories`

**併發測試的注意事項**：Laravel 的 `RefreshDatabase` 會把每個測試包在一個 transaction 裡，所有請求都使用同一個連線，所以測不出併發問題。併發測試要對 Docker 裡執行中的 app 發出真正的 HTTP 請求（例如用 `Http::pool`），測試前後自己清理資料。

---

## 六、面試 Demo 腳本

| # | 情境 | 操作 | 要展示的重點 |
|---|---|---|---|
| 1 | 正常付款 | 對 LIMITED 商品下單 2 件，用卡號 4242 付款 | 完整流程；`/demo` 上的庫存變化；訂單的狀態歷史 |
| 2 | 兩種商品類型 | 對 UNLIMITED 商品下單 | 不會產生任何庫存異動；說明策略模式 |
| 3 | 失敗後重試 | 先用卡號 0002 付款，再用 4242 | 同一筆訂單有兩筆付款；庫存沒有被釋放 |
| 4 | 不超賣 | 執行併發腳本，20 個請求搶 5 件 | 剛好 5 筆成功；說明條件式 UPDATE 和 CHECK |
| 5 | 結果不明 | 用卡號 9995 付款，再按「執行對帳」 | `UNKNOWN` 時不能重新付款；對帳後轉成 `PAID`，狀態歷史顯示 `SYSTEM` |
| 6 | 冪等 | 按「送出 webhook」兩次 | 庫存沒有變化；`payment_events` 擋下重送 |
| 7 | 逾時 | 建立訂單後，按「執行逾時釋放」 | 訂單變成 `CANCELLED`（`TIMEOUT`），`reserved` 減少 |
| 8 | 擴充 | 說明如何加入限時優惠價 | 只需要新增 `SalePriceRule` 和一張表（[extensibility.md](./extensibility.md) §四） |

---

## 七、開發順序（對應 2～3 次 prompt）

| Prompt | 內容 | 完成時可以展示的情境 |
|---|---|---|
| 1 | Docker Compose、migration、seed（兩種商品）、商品頁、下單（`InventoryPolicy`、`PriceCalculator`）、Mock 金流（卡號 4242／0002）、訂單頁 | 1、2、3 |
| 2 | Idempotency、狀態機與狀態歷史、partial unique index、webhook 與 `payment_events`、併發測試 | 4、6 |
| 3 | 逾時卡號（9995／9987）、`UNKNOWN`、對帳、逾時釋放、Scheduler、`/demo` 面板 | 5、7 |

每一次 prompt 完成後，都要自己 review 程式碼並執行測試。不可以讓 AI 自行加入 Redis、Queue 或其他不必要的架構。
