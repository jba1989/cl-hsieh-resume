# 設計審查紀錄

> 依 `../CLAUDE.md`「Agent 審查迴圈規則」：最多 2 輪，每一輪的每一項意見都要有結果（已修改／不修改），紀錄不可以覆蓋。
> 審查方：architecture-reviewer。處理方：tech-architect。

---

## 第 1 輪

### 審查結論

REQUEST CHANGES。審查時 M1 後端已經實作完成（`backend/`），標示「阻擋 M1」的項目由 backend-engineer 依修改後的文件回頭修正（[tasks.md](./tasks.md)「M1 修正」T0.8、T1.27～T1.35）。

### 審查意見摘要

**A. 阻擋 M1 的問題**

1. UNIQUE 約束名稱和 T2.1 對不上：migration 用 inline `UNIQUE`，PostgreSQL 產生 `orders_idempotency_key_key`，T2.1 卻只認 `orders_idempotency_key_unique`。建議明確命名，payments 同理
2. 付款回應必須在 handler 結束後重新讀取資料庫，依讀到的 `payment.status` 套狀態碼表，不能用 `ChargeResult` 組回應；T2.2 重送走同一段程式
3. 付款的冪等查詢只在加鎖前做一次：同 key 併發時，後到者會得到 409 `PAYMENT_IN_PROGRESS` 或 `ORDER_NOT_PAYABLE`，違反 AC-I1。建議 `FOR UPDATE` 之後、檢查訂單狀態之前再查一次
4. Demo 路由「依環境註冊」難以測「production 回 404」，且受 `route:cache` 影響。建議改成 middleware，或寫明測試方式
5. architecture.md §二 列了 `BasePriceRule`，與 extensibility.md、T1.12 不一致；`mock_gateway_charges` 不在 model 清單，存取方式未說明
6. handler 的 payments CAS 0 列時直接結束會吞掉衝突結果（對帳判 `FAILED` 後卡住的請求才拿到 `SUCCEEDED`）。建議 CAS 0 列時讀出目前狀態、不同終止狀態時 CRITICAL log 並回傳獨立結果；php-fpm 設 `request_terminate_timeout`

**B. 其他問題（必須修改，不阻擋 M1）**

1. `payments:reconcile --force` 的理由（`UNKNOWN` 代表請求不在路上）對真實金流不成立，要改寫
2. 逾時掃描、對帳掃描可能永遠卡在同一批；補說明 handler 拒絕處理的付款如何被發現、由誰處理
3. webhook 的交易範圍未定義（事件 INSERT 是否獨立 COMMIT、未處理完的事件如何重新處理）
4. webhook 輸入驗證：`status` 只能是 `SUCCEEDED`／`FAILED`；`merchant_reference` 不是 UUID 時避免 500
5. state-machines.md §五 連動圖中 handler 有 `→ UNKNOWN` 分支，但 `UNKNOWN` 是 `StartPayment` 自己的 CAS
6. §4.2 要寫明訂單 CAS 0 列時仍 COMMIT 付款 `SUCCEEDED`、不可拋例外；`NOT_FOUND_AT_GATEWAY` 略過金額比對；§9.5 `provider_trade_no` 在 `NOT_FOUND_AT_GATEWAY` 時也是 null
7. INV-11 的驗證文字與 #27 矛盾（主 agent 已修改 skill）；刪除 #33 過時的一格
8. T4.3 的子程序繼承 `DB_DATABASE=checkout_test`，但 webhook 打的 `http://app` 使用 `checkout`
9. §3.2、§4.1、§6.3 的 SQL 寫死時間；§9.7 `RESTART IDENTITY` 與 T2.6 `RESTART IDENTITY CASCADE` 不一致
10. StartupChecks 補時間關係檢查，寫進 T1.1 驗收

**C. 補充**

1. #27 的理由補上「`Order` 含 `server_time`，不可能逐位元相同」
2. `request_hash` 先正規化型別再計算（`"2"` 與 `2`）
3. architecture.md §四 補「`charge()` 成功後、交給 handler 前當機」

**疑慮**

1. M1 很重（26 個任務），面試時要能說明切分理由
2. `App\Exceptions\DomainException` 與 PHP 內建的 `\DomainException` 同名
3. php-fpm 被同步金流呼叫佔住，#9 要補具體數字
4. `LedgerType`、`app/Support/StartupChecks.php` 已出現在實作，但不在 architecture.md §二

**架構師必須回答的問題**：見下方「問題的回答」。

### 第 1 輪處理紀錄

| # | 審查意見 | 結果 | 修改位置 / 不修改理由 |
|---|---|---|---|
| A1 | UNIQUE 約束名稱和 T2.1 對不上 | 已修改 | database-schema.md §四 `orders` DDL（`CONSTRAINT uq_orders_idempotency_key`）、§五 `payments` DDL（`uq_payments_idempotency_key`）、§六 設計重點；checkout-flow.md §八「只認明確命名的約束」；trade-offs.md #20；tasks.md T1.5、T1.7 驗收、T2.1、T2.2 範圍、新增 T1.27 |
| A2 | 付款回應要重新讀取資料庫 | 已修改 | checkout-flow.md §4.1「回應一律重新讀取資料庫」、§9.6 回應規則與 `PROCESSING` 列；architecture.md §二 `PaymentAttemptResponse`、§3.1 時序圖第 12 步；trade-offs.md #29；tasks.md T1.18 範圍與兩個新驗收、新增 T1.30。註：`StartPayment.php` 現在已經在 handler 之後重新 `findOrFail`，T1.30 是把規則寫成明文、補測試、抽出共用的組回應程式，不修改 `StartPayment` 的流程 |
| A3 | 付款冪等查詢要在加鎖後再查一次 | 已修改 | checkout-flow.md §4.1 SQL 第 0、1 步與兩段「為什麼」、§八 併發列；state-machines.md §六 表格；新增 trade-offs.md #35；tasks.md T2.2 範圍與驗收、T2.9 新增同 key 併發付款。M1 程式碼不需要改：重送處理依 tasks.md「和 requirements.md §七 的切分差異」放在 M2（T2.2），M1 本來就沒有 key 查詢 |
| A4 | Demo 路由改成 middleware 或寫明測試方式 | 已修改 | 採用 middleware：checkout-flow.md §9.2 `NOT_FOUND` 列、§9.3 Demo 專用 API 說明；architecture.md §二 `EnsureDemoEnvironment`、§四 對應列；trade-offs.md #30 不變量列、新增 #34；tasks.md T1.19 範圍與驗收（測試內設定 `$this->app['env'] = 'production'`）、新增 T1.31、T2.5～T2.6、T3.7 相依。requirements.md §四 未修改（`testing` 也開放尚待使用者決定，見下方） |
| A5 | `BasePriceRule` 不一致；`mock_gateway_charges` 存取方式未說明 | 已修改 | architecture.md §二 移除 `BasePriceRule`、補上 `PricingContext` 與起點 `PriceQuote::fromListPrices()`，並說明 `mock_gateway_charges` 沒有 model、只用 query builder；database-schema.md §五 `mock_gateway_charges` 說明；checkout-flow.md §5.1；trade-offs.md #12、#23；tasks.md T1.8（不建 model、驗收）、T1.12（不建 `BasePriceRule`）、T1.16 |
| A6 | handler CAS 0 列時會吞掉衝突；`request_terminate_timeout` | 已修改 | checkout-flow.md §4.2（CAS 0 列讀出目前狀態、`CONFLICT` 回傳值與對照表）、§二 新增請求逾時；state-machines.md §三、§五 連動圖與說明；database-schema.md §五 `needs_review_at`、`review_reason`；architecture.md §一 容器、§四 兩列；新增 trade-offs.md #36、#37；tasks.md T1.17 驗收、新增 T0.8（PE）、T1.28、T1.29。skill 的 INV-08、INV-06 文字需要同步，由主 agent 更新（見下方「需要主 agent 處理」） |
| B1 | `reconcile --force` 的理由對真實金流不成立 | 已修改 | checkout-flow.md §6.3 `--force` 段落改寫為「Mock 先寫紀錄再拋逾時，所以 `UNKNOWN` 可以立即查；真實金流的 `UNKNOWN` 仍須等滿；因此只在 local／testing」；trade-offs.md #30「為什麼」。行為不變 |
| B2 | 掃描可能永遠卡在同一批；拒絕處理的付款如何被發現 | 已修改 | checkout-flow.md §6.2（`NOT EXISTS` 排除進行中付款，鎖內仍重新檢查）、§6.3（`needs_review_at IS NULL`、`ORDER BY updated_at`）與兩段「為什麼」；§4.2「有標記的付款由誰處理」；trade-offs.md #11、#36；tasks.md T3.4、T3.5 範圍與「不會被卡住」的驗收 |
| B3 | webhook 交易範圍未定義 | 已修改 | checkout-flow.md §5.2 處理步驟 3、7 與「為什麼事件的 INSERT 要獨立 COMMIT」「兩個相同事件同時到達」；database-schema.md §五 `payment_events` 說明；新增 trade-offs.md #38；architecture.md §3.4 時序圖、§四；tasks.md T2.4 範圍與「處理中斷後重送」驗收 |
| B4 | webhook 輸入驗證 | 已修改 | checkout-flow.md §5.2「payload 的驗證規則」表格（`status ∈ {SUCCEEDED, FAILED}`，`merchant_reference` 非 UUID 視為 `UNKNOWN_PAYMENT`）、§9.2 `INVALID_PAYLOAD`、§9.6 `UNKNOWN_PAYMENT` 說明；tasks.md T2.4 驗收（`"abc"` → 200 `IGNORED`、`"PENDING"` → 400） |
| B5 | 連動圖的 `→ UNKNOWN` 分支 | 已修改 | state-machines.md §五 移除 handler 的 `→ UNKNOWN`，新增獨立入口「呼叫金流逾時（只有 StartPayment）」；§三 新增轉換表，標明 `PROCESSING → UNKNOWN` 是唯一不經過 handler 的轉換；tasks.md T3.1 驗收 |
| B6 | 訂單 CAS 0 列仍 COMMIT；`NOT_FOUND_AT_GATEWAY` 略過金額比對；`provider_trade_no` | 已修改 | checkout-flow.md §4.2 SQL 註解與「訂單 CAS 0 列時一定要 COMMIT」、§6.3 查無紀錄、§9.5 `provider_trade_no`；state-machines.md §五 連動圖；tasks.md T1.17 驗收 |
| B7 | INV-11 文字與 #27 矛盾；#33 過時的一格 | 已修改 | skill 由主 agent 修改；trade-offs.md #33「不變量」列刪除「需要同步更新 skill」的文字 |
| B8 | T4.3 子程序的資料庫錯亂 | 已修改 | tasks.md T4.3 範圍（子程序一律 `DB_DATABASE=checkout`，資料透過 API 準備）與驗收；architecture.md §一「多個 worktree 平行開發」最後一段 |
| B9 | SQL 寫死時間；`RESTART IDENTITY` 不一致 | 已修改 | checkout-flow.md 開頭的說明、§3.2、§4.1、§6.2、§6.3 SQL 註解標明 config key；§9.7 與 trade-offs.md #31、總覽統一為 `RESTART IDENTITY CASCADE`（T2.6 原本就是） |
| B10 | StartupChecks 補時間關係 | 已修改 | checkout-flow.md §二「啟動檢查」表格（四條，含 `≥ 2×` 的具體倍數）與新的 config key `request_terminate_timeout_seconds`；tasks.md T1.1 範圍與驗收、新增 T1.34 |
| C1 | #27 補 `server_time` 的理由 | 已修改 | trade-offs.md #27「為什麼」「什麼時候改」 |
| C2 | `request_hash` 先正規化型別 | 已修改 | checkout-flow.md §3.1「輸入一律先正規化型別」、§八、§9.5；新增 trade-offs.md #39；tasks.md T1.14、T2.1 驗收、新增 T1.32。這一項同時修正 M1 的實際錯誤：`PlaceOrder.php` 用 `!==` 比對 `expected_total`，字串 `"1600"` 會被誤判成 `PRICE_CHANGED` |
| C3 | architecture.md §四 補一列 | 已修改 | architecture.md §四「`charge()` 成功後、交給 handler 前，程式當機」；tasks.md T3.5 對應驗收 |
| 疑慮 1 | M1 很重，要能說明切分理由 | 已修改 | tasks.md「和 requirements.md §七 的切分差異」新增「為什麼 M1 有這麼多任務」 |
| 疑慮 2 | `DomainException` 與 `\DomainException` 同名 | 已修改 | 改名為 `ApiDomainException`：architecture.md §二；tasks.md T1.2 範圍與驗收、新增 T1.33 |
| 疑慮 3 | #9 補 php-fpm 的具體數字 | 已修改 | trade-offs.md #9「代價」（40 ÷ 10 = 每秒 4 筆）與「什麼時候改」 |
| 疑慮 4 | `LedgerType`、`StartupChecks` 不在 §二 | 已修改 | architecture.md §二 補上 `LedgerType`、`ReviewReason`、`Support/*`、`Http/Middleware/*`、`HandlingResult`、`GatewayChargeStatus`、`GatewayTimeoutException`、`ApiErrorRenderer` |
| Q1 | AC-I1 的重新解釋由誰簽核？ | 已修改 | 由使用者簽核（見下方回答）；列入「需要使用者決定」；trade-offs.md #27、tasks.md 驗收標準表標示「尚待使用者確認」。requirements.md §五 依主 agent 指示不修改 |
| Q2 | Demo 路由用註冊或 middleware？production 404 怎麼測？ | 已修改 | 同 A4 |
| Q3 | handler 拒絕處理的付款會永遠卡住嗎？人工如何發現？ | 已修改 | 同 A6、B2；新增 trade-offs.md #36（含「任何入口金額不一致就標記」的代價） |
| Q4 | 多 app 容器時連線何時用完？PgBouncer 觸發條件與 `FOR UPDATE` 的限制？ | 已修改 | architecture.md §一 新增「資料庫連線數」；trade-offs.md #2「代價」引用。不引入 PgBouncer（requirements.md §三「不做」Load Balancer、讀寫分離；目前只有一個 app 容器） |
| Q5 | `request_hash` 是否規定先正規化型別？ | 已修改 | 同 C2 |

### 問題的回答

**Q1. AC-I1 的重新解釋由誰簽核？**

由**使用者**簽核。AC-I1 是 requirements.md §五 的驗收標準，屬於產品需求，architect 只能提出解釋與理由（trade-offs.md #27），不能自行改寫；使用者同意後由 product-analyst 更新 requirements.md。在使用者回覆之前，tasks.md 與測試先依 #27 的定義（同一筆資源、`id` 相同、沒有新增資料，不比對整個 body）開發，並在驗收標準表標示「尚待使用者確認」。如果使用者要求「逐位元相同」，需要改成獨立的 idempotency 表保存回應（#27「什麼時候改」），而且 `server_time` 要移出被保存的回應；影響範圍是 T2.1、T2.2 與一張新表。

**Q2. Demo 路由用註冊還是 middleware？production 404 怎麼測？**

用 middleware（trade-offs.md #34）。路由一律註冊在 `demo.only` group 內，`EnsureDemoEnvironment` 在**每個請求**讀取 `app()->environment()`，不是 `local`／`testing` 就回 404 `NOT_FOUND`。測試方式：feature test 內設定 `$this->app['env'] = 'production'` 後呼叫 `/api/demo/state`，斷言 404 與 `error.code = NOT_FOUND`；再切回 `testing` 斷言 200。因為判斷發生在請求時，`route:cache` 產生的快照不會改變結果。`--force` 在指令內另有環境檢查，兩道防線互相獨立。

**Q3. handler 拒絕處理的付款會永遠卡住嗎？人工如何發現？**

**刻意停住，等人工處理，不設自動終止路徑**（trade-offs.md #36）。理由：金額不一致時錢可能已經扣了，自動轉 `FAILED` 會讓使用者重付（重複扣款）或讓逾時釋放庫存（扣了錢沒有貨），違反 INV-09；自動轉 `SUCCEEDED` 等於接受錯誤的金額，違反 INV-06。

做法：handler 在拒絕或發現衝突時寫入 `payments.needs_review_at` 與 `review_reason`（四種：`AMOUNT_MISMATCH`、`STATUS_CONFLICT`、`ORDER_NOT_PENDING`、`DUPLICATE_SUCCESS`），資料庫 `CHECK` 保證兩欄一致。

- **不會擋住其他資料**：對帳掃描排除有標記的付款；逾時掃描排除有進行中付款的訂單；兩者都排序（checkout-flow.md §6.2、§6.3）
- **發現方式**：`SELECT * FROM payments WHERE needs_review_at IS NOT NULL ORDER BY needs_review_at`（partial index `idx_payments_needs_review`）；同時寫 alert／CRITICAL log；Demo 頁的付款表格以紅色 tag 顯示 `review_reason`
- **代價**：標記後仍是 `PROCESSING`／`UNKNOWN` 的付款會讓訂單一直不能取消、不會逾時、佔住庫存，直到人工處理。處理工具（後台、退款）不在範圍內（requirements.md §三），人工直接操作資料庫。任何入口（包含 webhook）回報不一致的金額都會標記，對帳之後不再處理這筆付款；接受的理由見 #36。Mock 金流的金額一定取自 `payments.amount`，正常操作不會進入這個狀態

**Q4. 10 倍流量、多個 app 容器時，連線數何時用完？PgBouncer 的觸發條件與 transaction pooling 下 `FOR UPDATE` 的限制？**

見 architecture.md §一「資料庫連線數」。每個 app 容器最多 40 條（`pm.max_children`）、scheduler 約 3 條、`pest --parallel` 每個 process 1 條、保留給 superuser 3 條；`max_connections = 300` 時約 **7 個 app 容器**就會用完。

- **觸發條件**：app 容器數 × `pm.max_children` 接近 `max_connections` 時（例如擴成 6 個以上的 app 容器）。這次只有一個 app 容器，不引入；requirements.md §三 不做 Load Balancer，擴成多容器本身就需要使用者決定
- **`FOR UPDATE` 在 transaction pooling 下沒有問題**：鎖只存在於 transaction 內，transaction pooling 保證一個 transaction 使用同一條 server connection；本設計沒有 session 層級的 advisory lock，排程鎖存在檔案而不是資料庫
- **會壞的是 session 層級的狀態**：`pdo_pgsql` 預設的具名 server-side prepared statement（需要 PgBouncer 1.21 以上的 `max_prepared_statements`，或改用 `ATTR_EMULATE_PREPARES`）；Laravel 連線時執行的 `SET`（時區、`search_path`）要改成在資料庫或 role 層級設定

**Q5. `request_hash` 是否規定先正規化型別？**

是（trade-offs.md #39）。`PlaceOrderRequest` 通過驗證後輸出轉好型別的輸入（三個整數欄位轉 `int`），`request_hash` 與 `PlaceOrder` 使用**同一份**。只在 hash 正規化是不夠的：`PlaceOrder` 用 `!==` 比對 `expected_total`，字串 `"1600"` 會被誤判成 `PRICE_CHANGED`，所以這同時是 M1 的修正（tasks.md T1.32）。付款的 hash 只用末四碼字串，不需要轉型。

### 需要主 agent 處理（`docs/` 以外）

本輪的設計變更讓 `checkout-invariants` skill 的兩段文字和 docs 不一致。tech-architect 只能寫入 `docs/`，由主 agent 更新 `.claude/skills/checkout-invariants/SKILL.md`：

| INV | 欄位 | 目前的文字 | 改成 |
|---|---|---|---|
| INV-08 | 怎麼實作 | payments CAS 回傳 0 列就直接結束（冪等） | payments CAS 回傳 0 列時讀出目前狀態：和這次的結果相同才是冪等，直接結束；是另一個終止狀態時是衝突，不改狀態，標記 `needs_review_at`（`STATUS_CONFLICT`）、寫 CRITICAL log、回傳 `CONFLICT`（checkout-flow.md §4.2） |
| INV-08 | 怎麼驗證（審查） | 搜尋對 `payments` 的狀態寫入，只出現在 handler（以及 `UNKNOWN` 的 CAS） | 同左，另加：`needs_review_at`、`review_reason` 的寫入只出現在 handler |
| INV-06 | 怎麼實作 | 金流回報的金額和 `payments.amount` 不一致時，不處理該結果並記錄警報 | 同左，另加：並標記 `needs_review_at`（`AMOUNT_MISMATCH`），對帳不再掃描這筆付款 |

### 需要使用者決定的事項

「決定」欄是使用者在 2026-10-19 的回覆，第 2 輪依此同步文件（見下方第 2 輪處理紀錄 #1）。第 3 項是第 1 輪之後才提出、由使用者一併決定的事項。

| # | 事項 | 目前的做法 | 需要決定的內容 | 決定（2026-10-19） |
|---|---|---|---|---|
| 1 | AC-I1「回傳的結果和第一次相同」的解釋（trade-offs.md #27） | 依 #27：同一筆資源（`id` 相同）、沒有新增資料；付款重送的狀態碼依目前狀態（200／202），測試不比對整個 body。requirements.md §五 未修改 | 同意這個解釋（由 product-analyst 更新 requirements.md §五），或要求逐位元相同（需要新增 idempotency 表保存回應，影響 T2.1、T2.2） | **同意 #27「回傳目前狀態」的解釋**；requirements.md §五 已由 product-analyst 更新 |
| 2 | Demo 路由與 `--force` 在 `APP_ENV=testing` 也啟用 | requirements.md §四 寫「只在 local 環境開放」（未修改）；設計上 `testing` 也開放，讓 feature test 能測 Demo 端點 | 同意 `testing` 也開放（由 product-analyst 更新 requirements.md §四），或只允許 `local`（Demo 端點與 `--force` 就只能用併發測試對 docker 裡的 app 驗證，T1.19、T2.5、T2.6、T3.7 的 feature test 要改寫） | **同意 `testing` 也開放**（#30、#34）；requirements.md §四 已更新 |
| 3 | Laravel 預設的 `users`／`cache`／`jobs` migration、`User` model、`UserFactory` 要不要移除 | 原 T1.1 要求全部移除，驗收是「`migrate:fresh` 之後只有 `migrations` 表」 | 移除，或保留 | **保留**。T1.1 改成「保留預設 migration；業務表以外只有 Laravel 預設的表」，`ShouldQueue`／`dispatch(`／`Redis::` 的搜尋保留（INV-01）；`User` 不計入業務 model；`demo:reset` 不清除預設表。backend-engineer 已依此實作 |

---

## 第 2 輪

### 審查結論

**APPROVE**。第 1 輪的處理結果全部驗收通過；剩下的項目是文字同步與非阻擋的修正，不需要第 3 輪。主 agent 已更新 skill INV-11 的「怎麼實作」（先查詢、鎖後再查、UNIQUE 第二道防線、只認具名約束）。

### 審查意見摘要

**必須修改**

1. 同步使用者的三個決定（2026-10-19）：AC-I1 採 #27「回傳目前狀態」；Demo 在 `testing` 也開放（#30、#34）；保留 Laravel 預設的 `users`／`cache`／`jobs` migration、`User` model、`UserFactory`（T1.1 範圍與驗收、T1.8、T2.6／#31「所有業務資料表」的範圍）；「需要使用者決定的事項」表補上決定結果
2. checkout-flow.md §5.2 驗簽失敗的事件：把「算出 payload、event_key」移到 INSERT 之前；寫明 `signature_valid = false` 時 `payment_id` 一律為 NULL（與 database-schema.md §五一致）；T2.4 加驗收「簽章錯誤的事件 `payment_id` 是 NULL」。並回答架構師問題 1

**順手修正（非阻擋）**

3. #36「什麼時候改」補：串接真實金流時，`StartPayment` 與 `ExpireOrder` 在鎖內也要檢查訂單是否有被標記的付款；state-machines.md §三「標記之後使用者能做的操作沒有改變」註明只適用於 `PROCESSING`／`UNKNOWN`
4. tasks.md T1.20 改為使用 `DatabaseTruncation`（不用 `RefreshDatabase`），與 `backend/tests/Pest.php` 一致
5. `idx_payments_reconcile` 的 partial 條件是否加 `needs_review_at IS NULL`，由 architect 決定；若加，開一個 BE 小任務（migration 直接改原檔）
6. T3.2 的共用元件（例如 `ReleaseReservedOrder`）補進 architecture.md §二
7. 文件中 `request_terminate_timeout = ${...}s` 與實際 `docker/app/php-fpm-pool.conf`（沒有 `s`）統一為實際寫法
8. `payment_events.event_key` 統一用 `charge_id + ':' + status` 的名稱

**架構師必須回答的問題**：問題 1（驗簽失敗的事件，`payload`、`event_key`、`payment_id` 在哪一步算、怎麼填），見下方「問題的回答」。

### 第 2 輪處理紀錄

| # | 審查意見 | 結果 | 修改位置 / 不修改理由 |
|---|---|---|---|
| 1 | 同步使用者的三個決定 | 已修改 | **AC-I1**：tasks.md 驗收標準表 AC-I1 列、T2.1 範圍；trade-offs.md 總覽 #27、#27「為什麼」；checkout-flow.md §9.1「冪等重送的回應」。**`testing` 也開放**：trade-offs.md「API 與 Demo 工具」節首說明、總覽 #34、#34「為什麼」；checkout-flow.md §9.3 Demo 專用 API 說明；tasks.md T1.19。**保留 Laravel 預設表**：tasks.md T1.1 範圍與驗收（9 張業務表都存在、業務表以外只有 8 張預設表與 `migrations`；`ShouldQueue`／`dispatch(`／`Redis::`／`Cache::` 搜尋保留並註明守 INV-01）、T1.8（`User` 保留、不計入業務 model，驗收改為「8 個業務 model 以外只有 `User`」）、T2.6（不 TRUNCATE 預設表，驗收加「`users` 的資料在重設後仍然存在」）；trade-offs.md 總覽 #31、#31「為什麼」「不變量」；checkout-flow.md §9.7 `POST /api/demo/reset`；database-schema.md 開頭說明；architecture.md §二 `Models/` 與說明。**決定結果**：本文件第 1 輪「需要使用者決定的事項」表新增「決定」欄與第 3 列。不變量：保留預設表不影響任何 INV，`jobs` 表存在但 INV-01 由程式碼搜尋守住 |
| 2 | §5.2 驗簽失敗的事件 | 已修改 | checkout-flow.md §5.2 處理步驟重排為 8 步：第 1 步算出 `payload`、`event_key`（不查資料庫）→ 第 2 步驗簽，失敗時 INSERT `signature_valid = false`、`payment_id` 一律 NULL → 第 3 步驗簽成功後才查 `payment_id` → 第 4 步 INSERT；新增「為什麼驗簽失敗的事件 `payment_id` 一律是 NULL」；後文的步驟編號（第 5、7 步）同步。database-schema.md §五 `payment_events` DDL 註解、ER 圖、新增說明一條、§六 新增「偽造的 webhook 掛在真實付款底下」列。architecture.md §3.4 時序圖第 2～4 步、§四 新增「簽章錯誤（偽造）的 webhook」列。新增 trade-offs.md #40（含總覽）。tasks.md T2.4 範圍改為新順序，驗收新增「簽章錯誤、但 `merchant_reference` 是真實付款 → 401、`payment_id` 是 NULL、`event_key` 是 `charge_id:status`」與「查詢 `payments` 排在驗簽之後」的程式碼審查。不變量：補強 INV-12 |
| 3 | #36「什麼時候改」；state-machines 註明適用範圍 | 已修改 | trade-offs.md #36「什麼時候改」新增：串接真實金流時 `StartPayment`、`ExpireOrder`（與共用 `ReleaseReservedOrder` 的 `CancelOrder`）在 `FOR UPDATE` 之後檢查訂單是否有被標記的付款（不限狀態）；「為什麼」(b) 註明只適用於 `PROCESSING`／`UNKNOWN`；「代價」補「`STATUS_CONFLICT` 時三個 Action 不讀取標記」；「不變量」補 INV-10。state-machines.md §三「`needs_review_at` 不是狀態」一條註明只適用於 `PROCESSING`／`UNKNOWN`，並說明終止狀態時的已知代價 |
| 4 | T1.20 改用 `DatabaseTruncation` | 已修改 | tasks.md T1.20 範圍（理由：`RefreshDatabase` 讓 `DB::transactionLevel()` 永遠大於 0，T1.16 的守門會誤觸發，也測不到真實 COMMIT 與鎖）與驗收；INV 欄補 INV-07 |
| 5 | `idx_payments_reconcile` 是否加 `needs_review_at IS NULL` | 已修改（決定加上） | 理由：partial 條件與 §6.3 對帳掃描的 WHERE 一致，被標記、長期停在 `PROCESSING`／`UNKNOWN` 的付款不留在索引裡；人工清除標記後自動回到索引，沒有額外維護成本；不影響任何 INV。修改位置：database-schema.md §五 DDL 與註解、新增說明一條、§六 新增「對帳掃描拖慢資料庫」列；checkout-flow.md §6.3 SQL 註解；tasks.md T1.7 範圍與驗收、新增 T1.36（BE，migration 直接改原檔）、T1.26 與 T3.5 的相依加 T1.36 |
| 6 | `ReleaseReservedOrder` 補進 architecture.md §二 | 已修改 | architecture.md §一 架構圖 Actions 節點、§二 `Actions/` 一行與新增說明一條（Actions 內部的共用元件，只有一種實作，不抽介面）；tasks.md T3.2 範圍改為具名的 `App\Actions\ReleaseReservedOrder` 並引用 §二 |
| 7 | `request_terminate_timeout` 寫法與實際 conf 一致 | 已修改 | checkout-flow.md §二 config 表 `request_terminate_timeout_seconds` 列；tasks.md T0.8 範圍（改為 `${PHP_FPM_REQUEST_TERMINATE_TIMEOUT}`，不加單位）；architecture.md §一 容器表 `app` 列與 `request_terminate_timeout` 說明段。T0.8 驗收保留 `php-fpm -tt` 顯示 `30s`，並註明那是 php-fpm 傾印設定的格式，不是 conf 的寫法 |
| 8 | `event_key` 統一為 `charge_id + ':' + status` | 已修改 | database-schema.md §五 `payment_events` DDL 註解（原為 `provider_trade_no + ':' + status`）、ER 圖、新增說明一條（`charge_id` 是 webhook body 的欄位名稱，值即 `provider_trade_no`）；checkout-flow.md §5.2 原本就是這個寫法；architecture.md §3.4；tasks.md T2.4 |
| 問題 1 | 驗簽失敗事件的欄位怎麼填、在哪一步算 | 已回答 | 見下方「問題的回答」；設計變更同第 2 項 |

### 問題的回答

**問題 1. 驗簽失敗的事件，`payload`、`event_key`、`payment_id` 在哪一步算、怎麼填？**

`payload`、`event_key` 在驗簽**之前**算好；`payment_id` 在驗簽**之後**才查詢，驗簽失敗的事件一律是 NULL（checkout-flow.md §5.2 第 1～3 步、trade-offs.md #40）。

- **為什麼 `payload`、`event_key` 要先算**：兩者都是 `NOT NULL`，驗簽成功與失敗的事件都要寫入，計算方式也相同（`payload` 是解析後的 JSON 或 `{"_raw": ...}`；`event_key` 是 `charge_id + ':' + status`，欄位缺少時是 `invalid:` + raw body 的 SHA-256）。這一步只處理字串、不查資料庫，放在驗簽之前沒有安全上的顧慮，兩條路徑共用同一段程式
- **為什麼 `payment_id` 一律 NULL**：簽章錯誤代表 body 不可信。(1) 不用攻擊者控制的 `merchant_reference` 去查詢 `payments`；(2) 不讓偽造的事件掛在一筆真實付款底下，人工檢視某筆付款的事件時，看到的一定都是驗簽成功的通知。它聲稱的 `merchant_reference` 仍完整保存在 `payload`，追查攻擊時用 `payload->>'merchant_reference'` 查詢
- **與 database-schema.md 一致**：§五 `payment_events.payment_id` 的註解已經寫「驗簽失敗時一律為 NULL；驗簽成功但找不到對應付款時也是 NULL」，並新增一條說明與 §六 的一列
- **測試**：T2.4 新增鑑別案例：簽章錯誤、但 `merchant_reference` 是一筆真實存在的付款 → 401、該事件 `payment_id` 是 NULL、`event_key` 是 `charge_id:status`。只用「不存在的付款」測不出「驗簽前就查了 `payment_id`」的錯誤實作
- **不變量**：補強 INV-12（先驗簽再處理，未驗簽的內容不影響任何業務資料，連查詢都不做）；`uq_payment_events_valid` 只限 `signature_valid`，偽造事件仍然佔不住真正事件的 `event_key`

### 需要主 agent 處理（`docs/` 以外）

無新增。INV-11「怎麼實作」已由主 agent 更新；本輪的修改（#40、`idx_payments_reconcile`、`ReleaseReservedOrder`）與 skill 的現有文字沒有衝突。

### 需要使用者決定的事項

本輪無新增。第 1 輪列出的兩項與「保留 Laravel 預設 migration」已於 2026-10-19 決定，結果見第 1 輪「需要使用者決定的事項」表的「決定」欄。
