# 設計取捨

> 每一項都列出：**選擇**、**替代方案**、**為什麼選它**、**代價**，以及**什麼時候該改**。
> 「什麼時候該改」是面試時最常被追問的部分：一個好的決策，要說得出它在什麼條件下會失效。
> #27 之後是進入實作前補上的決策（API 合約、Demo 工具、建置方式），另外多一列「不變量」，說明它和 `checkout-invariants` 的關係。#34 之後是設計審查第 1 輪（[design-review.md](./design-review.md)）新增的決策，#40 是第 2 輪新增的決策，#41 是 M1 程式碼審查與安全審查之後補上的決策。

## 總覽

| # | 決策 | 選擇 |
|---|---|---|
| 1 | 部署形態 | 單體 Laravel，加上單一資料庫 |
| 2 | 資料庫 | PostgreSQL 16 |
| 3 | Source of truth | 只用資料庫，不用 Redis |
| 4 | 扣庫存的方式 | 條件式原子 UPDATE |
| 5 | 扣庫存的時機 | 下單時保留，付款後確認 |
| 6 | 庫存的資料結構 | 三個欄位加 ledger，不建 reservation 表 |
| 7 | 防止重複付款 | partial unique index |
| 8 | 付款、取消、逾時的併發 | 鎖住訂單列（`FOR UPDATE`） |
| 9 | 呼叫金流的方式 | 在請求內同步呼叫，不用 Queue |
| 10 | Webhook 去重 | `payment_events` 加上狀態 CAS |
| 11 | 逾時與對帳的觸發方式 | Scheduler 每分鐘掃描 |
| 12 | Mock 金流 | 程式內的 adapter，加上獨立的資料表 |
| 13 | ID | UUIDv7，不另外產生 `order_no` |
| 14 | 付款的初始狀態 | 直接是 `PROCESSING`，不設 `CREATED` |
| 15 | 付款失敗時的庫存 | 繼續保留，期限不延長 |
| 16 | 前端取得付款結果 | 輪詢 |
| 17 | 狀態欄位的型別 | `VARCHAR` 加 `CHECK` |
| 18 | UI | Element Plus，不寫自訂 CSS |
| 19 | 逾時的訂單狀態 | `CANCELLED` 加上 `cancel_reason` |
| 20 | Idempotency 的儲存方式 | key 直接存在業務表上 |
| 21 | 計價時機 | 下單時才計價，不建 checkout session |
| 22 | 商品類型的處理方式 | 策略模式（`InventoryPolicy`） |
| 23 | 計價的結構 | Pipeline（`PricingRule[]`） |
| 24 | 退款 | 不建 `refunds` 表 |
| 25 | 狀態歷史的範圍 | 只記錄訂單的狀態歷史 |
| 26 | UNLIMITED 商品的庫存 | 不建 `inventories` 列 |
| 27 | 冪等重送的回應 | 依資源目前的狀態組出，不保存第一次的回應（使用者已確認，2026-10-19） |
| 28 | 前端的按鈕狀態 | 後端提供 `can_pay`、`can_cancel` 等提示欄位與 `server_time` |
| 29 | 付款結果的 HTTP 狀態碼 | 有建立付款就回 2xx（`FAILED` 200、`UNKNOWN` 202） |
| 30 | Demo 的「立即執行」 | 同一個指令加 `--force`，只略過時間條件 |
| 31 | Demo 的資料重設與 seed | `TRUNCATE ... RESTART IDENTITY CASCADE` 業務資料表（不含 Laravel 預設表）再 seed；seed 也寫 ledger |
| 32 | 前端的建置方式 | 放在 Laravel 專案內，由一次性的 `node` 容器建置；同一個 origin，CORS `paths => []` |
| 33 | 付款的 `request_hash` | 只用卡號末四碼計算，不含完整卡號 |
| 34 | Demo 路由的環境限制 | 路由一律註冊，由 middleware 在請求時依環境回 404（`local`、`testing` 開放，使用者已確認，2026-10-19） |
| 35 | 付款的冪等查詢 | 加鎖前查一次、`FOR UPDATE` 之後再查一次 |
| 36 | handler 無法自動處理的付款 | 標記 `needs_review_at`（不是狀態），不自動終止，交給人工 |
| 37 | 卡住的付款請求 | php-fpm `request_terminate_timeout` 30 秒，遠小於對帳安全等待時間 |
| 38 | Webhook 的交易範圍 | 事件 INSERT 獨立 COMMIT；未處理完的事件重送時重新交給 handler |
| 39 | `request_hash` 的輸入 | 先正規化型別，hash 與 Action 使用同一份輸入 |
| 40 | 驗簽失敗的 webhook 事件 | `payload`、`event_key` 在驗簽前算好；`payment_id` 一律 NULL，驗簽成功後才查詢 `payments` |
| 41 | API 限流 | Laravel `throttle`，以 IP 為 key，計數器存在 `CACHE_STORE=file`；webhook、health、demo 不限流 |

---

## 架構

### 1. 單體 Laravel，加上單一資料庫

| | |
|---|---|
| 替代方案 | 把訂單、庫存、付款拆成微服務，用 Saga 協調 |
| 為什麼 | 下單時「建立訂單＋扣庫存」必須在**同一個 transaction**。一旦拆成服務，就需要 Saga、補償交易、最終一致性，複雜度會大幅上升，卻沒有解決任何現有的問題 |
| 代價 | 所有模組只能一起部署、一起擴展 |
| 什麼時候改 | 團隊大到需要各自獨立部署，或某個模組的負載特性和其他模組差異很大（例如付款需要獨立的合規環境） |

### 2. PostgreSQL 16

| | |
|---|---|
| 替代方案 | MySQL 8 |
| 為什麼 | 這個設計用到三個 MySQL 沒有的功能：**partial unique index**（「同一筆訂單同時只能有一筆進行中的付款」交給資料庫保證）、**exclusion constraint**（未來的優惠期間不可重疊）、**partial index**（逾時掃描的索引只包含待付款訂單） |
| 代價 | 如果團隊比較熟悉 MySQL，維運上需要學習（vacuum、連線數）；PostgreSQL 一個連線就是一個 process，高併發時需要 PgBouncer（觸發條件與限制見 [architecture.md](./architecture.md) §一「資料庫連線數」） |
| 什麼時候改 | 公司的基礎設施只支援 MySQL。這時 partial unique index 要改成「在訂單列加鎖後，由應用程式檢查」 |

### 3. 只用資料庫，不用 Redis

| | |
|---|---|
| 替代方案 | 用 Redis 預扣庫存、分散式鎖、rate limiting（限流改用 Laravel 的 cache store，見 #41） |
| 為什麼 | 一般流量下，PostgreSQL 的 row lock 就能處理。加入 Redis 會出現**兩份庫存資料**，需要處理 Redis 和資料庫不一致的情況（Redis 扣了但資料庫交易失敗、Redis 重啟資料遺失） |
| 代價 | 同一個熱門商品的所有下單請求，都會排隊等 `inventories` 那一列的 lock |
| 什麼時候改 | **量測**之後確認瓶頸在單一熱點列，例如限時搶購。即使到那時，Redis 也只是第一道閘門，資料庫仍然是最終依據 |

### 9. 在請求內同步呼叫金流，不用 Queue

| | |
|---|---|
| 替代方案 | 發起付款時把工作丟進 Queue，由 worker 呼叫金流 |
| 為什麼 | 信用卡授權本來就是同步的，使用者也在頁面上等待結果。Mock 金流在同一個程序內執行，沒有慢速的 I/O。不用 Queue，就少一個需要維運的元件 |
| 代價 | 金流變慢時會佔住 php-fpm 的 worker。具體數字：`pm.max_children = 40`、金流逾時 10 秒，最壞情況（每次都等滿逾時）一個 app 容器每秒只能處理 **40 ÷ 10 = 4 筆付款請求**，而且其他 API 共用同一批 worker，整個網站會一起變慢。Mock 金流在程序內立即回應（逾時卡號也是立即拋出，[checkout-flow.md](./checkout-flow.md) §5.1），這次不會遇到；`request_terminate_timeout`（#37）限制單一請求最多佔住 worker 30 秒 |
| 什麼時候改 | 串接需要跳轉的金流（例如綠界的付款頁），或改成 ATM 這類非同步付款，這時付款結果主要靠 webhook，發送通知、退款等工作才需要 Queue。串接真實的同步金流、而且量測到 worker 被佔滿時，先把付款 API 放到獨立的 php-fpm pool 隔離影響，再評估 Queue |

### 10. Webhook 去重：`payment_events` 加上狀態 CAS

| | |
|---|---|
| 替代方案 | (a) 不存原始事件，只靠 `payments` 的狀態 CAS 吸收重送；(b) 對 `event_key` 加一般的 UNIQUE，驗簽失敗的事件也參與去重 |
| 為什麼 | 先存原始內容再處理，處理失敗時資料還在，可以重新處理，也留下稽核紀錄。去重分兩層：`uq_payment_events_valid` 擋下同一個事件的重送；`payments` CAS 擋下「同步回應、webhook、對帳」三條路徑之間的重複。unique 只涵蓋 `signature_valid = true`，否則攻擊者可以先送一個簽章錯誤的假事件佔住 key，讓真正的通知被當成重複而丟掉（見 [database-schema.md](./database-schema.md) §五）。交易範圍見 #38，驗簽失敗事件的欄位見 #40 |
| 代價 | 每一次 webhook 都多一次 INSERT；表會持續成長，需要定期封存 |
| 什麼時候改 | 串接真實金流、對方有自己的事件 ID 時，改用金流的事件 ID 當 `event_key`；事件量大時依時間 partition 或封存 |

### 11. 逾時與對帳：Scheduler 每分鐘掃描

| | |
|---|---|
| 替代方案 | 每筆訂單建立一個延遲任務，例如 10 分鐘後執行（需要 Queue） |
| 為什麼 | 掃描的依據是「資料庫裡的狀態」。就算 Scheduler 停止一段時間，恢復後的第一次掃描也會把漏掉的訂單補做完，不會有任務遺失的問題。搭配 partial index，掃描的成本很低。掃描條件排除「這一輪一定會跳過」的資料（有進行中付款的訂單、需要人工處理的付款），避免它們佔滿 `LIMIT` 而讓其他資料永遠輪不到（[checkout-flow.md](./checkout-flow.md) §6.2、§6.3） |
| 代價 | 庫存最晚會在到期後約 1 分鐘才釋放；訂單量很大時，每分鐘都要掃描 |
| 什麼時候改 | 需要秒級的準確度時，改用延遲任務當作主要機制，同時保留掃描當作兜底（01 題的做法） |

### 12. Mock 金流：程式內的 adapter，加上獨立的資料表

| | |
|---|---|
| 替代方案 | 另外寫一個獨立的 HTTP 服務來模擬金流 |
| 為什麼 | 程式內的 adapter 不需要多一個容器，Demo 時可以直接控制它的行為。`mock_gateway_charges` 代表金流商那一端的紀錄，所以「付款是否成功」不是由前端或我方的資料表決定，對帳也有一個獨立的資料來源可以查詢。這張表不建 Eloquent model，只由 `MockPaymentGateway` 用 query builder 存取，讓「外部系統的資料」不會混進我方的領域模型 |
| 代價 | 看不到真實的網路問題，例如連線逾時、DNS 失敗。這些情況改用測試卡號 9995 和 9987 模擬 |
| 什麼時候改 | 要測試真正的 HTTP 重試、逾時設定時，改用 WireMock 或獨立的 mock 服務 |

---

## 庫存與併發

### 4. 扣庫存：條件式原子 UPDATE

| | |
|---|---|
| 替代方案 | (a) 先 `SELECT ... FOR UPDATE` 讀出庫存，在程式裡判斷夠不夠，再 UPDATE；(b) 樂觀鎖：用 `version` 欄位，衝突時重試 |
| 為什麼 | `UPDATE ... WHERE available >= :qty` 在**一條 SQL 裡同時完成檢查和扣減**，持有鎖的時間最短，也沒有 check-then-act 的空隙。樂觀鎖在熱門商品上會一直衝突、一直重試，反而更慢 |
| 代價 | 庫存不足時只能知道「失敗了」，不知道還剩幾件。需要的話，再查詢一次即可 |
| 什麼時候改 | 扣庫存的條件複雜到一條 SQL 寫不出來（例如要跨多個倉庫分配）。這時改用 `SELECT FOR UPDATE`，並依 `product_id` 排序加鎖 |

### 5. 下單時保留庫存，付款後確認

| | |
|---|---|
| 替代方案 | 付款成功之後才扣庫存 |
| 為什麼 | 付款成功之後才扣，就可能出現「已經收了錢，卻沒有貨」的情況，只能退款，使用者體驗很差 |
| 代價 | 有人下單卻不付款時，庫存會被佔住最多 10 分鐘 |
| 什麼時候改 | 庫存非常充足的商品，不在乎被短暫佔住。這類商品其實就是 UNLIMITED，已經不會扣庫存 |

### 6. 庫存的資料結構：三個欄位加 ledger，不建 reservation 表

| | |
|---|---|
| 替代方案 | (a) 只用計數器，沒有 ledger；(b) 每次保留建立一筆 `inventory_reservations`，並設計它自己的狀態機 |
| 為什麼 | 一筆明細的庫存狀態，完全由訂單狀態決定（待付款 = reserved，已付款 = sold，已取消 = 已釋放）。另外建立 reservation 狀態機，等於把同一件事存兩份。改成用**訂單狀態 CAS** 決定要不要異動庫存，再由 **ledger 的 unique key** 當第二道保險，同樣能保證冪等，資料表也比較少。ledger 還可以用來對帳 |
| 代價 | 「這筆訂單保留了多少庫存」要從 ledger 推算，沒辦法直接查到 |
| 什麼時候改 | 庫存的保留和訂單的生命週期不再一致的時候。例如「一筆訂單分批出貨」或「保留之後可以轉給另一筆訂單」，這時保留需要有自己的狀態 |

### 7. 防止重複付款：partial unique index

| | |
|---|---|
| 替代方案 | 在應用程式裡先查詢「有沒有進行中的付款」，再決定是否建立新的付款 |
| 為什麼 | 只在應用程式裡檢查，會有 check-then-act 的空隙。partial unique index 讓資料庫**不可能**存在兩筆進行中的付款，就算之後有人寫了繞過檢查的程式碼也一樣 |
| 代價 | 需要捕捉 unique violation 例外，再把它轉換成 409 的錯誤回應 |
| 什麼時候改 | 換成不支援 partial index 的資料庫 |

### 8. 付款、取消、逾時：鎖住訂單列（`FOR UPDATE`）

| | |
|---|---|
| 替代方案 | 不加鎖，只靠狀態 CAS 與 unique index |
| 為什麼 | 只靠 CAS 擋不住這種交錯：發起付款時確認訂單還是待付款 → 取消時確認沒有進行中的付款 → 取消並釋放庫存 → 付款才建立，結果扣到款了。這是「兩個不同的資料列互相依賴」的問題，必須讓兩邊排隊（詳見 [state-machines.md](./state-machines.md) §六） |
| 代價 | 同一筆訂單的這三種操作只能依序執行。但同一筆訂單本來就很少同時發生這些操作，影響可以忽略 |
| 什麼時候改 | 幾乎不需要改。鎖的範圍只有單一訂單，不會變成熱點 |

### 26. UNLIMITED 商品不建 `inventories` 列

| | |
|---|---|
| 替代方案 | 也建立一列，`available` 設為一個很大的數字 |
| 為什麼 | 用「很大的數字」代表無限，仍然會在那一列上產生鎖競爭，而且總有一天會被扣完。不建立這一列，UNLIMITED 商品的下單交易就完全不會碰到庫存表 |
| 代價 | 想知道 UNLIMITED 商品賣了多少，要從 `order_items` 統計 |
| 什麼時候改 | 需要即時顯示 UNLIMITED 商品的銷售數字，而且查詢量很大時，另外建立一張統計表 |

---

## 狀態機

### 14. 付款直接從 `PROCESSING` 開始，不設 `CREATED`

| | |
|---|---|
| 替代方案 | 先建立 `CREATED`，送出請求前再改成 `PROCESSING` |
| 為什麼 | 在呼叫金流之前就先寫入 `PROCESSING`，少一次資料庫寫入，也少一個需要處理的狀態。萬一程式在呼叫金流之前當機，對帳時查無紀錄，就會轉成 `FAILED`，結果和有 `CREATED` 狀態時相同 |
| 代價 | 無法分辨「請求已經送出」和「還沒送出就當機了」，兩者都要靠對帳釐清 |
| 什麼時候改 | 金流需要兩個步驟，例如先建立交易、再讓使用者跳轉去付款，「已建立但尚未付款」就是一個有意義的狀態 |

### 15. 付款失敗時，繼續保留庫存，期限不延長

| | |
|---|---|
| 替代方案 | (a) 付款失敗就釋放庫存；(b) 每次重新付款都延長保留期限 |
| 為什麼 | 釋放的話，使用者換一張卡再試時可能已經沒貨了，體驗很差。延長的話，有心人可以一直用失敗的卡號付款，讓庫存永遠被佔住 |
| 代價 | 付款失敗、之後也不再付款的訂單，會佔住庫存直到 10 分鐘的期限到為止 |
| 什麼時候改 | 熱門商品，或發現有人大量下單卻不付款時，縮短期限，或限制每個訂單的失敗次數 |

### 19. 逾時用 `CANCELLED` 加上 `cancel_reason`，不另外設 `EXPIRED`

| | |
|---|---|
| 替代方案 | 另外設一個 `EXPIRED` 狀態 |
| 為什麼 | 使用者取消和逾時，在狀態機中的行為**完全相同**：都是終止狀態、都要釋放庫存、都不能再付款。差別只在原因，所以把原因記在欄位裡就好，狀態數量越少越好維護 |
| 代價 | 要查詢逾時的訂單時，要多加一個條件 `cancel_reason = 'TIMEOUT'` |
| 什麼時候改 | 兩者的後續行為開始不同的時候，例如逾時的訂單允許「恢復」，使用者主動取消的則不行 |

### 25. 只記錄訂單的狀態歷史

| | |
|---|---|
| 替代方案 | 每個狀態機都建立一張歷史表 |
| 為什麼 | 付款本身就是一筆一筆的紀錄（每次嘗試都是一筆新的資料），而且每筆付款的狀態最多只會改變兩次，`updated_at` 加上 `failure_code` 就足以說明發生了什麼事。webhook 的原始內容也已經存在 `payment_events` |
| 代價 | 看不到某筆付款從 `PROCESSING` 變成 `UNKNOWN` 的確切時間 |
| 什麼時候改 | 付款狀態變多，或者需要稽核每一次付款狀態的變化（例如處理金融爭議） |

---

## 資料

### 13. UUIDv7，不另外產生 `order_no`

| | |
|---|---|
| 替代方案 | (a) UUIDv4；(b) ULID；(c) 自增流水號；(d) 內部 id 加上給人看的 `order_no`（01 題的做法） |
| 為什麼 | 系統沒有登入機制，訂單 ID 就是查詢訂單的憑證，所以必須無法被猜到，這就排除了流水號。UUIDv7 的前 48 bits 是時間，寫入 B-tree 時是依序遞增的；UUIDv4 完全隨機，會造成頁分裂。ULID 的概念和 UUIDv7 相同，但不是 RFC 標準，PostgreSQL 也沒有原生型別。Laravel 從 12 起，`HasUuids` 預設產生的就是 v7（本專案使用 Laravel 13） |
| 代價 | 36 個字元，不方便唸給客服聽；從 ID 就看得出訂單的建立時間 |
| 什麼時候改 | 需要客服透過電話查詢訂單時，加上一個短的 `order_no`（例如 `CK-20261019-7F3K`），內部仍然使用 UUID |

### 17. 狀態欄位用 `VARCHAR` 加 `CHECK`

| | |
|---|---|
| 替代方案 | PostgreSQL 的 `ENUM` 型別 |
| 為什麼 | PostgreSQL 的 ENUM 可以新增值，但**不能刪除值，也不能重新排序**。`CHECK` 想改就能改，而且在 Laravel 的 migration 裡比較容易撰寫 |
| 代價 | 每一列多佔幾個 byte；狀態值的拼字，要在 PHP enum 和 `CHECK` 兩個地方保持一致 |
| 什麼時候改 | 資料量大到儲存空間成為問題時，改用 `SMALLINT` 加上對照表 |

### 20. Idempotency key 直接存在業務表上

| | |
|---|---|
| 替代方案 | 另外建立一張 `idempotency_keys` 表，或用 middleware 快取整個 HTTP 回應 |
| 為什麼 | key 和訂單在同一個 transaction 內寫入，**不可能出現「key 存了、訂單卻沒建立」**這種不一致。重送時直接從業務資料組出回應即可。UNIQUE 約束明確命名（`uq_orders_idempotency_key`、`uq_payments_idempotency_key`），程式只依名稱把違反轉成重送處理，不會把其他 unique 違反誤當成冪等 |
| 代價 | 每一種需要冪等的資源，都要各自加上 key 欄位 |
| 什麼時候改 | 需要冪等的 API 越來越多時，改成共用的 middleware 加上獨立的資料表，並且在同一個 transaction 內寫入 |

### 24. 不建 `refunds` 表

| | |
|---|---|
| 替代方案 | 像 01 題一樣，建立 `refunds` 表，處理晚到的付款 |
| 為什麼 | 01 題需要處理退款，是因為 ATM 這類付款可能在訂單取消**之後**才付款成功。這次只有信用卡付款，而且只要還有進行中的付款，訂單就不能被取消，所以「取消之後才付款成功」的情況不會發生 |
| 代價 | 萬一發生了（例如有人手動修改資料庫），只能標記 `needs_review_at`（#36）、記錄 CRITICAL log，交給人工處理 |
| 什麼時候改 | 加入非同步的付款方式，或需要提供退款功能時（見 [extensibility.md](./extensibility.md)） |

---

## 計價與擴充

### 21. 下單時才計價，不建 checkout session

| | |
|---|---|
| 替代方案 | 按下「去結帳」時建立 checkout session，把價格快照保存下來，下單時以快照為準（01 題的做法） |
| 為什麼 | 流程少一個步驟，也少一張表。前端帶上 `expected_total`，價格變了就回傳 `PRICE_CHANGED`，使用者不會在不知情的情況下被收取不同的金額 |
| 代價 | 限時優惠價剛好在結帳途中結束時，使用者需要重新確認價格 |
| 什麼時候改 | 結帳流程變長（需要選擇運送方式、填寫地址、輸入多組優惠碼），價格需要在整個過程中保持一致時 |

### 22. 用策略模式處理商品類型（`InventoryPolicy`）

| | |
|---|---|
| 替代方案 | 在 Action 裡寫 `if ($product->isLimited())` |
| 為什麼 | 同一個判斷會出現在 4 個地方：下單、付款成功、取消、逾時。新增「預購」類型時，策略模式只需要新增一個類別；用 `if` 則要修改 4 個地方，漏掉一個就會造成庫存錯誤 |
| 代價 | 多了一個介面、一個 resolver，以及兩個類別 |
| 什麼時候改 | 如果確定永遠只有兩種類型，`if` 其實就夠了。這裡選擇策略模式，是因為商品類型已經**明確預期會增加** |

### 23. 計價用 pipeline（`PricingRule[]`）

| | |
|---|---|
| 替代方案 | 在 `PlaceOrder` 裡直接寫 `$price * $quantity` |
| 為什麼 | 限時優惠價和促銷碼都已經確定會加入。pipeline 讓每一條規則都是一個獨立、可以單獨測試的類別；規則的執行順序（先決定成交價，再計算折扣）也明確寫在同一個地方 |
| 代價 | 目前一條規則都沒有（起點 `PriceQuote::fromListPrices()` 就是原價），pipeline 看起來像是空殼 |
| 什麼時候改 | 規則之間的互動變得很複雜時（例如「優惠價商品不能再套用促銷碼」「多組促銷碼可以疊加」），改用專門的促銷引擎 |

---

## 前端

### 16. 用輪詢取得付款結果

| | |
|---|---|
| 替代方案 | WebSocket（Laravel Reverb）或 Server-Sent Events |
| 為什麼 | 只有付款狀態是 `PROCESSING` 或 `UNKNOWN` 時才需要更新，時間通常很短。輪詢不需要額外的服務 |
| 代價 | 每 2 秒一個請求；最多延遲 2 秒才會看到結果 |
| 什麼時候改 | 有很多頁面需要即時更新（例如後台的訂單看板） |

### 18. Element Plus，不寫自訂 CSS

| | |
|---|---|
| 替代方案 | PrimeVue、Naive UI、Tailwind 手刻 |
| 為什麼 | 在台灣的 Vue 專案中最常見；`el-form`、`el-steps`、`el-result`、`el-descriptions`、`el-table` 直接就能組成結帳的各個頁面，可以把時間花在交易邏輯上 |
| 代價 | 打包後的檔案比較大（可以用按需引入改善）；客製化外觀比較受限 |
| 什麼時候改 | 需要符合品牌的設計系統 |

---

## API 與 Demo 工具

本節提到的「local」都包含 `testing`：Demo 路由與 `--force` 在 `APP_ENV` 是 `local` 或 `testing` 時啟用，讓 feature test 可以測試它們；docker 的 Demo 環境是 `local`（[checkout-flow.md](./checkout-flow.md) §9.3）。`testing` 也開放這一點**已由使用者確認（2026-10-19）**，requirements.md §四 已同步更新（[design-review.md](./design-review.md)）。

### 27. 冪等重送：依資源目前的狀態組出回應

| | |
|---|---|
| 替代方案 | 第一次處理完時，把整個 HTTP 回應（狀態碼、body）存起來，重送時原封不動回傳（Stripe 的做法） |
| 為什麼 | key 已經存在業務表上（#20），不需要另外的儲存空間；重送的目的是「拿到同一筆資源」，而資源目前的狀態比第一次的快照更有用。例如付款第一次是 `UNKNOWN`、對帳後重送，回傳 `SUCCEEDED` 才不會讓前端誤以為還在處理中。而且就算資源狀態沒有改變，`Order` 物件也包含 `server_time`（#28），兩次回應**不可能逐位元相同**，「逐位元相同」本來就不是這個 API 能提供的保證。驗收標準「回傳的結果和第一次相同」在這裡的定義是：**同一筆資源（`id` 相同）、沒有新增任何資料**，`POST /api/orders` 的狀態碼一律是 201（這個定義**已由使用者確認（2026-10-19）**，requirements.md §五 已同步更新，[design-review.md](./design-review.md)） |
| 代價 | 第一次與重送的 body 可能不同（狀態已經改變）；付款重送的狀態碼依目前狀態決定（200 或 202），測試要用 `id` 與資料筆數斷言，而不是比對整個 body |
| 什麼時候改 | 對外開放 API、呼叫端要求「逐位元相同的重送結果」時，改成 #20 提到的獨立 idempotency 表，並在同一個 transaction 內保存回應（同時要把 `server_time` 移出被保存的回應） |
| 不變量 | 不影響 INV-11 的核心（不會建立第二筆資料，同 key 不同內容仍然回 422）；不新增任何寫入路徑 |

### 28. 前端的按鈕狀態：後端提供提示欄位

| | |
|---|---|
| 替代方案 | 前端自己從 `status`、`payments[]`、`expires_at` 推算能不能付款、能不能取消 |
| 為什麼 | 「能不能付款」要同時看訂單狀態、付款截止時間、有沒有進行中的付款。這些規則寫在前端就會有兩份，改規則時容易漏改。後端在同一個地方算出 `can_pay`、`can_cancel`、`has_payment_in_progress`，並提供 `pay_deadline_at` 和 `server_time`，前端的倒數計時不受使用者電腦時鐘影響 |
| 代價 | 每次回應都要多查一次進行中的付款（已經有 `uq_payments_active` 的 index，成本很低）；欄位值在回應送出後就可能過時 |
| 什麼時候改 | 狀態規則多到前端需要顯示「為什麼不能付款」時，改成回傳原因代碼的陣列 |
| 不變量 | 這些欄位**只是提示**，不參與任何判斷。`StartPayment`、`CancelOrder` 仍然在 `FOR UPDATE` 之後重新檢查（INV-10）；前端拿著過時的值送出，只會得到 409／422 |

### 29. 付款結果的 HTTP 狀態碼：有建立付款就回 2xx

| | |
|---|---|
| 替代方案 | 付款失敗回 402 Payment Required，結果不明回 504 Gateway Timeout |
| 為什麼 | HTTP 狀態碼描述的是「這個請求有沒有被受理」。付款失敗時，付款嘗試已經建立並且有了結果（`FAILED`），請求本身是成功的；如果回 4xx，前端的錯誤處理會把它和「沒有建立付款」（409 `PAYMENT_IN_PROGRESS`）混在一起。`UNKNOWN` 和 `PROCESSING` 回 202 Accepted，語意就是「已受理、結果待定」，前端看到 202 就開始輪詢。狀態碼依處理結束後**重新讀取**的 `payment.status` 決定，不依金流的回傳值（[checkout-flow.md](./checkout-flow.md) §4.1） |
| 代價 | 前端不能只看 HTTP 狀態碼判斷付款是否成功，一定要讀 `payment.status` |
| 什麼時候改 | 串接的前端或 SDK 只能依 HTTP 狀態碼分流時 |
| 不變量 | 不影響。`UNKNOWN` 仍然阻擋重新付款與取消（INV-09）。重新讀取資料庫讓回應和 handler 實際寫入的結果一致，符合 INV-08（handler 是付款結果的唯一來源） |

### 30. Demo 的「立即執行」：同一個指令加 `--force`，只略過時間條件

| | |
|---|---|
| 替代方案 | (a) Demo API 直接修改資料，例如把 `expires_at` 改成過去的時間；(b) 另外寫一套 Demo 專用的 Action |
| 為什麼 | requirements.md §四 要求 Demo 面板和 Scheduler 執行**同一個 command**，面試時展示的才是真正會在正式環境執行的程式。`--force` 只略過時間條件：`orders:expire --force` 不看 `expires_at`；`payments:reconcile --force` 只對 `UNKNOWN` 不等待 2 分鐘。鎖、進行中付款的檢查、CAS、handler 完全相同。直接改 `expires_at` 會產生一筆不是由狀態機造成的資料修改，違反 INV-03 的精神。`UNKNOWN` 可以不等待，**只因為 Mock 金流先寫入 `mock_gateway_charges` 才拋出逾時**（[checkout-flow.md](./checkout-flow.md) §5.1），`UNKNOWN` 出現時金流端的紀錄一定已經存在；真實金流的逾時不代表請求已經不在路上，`UNKNOWN` 仍然必須等滿安全等待時間，這也是 `--force` 只能在 `local`／`testing` 使用的原因 |
| 代價 | 正式環境的指令多了一個只有 `local`／`testing` 才能用的參數；`orders:expire --force` 會取消**所有**沒有進行中付款的待付款訂單 |
| 什麼時候改 | 需要只對單一訂單觸發時，加上 `--order={id}` 參數 |
| 不變量 | 維持 INV-09：有 `PROCESSING`／`UNKNOWN` 付款的訂單仍然被跳過；`PROCESSING` 的付款仍然要等滿安全等待時間，不會把還在路上的扣款判成 `FAILED`。`APP_ENV` 不是 `local`／`testing` 時，帶 `--force` 的指令直接失敗，`/api/demo/*` 由 middleware 回 404（#34） |

### 31. Demo 的資料重設與 seed

| | |
|---|---|
| 替代方案 | (a) `migrate:fresh --seed`；(b) 只刪除訂單相關的資料，保留商品 |
| 為什麼 | `migrate:fresh` 會在請求進行中 DROP 資料表，正在執行的請求與 Scheduler 會看到「資料表不存在」的錯誤；`TRUNCATE ... RESTART IDENTITY CASCADE` 在一個 transaction 內完成，會等其他交易結束，重設後商品 ID 一定是 seed 的固定值（1、2、3），併發測試與 E2E 可以直接寫死 product ID。`CASCADE` 讓之後新增、參照這些表的資料表也一起被清除，不會因為漏列而失敗。seed 建立 LIMITED 商品時，除了寫入 `inventories`，也寫入對應數量的 ledger `RESTOCK`，INV-05 從第一筆資料就成立。「所有業務資料表」指 [database-schema.md](./database-schema.md) 列出的 9 張表（包含 `mock_gateway_charges`），**不含 Laravel 預設的表**（`users`、`password_reset_tokens`、`sessions`、`cache`、`cache_locks`、`jobs`、`job_batches`、`failed_jobs`、`migrations`）：它們依使用者的決定保留（2026-10-19），沒有業務資料，業務表也沒有外鍵參照它們，`CASCADE` 不會波及 |
| 代價 | 重設會清掉所有訂單，包含併發測試留下的結果；只能在 `local`／`testing` 執行 |
| 什麼時候改 | 多人共用同一個 Demo 環境時，改成每個人自己的資料（例如依 session 隔離） |
| 不變量 | 維持 INV-05（seed 寫 ledger）。`TRUNCATE` 不經過狀態機，但它刪除的是整份資料，不是修改狀態，而且只在 `local`／`testing` 執行。不清除 Laravel 預設表不影響任何 INV：`jobs` 表存在但沒有程式寫入（INV-01 由 T1.1 的程式碼搜尋守住） |

### 32. 前端放在 Laravel 專案內，由一次性的 `node` 容器建置

| | |
|---|---|
| 替代方案 | (a) 前端獨立成一個專案與容器（例如 Vite dev server）；(b) 在 app 的 image 裡安裝 Node |
| 為什麼 | 前端只是 4 個頁面，放在 `backend/resources/js`，用 `laravel-vite-plugin` 建置到 `public/build`，由 app 容器的 Nginx 直接提供，和 API 同一個 origin，不需要 CORS。因此 `config/cors.php` 設 `paths => []`：不對任何路徑輸出 CORS header，瀏覽器的跨來源請求一律被擋下，其他網站的頁面無法用使用者的瀏覽器呼叫 `/api`。`node` 容器執行一次 `npm ci && npm run build` 就結束（`restart: "no"`），app 不依賴它；app 的 image 不需要 Node |
| 代價 | 沒有 HMR；修改前端之後要執行 `docker compose run --rm node` 重新建置。要從其他 origin 呼叫 API（例如另一個前端專案、行動 App 的 WebView）時，必須明確設定 CORS |
| 什麼時候改 | 前端的開發量變大，需要 HMR 時，加一個只在開發時啟動的 Vite dev server（這時 CORS 的 `paths` 只對 dev server 的 origin 開放 `api/*`，不用 `*`） |
| 不變量 | 不影響 INV-01：`node` 容器不保存、不傳遞任何業務資料，建置完就結束；執行期間的服務仍然只有 `app`、`scheduler`、`postgres`。CORS 設定只影響瀏覽器能不能讀取回應，不改變任何寫入路徑 |

### 33. 付款的 `request_hash` 只用卡號末四碼計算

| | |
|---|---|
| 替代方案 | 和下單一樣，用整個 body（包含完整卡號、`exp`、`cvc`）計算 SHA-256 |
| 為什麼 | 卡號只有 13～19 位數，而且前 6 碼是公開的發卡行代碼，完整卡號的 SHA-256 可以被暴力還原。把它存進 `payments.request_hash`，等於間接存了完整卡號 |
| 代價 | 同一個 key、末四碼相同但其他位數不同的兩張卡，會被當成相同的請求，第二次回傳第一次的結果。同一個 key 只應該對應同一次點擊，實際上不會發生 |
| 什麼時候改 | 卡號改由金流的付款頁或 SDK 收集（真實環境的做法），伺服器只收到 token 時，改用 token 計算 |
| 不變量 | 補強 INV-13（完整卡號不會以任何可還原的形式寫入資料庫）；INV-11 的「同 key 不同內容回 422」在末四碼不同時仍然成立 |

### 34. Demo 路由：一律註冊，由 middleware 在請求時依環境回 404

| | |
|---|---|
| 替代方案 | 在 `routes/api.php` 用 `if (app()->environment([...]))` 決定要不要註冊 Demo 路由 |
| 為什麼 | 依環境註冊有兩個問題：(1) **難以測試**：路由在應用程式啟動時就決定了，feature test 執行時 `APP_ENV` 已經是 `testing`，要驗證「production 回 404」必須重新啟動應用程式；(2) **受 `route:cache` 影響**：路由快照是在執行 `route:cache` 的那個環境產生的，在 local 產生的快取帶到其他環境，Demo 路由就會出現。改成 `demo.only` middleware 在**每個請求**讀取 `app()->environment()`，測試內設定 `$this->app['env'] = 'production'` 再呼叫就能驗證 404，路由快取也不會改變結果。回應和不存在的路徑一樣是 404 `NOT_FOUND`，不透露端點存在。開放的環境是 `local` 與 `testing`（使用者已確認，2026-10-19） |
| 代價 | 正式環境的路由表裡看得到 `/api/demo/*`（`route:list`）；每個 Demo 請求多一次環境判斷（可以忽略） |
| 什麼時候改 | 正式環境的部署流程要求「不存在的功能完全不出現在路由表」時，把 Demo 改成獨立的 route 檔，由部署設定決定是否載入，並另外寫部署層級的測試 |
| 不變量 | 不影響任何 INV：Demo 端點執行的仍然是和 Scheduler 相同的指令；`--force` 在指令內另有環境檢查（#30），兩道防線互相獨立 |

### 35. 付款的冪等查詢：加鎖前查一次、`FOR UPDATE` 之後再查一次

| | |
|---|---|
| 替代方案 | (a) 只在加鎖前查一次 key；(b) 不先查，只靠 INSERT 違反 UNIQUE 再改為查詢 |
| 為什麼 | (a) 擋不住同 key 的併發：兩個請求都通過加鎖前的查詢，後到的拿到鎖時，先到的付款已經 COMMIT，若直接檢查訂單狀態，會得到 409 `ORDER_NOT_PAYABLE`（先到的已經成功）或 409 `PAYMENT_IN_PROGRESS`（先到的還在呼叫金流），違反 AC-I1。(b) 也不行：檢查訂單狀態與進行中付款的步驟在 INSERT 之前，後到的請求在 INSERT 之前就被 409 擋掉，根本走不到 UNIQUE。所以在 `FOR UPDATE` 之後、檢查訂單狀態之前再查一次 key。保留加鎖前的查詢，是讓一般的重送（沒有併發）不必等待訂單鎖 |
| 代價 | 付款多一次以 `uq_payments_idempotency_key` 為索引的查詢（一筆 index lookup） |
| 什麼時候改 | 改成獨立的 idempotency 表（#20 的「什麼時候改」）時，改成在 idempotency 表上以 `INSERT ... ON CONFLICT` 先佔住 key，業務檢查就不必關心 key |
| 不變量 | 補強 INV-11（同 key 併發仍然回傳同一筆資源）；鎖與檢查順序符合 INV-10（所有判斷都在 `FOR UPDATE` 之後）；不新增寫入路徑 |

### 36. handler 無法自動處理的付款：標記 `needs_review_at`，不自動終止

| | |
|---|---|
| 替代方案 | (a) 什麼都不寫，只記錄 log；(b) 新增付款狀態（例如 `NEEDS_REVIEW`）；(c) 自動終止：金額不一致就轉成 `FAILED` 並釋放訂單 |
| 為什麼 | 需要人工的情況有四種（金額不一致、終止狀態衝突、付款成功但訂單已不是待付款、同一筆訂單第二筆成功），共同點是「錢的狀態我方無法自動判斷」。(a) 只寫 log：人工只能翻 log 才發現，而且金額不一致的付款每一輪對帳都會再被掃到、再被拒絕，`updated_at` 永遠最舊、永遠排在最前面，超過 `LIMIT` 筆時其他付款永遠輪不到。(b) 新狀態：依 [state-machines.md](./state-machines.md) §一 原則 1，付款仍是 `PROCESSING`／`UNKNOWN` 時，標記之後使用者能做的操作沒有改變（付款狀態仍然準確，進行中的付款仍然擋住重付與取消），它不是狀態；加了還要修改 enum、`CHECK`、`allowedFrom()`、`uq_payments_active` 的條件（付款已經是終止狀態時的情況見「代價」）。(c) 自動終止：金額不一致時錢可能已經扣了，轉 `FAILED` 會讓使用者重付（重複扣款）或逾時釋放庫存（扣了錢沒有貨），違反 INV-09。所以用兩個欄位標記、對帳跳過、人工用 SQL 查詢工作清單 |
| 代價 | 標記後仍是 `PROCESSING`／`UNKNOWN` 的付款，會讓訂單**一直**擋住取消與逾時、佔住庫存，直到人工處理；前端會一直顯示「付款確認中」。人工處理的工具（後台、退款）不在範圍內（requirements.md §三），只能直接操作資料庫。`STATUS_CONFLICT` 的付款維持 `FAILED`，`StartPayment`、`CancelOrder`、`ExpireOrder` 不讀取標記，使用者可能已經重付成功、訂單也可能逾時釋放，需要人工退款。另外，規則是「**任何入口**比對到金額不一致就標記」：一個金額錯誤的 webhook 會讓付款被標記，對帳從此不再處理它，即使 `query()` 會回報正確的金額。接受這個結果：金流對同一筆交易回報不一致的金額，本身就是需要人工確認的異常（金流端的錯誤，或金鑰外洩後被竄改的通知），而且三個入口套用同一條規則，handler 不需要依入口分流（INV-08）。Mock 金流的金額一律取自 `payments.amount`，正常操作不會發生 |
| 什麼時候改 | 有後台時，提供「需要人工處理」的清單頁與處理動作（向金流確認後，以 actor `ADMIN` 呼叫 handler 或退款流程）；需要自動通知時，在標記的同一個 transaction 內寫入 outbox；真實金流的 webhook 金額不一致頻繁發生、而且查詢 API 可信時，改成 webhook 入口只回 `IGNORED`、不標記，讓對帳仍有機會處理。**串接真實金流時**，`StartPayment` 與 `ExpireOrder`（以及共用 `ReleaseReservedOrder` 的 `CancelOrder`）要在 `FOR UPDATE` 之後，另外檢查這筆訂單是否有**被標記的付款（不限狀態）**，有就拒絕重付、跳過逾時釋放與取消：真實金流的 `STATUS_CONFLICT` 代表錢可能已經扣了，繼續允許重付或釋放庫存會造成重複扣款或扣了錢沒有貨（INV-09）。這次不做，因為 Mock 金流的結果由 `mock_gateway_charges` 決定，`request_terminate_timeout` 與安全等待時間（#37）讓 `STATUS_CONFLICT` 在正常操作下不會發生 |
| 不變量 | 維持 INV-03（不新增狀態、終止狀態沒有出口）、INV-08（標記只由 handler 寫入）、INV-09（標記不會讓進行中的付款被當成失敗）。資料庫 `CHECK ((needs_review_at IS NULL) = (review_reason IS NULL))` 保證兩個欄位一致。「什麼時候改」的鎖內檢查放在 `FOR UPDATE` 之後，符合 INV-10 |

### 37. 卡住的付款請求：php-fpm `request_terminate_timeout` 30 秒

| | |
|---|---|
| 替代方案 | (a) 不設定（php-fpm 預設 0，不限時間）；(b) 只靠 PHP 的 `max_execution_time` |
| 為什麼 | 對帳把 `PROCESSING` 判成 `FAILED(NOT_FOUND_AT_GATEWAY)` 的前提是「超過安全等待時間（120 秒）的請求一定已經結束」。不限時間的話，一個卡住 3 分鐘的請求可能在對帳判定 `FAILED` 之後才拿到 `SUCCEEDED`：錢扣了、我方記錄失敗、使用者還能重付。`max_execution_time` 不計算等待 I/O（例如等待網路、資料庫）的時間，擋不住卡在網路上的請求；`request_terminate_timeout` 是 php-fpm master 以牆上時間強制結束 worker。30 秒大於金流逾時（10 秒），正常的逾時路徑（轉成 `UNKNOWN`）有時間完成；啟動檢查要求 `reconcile_safe_wait_seconds ≥ 2 × request_terminate_timeout`（120 ≥ 60）。php-fpm 與 `config/checkout.php` 讀同一個環境變數，檢查的就是實際生效的值 |
| 代價 | 合法但很慢的請求（例如 Demo 的 webhook 指令對 app 自己發出請求）超過 30 秒會被強制結束，回傳 502；被強制結束的付款停在 `PROCESSING`，要等對帳（最多約 3 分鐘）才有結果 |
| 什麼時候改 | 串接真實金流、金流的逾時建議值大於 30 秒時，同步調整三個值（金流逾時 < 請求逾時 ≤ 安全等待時間 ÷ 2）；擴成多台 app 時，每一台都要用同一組設定 |
| 不變量 | 補強 INV-09（對帳不會把仍在執行的請求判成失敗）。handler 在 CAS 0 列時比對狀態（[checkout-flow.md](./checkout-flow.md) §4.2）是這一層之後的偵測：真的發生時標記 `STATUS_CONFLICT`，不會被當成冪等吞掉（INV-08） |

### 38. Webhook 的交易範圍：事件 INSERT 獨立 COMMIT

| | |
|---|---|
| 替代方案 | (a) 事件 INSERT 與 handler 放在同一個 transaction；(b) 違反 unique 就一律回 `DUPLICATE` |
| 為什麼 | (a) PostgreSQL 在 transaction 內遇到 unique violation 時，整個 transaction 變成 aborted，之後的 SQL 都會失敗，「捕捉違反、讀出既有事件」做不到（要用 savepoint 才行，複雜度更高）；而且 handler 失敗時連原始事件一起 ROLLBACK，就失去「先存再處理」的意義。(b) 第一次處理到一半失敗（例如資料庫連線中斷）時，事件已經存下來但沒有處理完，金流重送會被當成重複而丟掉，只剩對帳能補救。所以事件獨立 COMMIT；違反 unique 時看既有事件的 `processed_at`：有值才回 `DUPLICATE`，NULL 就重新交給 handler（handler 的 CAS 保證不會重複生效） |
| 代價 | 同一個事件同時送達時，兩個請求都會交給 handler，都回 `PROCESSED`（其中一個在 handler 內是 `ALREADY_PROCESSED`），而不是一個 `PROCESSED`、一個 `DUPLICATE`；`payment_events` 會留下 `processed_at` 是 NULL 的事件（處理失敗、`INVALID_PAYLOAD`），需要定期檢查 |
| 什麼時候改 | 事件量大、需要非同步處理時，改成「webhook 只存事件並立即回 200，由背景程序處理 `processed_at IS NULL` 的事件」（需要 Queue 或額外的排程任務） |
| 不變量 | 維持 INV-12（先驗簽、先存原始紀錄、只對驗簽成功的事件去重）與 INV-08（重送一律交給 handler，CAS 吸收重複）。對帳是最後的保障：事件存了但永遠沒有被處理時，對帳仍然會從金流端查到結果 |

### 39. `request_hash` 的輸入：先正規化型別

| | |
|---|---|
| 替代方案 | 直接用 `$request->validated()` 計算 |
| 為什麼 | Laravel 的 `integer` 規則接受字串 `"2"`，`validated()` 原樣回傳；同一個請求分別用 `2` 和 `"2"` 送出，JSON 編碼不同，算出不同的 hash，第二次會被誤判成 422 `IDEMPOTENCY_KEY_REUSED`。同一份未轉型的輸入交給 `PlaceOrder`，`expected_total: "1600"` 和計算出的 `1600` 嚴格比較也不相等，會被誤判成 409 `PRICE_CHANGED`。所以 Form Request 輸出一份轉好型別的輸入，**hash 與 Action 使用同一份** |
| 代價 | 每個 Form Request 要明確列出欄位型別（`PlaceOrderRequest` 三個整數欄位；`StartPaymentRequest` 的欄位都是字串，hash 只用末四碼，不需要轉型） |
| 什麼時候改 | 欄位變多、型別變複雜時，改成由 DTO（`readonly` class）負責轉型，hash 以 DTO 序列化的結果計算 |
| 不變量 | 補強 INV-11（同一個請求不會因為型別表示不同而被判成不同的內容）與 INV-06（`expected_total` 只用來比對，比對的結果不受型別影響） |

### 40. 驗簽失敗的 webhook 事件：`payload`、`event_key` 驗簽前算好，`payment_id` 一律 NULL

| | |
|---|---|
| 替代方案 | (a) 驗簽之前就用 `merchant_reference` 查出 `payment_id`，驗簽失敗的事件也填入；(b) 驗簽失敗的事件不存 `payload`、`event_key`（例如填固定值） |
| 為什麼 | `payment_events.payload`、`event_key` 都是 `NOT NULL`，驗簽成功與失敗的事件都要寫入，計算方式也相同（只處理字串，不查資料庫），所以在驗簽前算好，兩條路徑共用。`payment_id` 不同：簽章錯誤代表 body 不可信，(a) 會用攻擊者控制的輸入去查詢 `payments`，還會讓偽造的事件掛在一筆真實付款底下，人工檢視某筆付款的事件時會混入假通知。所以驗簽成功之後才查詢，驗簽失敗的事件 `payment_id` 一律 NULL。(b) 會失去追查攻擊的線索：`payload` 完整保存了它聲稱的 `merchant_reference`、金額與狀態 |
| 代價 | 想找「針對某筆付款的偽造通知」時，要用 `payload->>'merchant_reference'` 查詢，不能直接用 `payment_id`（沒有索引，但驗簽失敗的事件很少，而且只在調查時查詢） |
| 什麼時候改 | 偽造通知量大到需要依付款統計時，加上 `payload->>'merchant_reference'` 的 expression index，`payment_id` 仍然維持 NULL |
| 不變量 | 補強 INV-12（先驗簽再處理，未驗簽的內容不影響任何業務資料，連查詢都不做）；不新增寫入路徑，驗簽失敗的事件仍然完整保存 |

---

## 安全與濫用防護

### 41. API 限流：Laravel `throttle`，以 IP 為 key，計數器存在 `CACHE_STORE=file`

| | |
|---|---|
| 替代方案 | (a) Redis 當 cache store（Laravel 官方建議的限流儲存）；(b) `CACHE_STORE=database`，計數器放在 PostgreSQL 的 `cache` 表；(c) Nginx 的 `limit_req`；(d) 不限流 |
| 為什麼 | (d) 不行：下單會保留庫存 10 分鐘（#5），沒有限流時一個腳本就能在幾秒內把 LIMITED 商品全部保留住；付款端點也能被拿來大量測試卡號。(a) 違反 INV-01 與 requirements.md §三、§七（不引入 Redis）。(b) 每個請求多一次資料庫寫入，而且計數器的 row 會變成熱點列，和下單交易搶同一個資料庫的連線與 I/O。(c) 要另外維護 Nginx 設定，也無法回傳 §9.2 的 JSON 錯誤格式與 `retry_after_seconds`。所以用 Laravel 內建的 `throttle` middleware 與 `RateLimiter::for()`（`checkout.place_order`、`checkout.start_payment`、`checkout.read`），計數器存在 `CACHE_STORE=file`：和 `withoutOverlapping()` 的排程鎖同一個 store，不新增任何元件。以 IP 為 key，因為系統沒有登入（requirements.md §三），沒有其他可信的身分。預設值嚴格（每分鐘 10／10／120），`.env.example`（local demo）放寬為 1000：併發測試與 E2E 會在短時間內從同一個 IP 大量呼叫 API。webhook 不限流（金流的重送不可以被擋，而且有 HMAC 驗簽，INV-12）；health 給容器的健康檢查用；demo 只在 `local`／`testing` 存在（#34） |
| 代價 | **多 worker 下會少算**：file store 的 increment 是「讀取 → 加一 → 寫回」，不是原子操作，多個 php-fpm worker 同時處理同一個 IP 的請求時，可能互相覆蓋，實際放行的請求數會略多於額度。限流只是濫用防護，不是業務規則，少量低估可以接受。**以 IP 為 key**：同一個 NAT 後面的使用者共用額度；換 IP 的攻擊者擋不住。計數器存在各容器自己的檔案系統，擴成多個 app 容器時，實際額度是「額度 × 容器數」 |
| 什麼時候改 | 擴成多個 app 容器（需要 Load Balancer，requirements.md §三 不做）時，改成 `CACHE_STORE=database`（`cache` 表已經存在，#31，仍然不需要 Redis），讓所有容器共用計數器；限流的準確度變成業務需求（例如付費 API 的額度）時，才評估 Redis，**要由使用者決定**；加入登入機制之後，下單與付款改用 user id 當 key |
| 不變量 | **不違反 INV-01**：計數器存在 Laravel 的 file cache，不使用 Redis、Queue；它不是業務資料，也不是 source of truth，計數器遺失或少算只影響放行的請求數，不影響任何業務狀態。`throttle` 排在 `idempotency` middleware 與 Actions 之前：被拒絕的請求不讀取 Idempotency-Key、不存取資料庫、不扣庫存，所以不影響 INV-02（庫存不超賣）、INV-11（key 沒有被使用，用同一個 key 重試會正常執行，[checkout-flow.md](./checkout-flow.md) §八） |
