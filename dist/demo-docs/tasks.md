# 開發任務清單

> 依 [requirements.md](./requirements.md) §七「開發順序」分成里程碑。M1～M3 各對應一次 prompt，結束時可以展示對應的 Demo 情境；M0 是已完成的環境，M4 是 QA 與 E2E。
> API 合約以 [checkout-flow.md](./checkout-flow.md) §九 為準，前後端各自依合約開發。
> 設計審查第 1 輪（[design-review.md](./design-review.md)）之後：原任務的範圍與驗收條件已經依新設計更新；M1 已經實作的部分，需要回頭修改的項目列在「M1 修正」（T0.8、T1.27～T1.35）。
> 設計審查第 2 輪之後：同步使用者在 2026-10-19 的三個決定（AC-I1 的解釋、Demo 在 `testing` 也開放、保留 Laravel 預設 migration），更新 T1.1、T1.8、T1.20、T2.4、T2.6 的範圍與驗收，新增 T1.36。

## 使用方式

- **一個任務對應一個 commit**（`feat:`、`fix:`、`test:`、`chore:`、`refactor:`），完成後勾選 `- [x]`
- 里程碑內依相依順序排列；「相依」列出必須先完成的任務，沒有相依關係的任務可以平行進行
- **⚠️ 標記**：涉及交易、鎖或狀態機。開發時要先載入 `checkout-invariants` skill，審查時 code-reviewer 要逐條對照列出的 INV
- 每個里程碑結束時，由 architecture-reviewer 檢查實作是否偏離設計
- 後端任務（BE）與前端任務（FE）分開。FE 只依賴 §九 的合約，可以先用合約中的範例資料開發，再在對應的 BE 任務完成後串接驗證

| 標記 | 負責角色 |
|---|---|
| BE | backend-engineer |
| FE | frontend（由 backend-engineer 擔任；Vue 3 + Element Plus，**不寫自訂 CSS**） |
| QA | qa-engineer |
| PE | platform-engineer |

### 驗收標準編號（requirements.md §五）

| 編號 | 驗收標準 |
|---|---|
| AC-B1 | `docker compose up` 之後，就能從頭到尾完成付款 |
| AC-B2 | LIMITED 商品付款成功後：訂單是 `PAID`，`reserved` 減少數量 q，`sold` 增加數量 q |
| AC-B3 | UNLIMITED 商品付款成功後：訂單是 `PAID`，不會產生任何庫存異動 |
| AC-B4 | 第一次付款失敗、第二次付款成功：只有一筆訂單、兩筆付款紀錄，庫存只確認一次 |
| AC-O1 | 庫存不足時，下單回傳 `409 OUT_OF_STOCK` |
| AC-O2 | LIMITED 商品剩下 5 件時，同時送出 20 個購買 1 件的請求：剛好 5 筆成功，`reserved = 5`，`available = 0` |
| AC-O3 | 同時對 UNLIMITED 商品送出 20 個請求：全部成功 |
| AC-O4 | 購買數量超過 `max_quantity_per_order` 時，回傳 422 |
| AC-I1 | 用同一個 Idempotency-Key 重送下單或付款請求：不會建立第二筆資料（訂單／付款的筆數不變）；回應指向同一筆訂單／付款（回應的 `id` 與第一次相同），內容是該資源**目前**的狀態，不是第一次回應的快照（例如第一次回 `UNKNOWN`，對帳後用同一個 Key 重送會拿到 `SUCCEEDED`）。依 [trade-offs.md](./trade-offs.md) #27，測試不比對整個 body；使用者已確認（2026-10-19） |
| AC-I2 | 同一個 key 帶著不同的請求內容：回傳 422 |
| AC-I3 | 付款成功的 webhook 送兩次：庫存只變動一次，`payment_events` 只有一筆驗簽成功的紀錄 |
| AC-E1 | 使用逾時卡號時：付款是 `UNKNOWN`，不能重新付款，也不能取消訂單；對帳之後才會轉成正確的終止狀態 |
| AC-E2 | 有 `UNKNOWN` 付款的訂單即使過期，也不會被釋放；要等對帳完成後才會處理 |
| AC-E3 | 訂單到期而且沒有進行中的付款時：轉成 `CANCELLED`（`TIMEOUT`），庫存被釋放 |
| AC-E4 | 已經是終止狀態的訂單，不能再付款，也不能取消 |
| AC-E5 | 簽章錯誤的 webhook 回傳 401，並且被記錄下來 |
| AC-C1 | 任何時間點，ledger 的加總都等於 `inventories` 的三個欄位 |
| AC-C2 | 訂單的每一次狀態轉換，都有一筆 `order_status_histories` |

### 和 requirements.md §七 的切分差異

§七 把「狀態機與狀態歷史、partial unique index、Idempotency」放在 Prompt 2。本清單做了以下調整，理由都來自不變量與既有的 DDL：

| 項目 | 放在 | 理由 |
|---|---|---|
| 全部資料表的 migration（含 partial unique index、CHECK） | M1 | DDL 已經定案（[database-schema.md](./database-schema.md)），同一張表分兩次 migration 只會多出 ALTER；`orders.idempotency_key` 是 `NOT NULL`，M1 下單就必須寫入 |
| `OrderStateMachine`、`PaymentStateMachine` 與狀態歷史 | M1 | M1 的 Demo 情境 1、3 需要 `PaymentResultHandler`，而它的正確性依賴 CAS（INV-03、INV-04、INV-08）；先寫成直接 `update()` 再改，就等於在 M1 留下違反 CRITICAL 不變量的程式 |
| M1 的 Idempotency | M1 只要求 header 並寫入 key 與 `request_hash` | 重送查詢（含付款「加鎖後再查一次」）、422 `IDEMPOTENCY_KEY_REUSED`、同 key 併發，照 §七 放在 M2（T2.1、T2.2） |
| `uq_payments_active` 轉成 409 `PAYMENT_IN_PROGRESS` | M2 | M1 沒有 `UNKNOWN`，進行中的付款只會在請求處理期間短暫存在；照 §七 放在 M2（T2.3） |
| 取消訂單 | M3 | 和逾時共用同一段交易（[checkout-flow.md](./checkout-flow.md) §6.1），一起開發、一起審查 INV-09、INV-10 |

**為什麼 M1 有這麼多任務**：M1 的任務數多，是因為切分的單位是「一個 commit、一個可以獨立審查的不變量範圍」，不是工作量。M1 的 migration 拆成 4 個（依外鍵順序）、狀態機與 handler 各自獨立，讓 code-reviewer 每次只需要對照 1～3 條 INV。上表把「狀態機」「全部 DDL」提前到 M1，是因為 Demo 1、3 的正確性本來就依賴它們；延後只會讓 M1 帶著違反 CRITICAL 不變量的程式通過 Demo。M1 修正（T1.27～T1.36）也遵守同樣的粒度。

### Seed 資料

由 `DatabaseSeeder` 建立；`POST /api/demo/reset` 之後商品 ID 一定是下表的值（[trade-offs.md](./trade-offs.md) #31），併發測試與 E2E 可以直接使用。

| `id` | `name` | `inventory_policy` | `price` | `max_quantity_per_order` | 初始庫存 | 用途 |
|---|---|---|---|---|---|---|
| 1 | 限量 T 恤 | `LIMITED` | 800 | 5 | `available = 100`（ledger `RESTOCK 100`） | Demo 1、3、5、6、7；下單 2 件 = 1,600 元 |
| 2 | 簽名海報（限量 5 件） | `LIMITED` | 1200 | 2 | `available = 5`（ledger `RESTOCK 5`） | Demo 4（20 個請求搶 5 件）；搶完之後再下單即可展示 409 `OUT_OF_STOCK`（AC-O1） |
| 3 | 數位桌布包 | `UNLIMITED` | 150 | 10 | 沒有 `inventories` 列 | Demo 2；UNLIMITED 併發（AC-O3） |

- 三個商品都是 `is_active = true`；`PRODUCT_INACTIVE` 用測試的 factory 驗證，不放進 seed
- LIMITED 商品在**同一個 transaction** 內寫入 `inventories` 與 ledger `RESTOCK`，seed 完成時 INV-05 就成立

---

## M0：環境（platform-engineer）

只列驗收條件。M0 的驗收由 platform-engineer 自行確認。

- [x] **T0.1** Laravel 專案與 Pest（PE）
  - 驗收：`docker compose exec app ./vendor/bin/pest` 通過（`HealthTest`）；`GET /api/health` 回傳 `{"data":{"ok":true}}`
- [x] **T0.2** 測試資料庫隔離（PE）
  - 驗收：`backend/phpunit.xml` 的 `DB_CONNECTION`、`DB_DATABASE`、`DB_URL`、`APP_ENV` 在 `<env>` 與 `<server>` 都有 `force="true"`（[architecture.md](./architecture.md) §一）；`docker/postgres/init.sql` 建立 `checkout_test`；執行 Pest 後 `checkout` 的資料不變
- [x] **T0.3** php-fpm worker 數量（PE）
  - 驗收：`docker/app/php-fpm-pool.conf` 的 `pm.max_children = 40`；`clear_env = no`，容器內 PHP 讀得到 compose 注入的 `DB_*`、`CONCURRENCY_BASE_URL`；postgres `max_connections = 300`
- [x] **T0.4** 前端建置與 SPA 路由（PE）
  - 驗收：`node` 服務執行 `npm ci && npm run build`，輸出到 `backend/public/build`（bind mount）；`routes/web.php` 的 catch-all 讓 `/`、`/checkout`、`/orders/:id`、`/demo` 都回傳 SPA，`/api/*` 與 `/up` 不受影響；建置完成前打開頁面會看到「前端建置中」
- [x] **T0.5** 啟動流程（PE）
  - 驗收：`app` 啟動時自動 `migrate --force`；`RUN_SEED=true` 且 `products` 是空的時候執行 `db:seed`；`scheduler` 等 app migrate 完成後才執行 `schedule:work`
- [x] **T0.6** 多個 worktree 與 port（PE）
  - 驗收：`bin/worktree-env.sh` 產生 `COMPOSE_PROJECT_NAME`、`APP_PORT`、`DB_PORT`；port 只綁定 `127.0.0.1`；compose 沒有 `container_name`
- [x] **T0.7** 升級到 Laravel 13 與前端最新版（PE）
  - 範圍：`laravel/framework` 13、對應的 PHP 版本（Dockerfile）、Pest；`vue`、`vue-router`、`element-plus`、`vite`、`laravel-vite-plugin`、`@vitejs/plugin-vue` 升到最新穩定版
  - 驗收：`composer.json` 要求 `laravel/framework: ^13`；`composer install` 與 `pest` 通過；`docker compose run --rm node` 建置成功，四個頁面都能開啟；`composer.json` 沒有 `predis`、`horizon`（INV-01）
  - **M1 的所有任務都相依於 T0.7**
- [x] **T0.8** php-fpm `request_terminate_timeout`（PE）⚠️
  - 相依：T0.3
  - 範圍：`docker/app/php-fpm-pool.conf` 加上 `request_terminate_timeout = ${PHP_FPM_REQUEST_TERMINATE_TIMEOUT}`（不加單位，php-fpm 沒有單位時就是秒）；`docker-compose.yml` 的 `app` 與 `scheduler` 都注入 `PHP_FPM_REQUEST_TERMINATE_TIMEOUT`（預設 `30`），讓 `config/checkout.php` 讀到同一個值（[checkout-flow.md](./checkout-flow.md) §二、[trade-offs.md](./trade-offs.md) #37）；pool 檔的註解說明這個值必須小於對帳安全等待時間的一半
  - 驗收：容器內 `php-fpm -tt` 顯示 `request_terminate_timeout` 為 30 秒（php-fpm 傾印設定時會加上單位，顯示成 `30s`）；一個 `sleep(35)` 的測試路由（只在驗證時暫時加入，不 commit）回傳 502，而且 php-fpm log 出現 `execution timed out`；`docker compose exec app printenv PHP_FPM_REQUEST_TERMINATE_TIMEOUT` 是 `30`
  - §五：AC-E1 ／ INV：INV-09

---

## M1：下單與付款（Prompt 1，Demo 情境 1、2、3）

**里程碑驗收**：從乾淨的 volume 執行 `docker compose up`，可以在瀏覽器完成 Demo 1（LIMITED 下單 2 件、4242 付款，`/demo` 看到 `reserved → sold`）、Demo 2（UNLIMITED 下單付款，沒有庫存異動）、Demo 3（0002 失敗後 4242 成功，一筆訂單兩筆付款）。

### 後端

- [x] **T1.1** 清理骨架與建立設定檔（BE）
  - 相依：T0.7
  - 範圍：**保留** Laravel 預設的 migration（`users`、`cache`、`jobs` 三個檔案，建立 `users`、`password_reset_tokens`、`sessions`、`cache`、`cache_locks`、`jobs`、`job_batches`、`failed_jobs`）與 `User` model、`UserFactory`（使用者決定，2026-10-19；它們不屬於業務資料，見 [database-schema.md](./database-schema.md) 開頭說明）；`composer.json` 的 `dev` script 移除 `queue:listen`；新增 `config/checkout.php`（[checkout-flow.md](./checkout-flow.md) §二 的所有 key，包含 `request_terminate_timeout_seconds`）；`.env.example` 加上對應的環境變數，`MOCK_GATEWAY_WEBHOOK_SECRET` 給 local 用的值；`App\Support\StartupChecks` 執行 §二「啟動檢查」的四條
  - 驗收：`migrate:fresh` 之後，T1.4～T1.7 的 9 張業務資料表都存在，**業務表以外只有 Laravel 預設的表**（上列 8 張與 `migrations`）；`config('checkout.order_ttl_minutes') === 10`；`app/` 底下搜尋 `ShouldQueue`、`dispatch(`、`Redis::`、`Cache::` 沒有結果（INV-01：`jobs` 表存在但沒有任何程式使用 Queue，由這個搜尋守住）；`StartupChecks` 的每一條都有測試：分別把 `webhook_secret` 設成空字串、`payment_cutoff_minutes = order_ttl_minutes`、`gateway_timeout_seconds = request_terminate_timeout_seconds`、`reconcile_safe_wait_seconds = 2 × request_terminate_timeout_seconds − 1`，都會寫一筆 error log；預設值不寫任何 log
  - §五：— ／ INV：INV-01、INV-09

- [x] **T1.2** API 錯誤格式與序列化規則（BE）
  - 相依：T1.1
  - 範圍：`App\Exceptions\ApiDomainException`（`code`、HTTP status、`details`；**不使用 `DomainException` 這個名稱**，見 [architecture.md](./architecture.md) §二）與各錯誤碼的子類別；`bootstrap/app.php` 的 `withExceptions()`：`/api/*` 一律輸出 §9.2 的格式（`ValidationException` → `VALIDATION_FAILED` 的 `details.fields`、找不到路由 → `NOT_FOUND`、405 → `METHOD_NOT_ALLOWED`、其他例外 → `INTERNAL_ERROR`）；app timezone 為 UTC；時間一律用 `toIso8601ZuluString()` 輸出
  - 驗收：每一種轉換都有 feature test；`APP_DEBUG=true` 時 500 的 body 仍然不包含例外訊息與 stack trace；驗證錯誤的訊息不包含使用者輸入的值；PHP 內建的 `\DomainException` 被拋出時回 500 `INTERNAL_ERROR`（不會被當成我方的錯誤碼）
  - §五：— ／ INV：INV-13

- [x] **T1.3** 狀態與類型的 enum ⚠️（BE）
  - 相依：T1.1
  - 範圍：`OrderStatus`、`PaymentStatus`（含 `allowedFrom()`，見 [state-machines.md](./state-machines.md) §七）、`ReviewReason`、`InventoryPolicyType`、`CancelReason`、`ActorType`、`LedgerType`
  - 驗收：unit test 列舉所有「來源 × 目標」組合，只有狀態機圖上的轉換是允許的；終止狀態（`PAID`、`CANCELLED`、`SUCCEEDED`、`FAILED`）不出現在任何 `allowedFrom()` 裡；`ReviewReason` 的值和 `payments.review_reason` 的 `CHECK` 完全相同
  - §五：AC-E4 ／ INV：INV-03

- [x] **T1.4** migration：`products`、`inventories` ⚠️（BE）
  - 相依：T1.1
  - 範圍：DDL 完全依照 [database-schema.md](./database-schema.md) §三；schema builder 不支援的 `CHECK` 用 `DB::statement()`
  - 驗收：測試直接 INSERT／UPDATE 違反約束的資料都會被資料庫拒絕：`available = -1`、`reserved = -1`、`sold = -1`、`price = 0`、`max_quantity_per_order = 0`、`inventory_policy = 'X'`
  - §五：AC-O2（最後防線）／ INV：INV-02

- [x] **T1.5** migration：`orders`、`order_items`、`order_status_histories` ⚠️（BE）
  - 相依：T1.4
  - 範圍：DDL 依照 [database-schema.md](./database-schema.md) §四，包含 `CONSTRAINT uq_orders_idempotency_key UNIQUE (idempotency_key)`（**明確命名，不用 inline `UNIQUE`**）、三條狀態一致性 `CHECK`、`total_amount = subtotal - discount_amount`、`line_total` 的 `CHECK`、partial index `idx_orders_expire_sweep`
  - 驗收：測試違反約束會被拒絕：`PAID` 但 `paid_at` 是 NULL、`CANCELLED` 但沒有 `cancel_reason`、`total_amount ≠ subtotal − discount_amount`、`status = 'EXPIRED'`；重複的 `idempotency_key` 被拒絕，**而且例外中的約束名稱是 `uq_orders_idempotency_key`**；`\d orders` 看得到 `idx_orders_expire_sweep ... WHERE status = 'PENDING_PAYMENT'`
  - §五：AC-C2 ／ INV：INV-03、INV-11

- [x] **T1.6** migration：`inventory_ledger` ⚠️（BE）
  - 相依：T1.5（`order_id` 參照 `orders`，**必須排在 orders 之後**，雖然 database-schema.md 把它寫在「商品與庫存」一節）
  - 範圍：DDL 依照 [database-schema.md](./database-schema.md) §三，包含 `UNIQUE (order_id, product_id, type)`、`ADJUST` 的數量 `CHECK`
  - 驗收：同一個 `(order_id, product_id, 'CONFIRM')` 第二次 INSERT 被拒絕；`order_id IS NULL` 的 `RESTOCK` 可以有多筆；`RESERVE` 的 `quantity = 0` 被拒絕
  - §五：AC-C1 ／ INV：INV-04、INV-05

- [x] **T1.7** migration：`payments`、`payment_events`、`mock_gateway_charges` ⚠️（BE）
  - 相依：T1.5
  - 範圍：DDL 依照 [database-schema.md](./database-schema.md) §五，包含 `CONSTRAINT uq_payments_idempotency_key UNIQUE (idempotency_key)`、`needs_review_at`、`review_reason` 與兩者一致的 `CHECK`；`uq_payments_active`、`uq_payments_succeeded`、`idx_payments_reconcile`（partial 條件 `status IN ('PROCESSING', 'UNKNOWN') AND needs_review_at IS NULL`）、`idx_payments_needs_review`、`uq_payment_events_valid` 用 `DB::statement()` 建立；`mock_gateway_charges.merchant_reference` 不加外鍵
  - 驗收：同一筆訂單 INSERT 兩筆 `PROCESSING` 被拒絕；一筆 `FAILED` 加一筆 `PROCESSING` 可以；兩筆 `SUCCEEDED` 被拒絕；`SUCCEEDED` 但 `paid_at` 是 NULL 被拒絕；重複的 `idempotency_key` 被拒絕且約束名稱是 `uq_payments_idempotency_key`；只有 `needs_review_at` 沒有 `review_reason`（或反過來）被拒絕；`review_reason = 'X'` 被拒絕；兩筆 `signature_valid = true` 且 `event_key` 相同被拒絕，`signature_valid = false` 的可以重複；`idx_payments_reconcile` 的 `indexdef` 包含 `needs_review_at IS NULL`
  - §五：AC-I3 ／ INV：INV-09、INV-11、INV-12

- [x] **T1.8** Eloquent model 與 factory（BE）
  - 相依：T1.6、T1.7
  - 範圍：8 個業務 model（[architecture.md](./architecture.md) §二）；Laravel 預設的 `User` model 與 `UserFactory` **保留**（T1.1），**不計入業務 model**，也不被任何業務程式使用；**`mock_gateway_charges` 不建 model**（代表外部系統，只用 query builder）；`Order`、`Payment` 使用 `HasUuids`（UUIDv7）；狀態欄位 cast 成 enum；`$fillable` **不包含**狀態、金額與 `needs_review_at`、`review_reason`，建立紀錄時在 Actions 內用 `forceFill()` 或 query builder；factory 提供 `limited(stock)`、`unlimited()`、`inactive()` 等 state，LIMITED factory 會一起建立 `inventories` 與 ledger `RESTOCK`
  - 驗收：`Order::create(['status' => 'PAID'])` 不會寫入 status；用 factory 建立的 LIMITED 商品，對帳查詢（T1.9）結果一致；`app/Models` 沒有 `MockGatewayCharge`，除了 8 個業務 model 只有 `User`；`app/` 中 `Models/User.php` 以外沒有引用 `App\Models\User`
  - §五：— ／ INV：INV-03、INV-05、INV-06

- [x] **T1.9** Seeder 與庫存對帳查詢 ⚠️（BE）
  - 相依：T1.8
  - 範圍：`DatabaseSeeder` 依「Seed 資料」一節建立 3 個商品；`App\Inventory\InventoryReconciliation` 執行 [checkout-flow.md](./checkout-flow.md) §七 的查詢，並檢查 UNLIMITED 商品的 ledger 筆數為 0，之後的 `/api/demo/state` 與所有測試都使用它
  - 驗收：`migrate:fresh --seed` 之後 3 個商品的 ID 是 1、2、3；`InventoryReconciliation` 回報全部一致；提供 Pest helper `assertLedgerBalanced()`
  - §五：AC-C1 ／ INV：INV-05

- [x] **T1.10** 商品 API（BE）
  - 相依：T1.2、T1.9
  - 範圍：`GET /api/products`、`GET /api/products/{id}`、`ProductResource`（[checkout-flow.md](./checkout-flow.md) §9.4）
  - 驗收：回應欄位、型別與 §9.4 完全相同；UNLIMITED 的 `available` 是 `null`；`/api/products/abc` 與不存在的 ID 回 404 `PRODUCT_NOT_FOUND`；下架商品回 200、`is_active = false`
  - §五：— ／ INV：—

- [x] **T1.11** 庫存策略 `InventoryPolicy` ⚠️（BE）
  - 相依：T1.8
  - 範圍：`InventoryPolicy` 介面、`LimitedInventory`（條件式 UPDATE + ledger）、`UnlimitedInventory`（什麼都不做）、`InventoryPolicyResolver`（`reserve` 依商品目前的 `inventory_policy`；`confirm`、`release` 依明細的 `is_inventory_tracked`），見 [extensibility.md](./extensibility.md) §二
  - 驗收：`reserve` 庫存不足時丟出 `OutOfStockException`，`inventories` 與 ledger 都沒有變化；每一個方法都在同一個 transaction 內寫 `inventories` 與 ledger；在 transaction 外呼叫會丟出 `LogicException`；`app/` 搜尋 `inventories` 的寫入，沒有 `decrement()`／`increment()`，也沒有「讀出數量在 PHP 計算再寫回」
  - §五：AC-O1、AC-C1 ／ INV：INV-02、INV-04、INV-05

- [x] **T1.12** 計價 pipeline（BE）
  - 相依：T1.8
  - 範圍：`PriceCalculator`、`PricingRule` 介面、`PricingContext`、`PriceQuote`（起點 `PriceQuote::fromListPrices()`）、`QuoteLine`（[extensibility.md](./extensibility.md) §三）；規則清單目前是空陣列，在 service provider 註冊；**不建 `BasePriceRule`**（原價就是起點，不是一條規則）
  - 驗收：800 元 × 2 = `subtotal 1600`、`discount_amount 0`、`total_amount 1600`；`PriceQuote` 是 readonly，規則回傳新物件；用一個測試用的假規則證明 pipeline 依註冊順序執行
  - §五：— ／ INV：INV-06

- [x] **T1.13** 狀態機 `OrderStateMachine`、`PaymentStateMachine` ⚠️（BE）
  - 相依：T1.3、T1.8
  - 範圍：CAS（`WHERE status IN (allowedFrom)`）、回傳 `bool`；訂單轉換在同一個 transaction 內寫入 `order_status_histories`（[state-machines.md](./state-machines.md) §七）；必須在 transaction 內呼叫
  - 驗收：從終止狀態轉換回傳 `false`，而且沒有新增 history；成功的轉換剛好新增一筆 history，`from_status`、`actor_type`、`reason` 正確；在 transaction 外呼叫丟出 `LogicException`；`app/` 搜尋 `'status' =>`、`->status =`，只出現在狀態機與建立紀錄的 INSERT（Resource 的輸出陣列除外）
  - §五：AC-C2、AC-E4 ／ INV：INV-03

- [x] **T1.14** 下單：`PlaceOrder` 與 `POST /api/orders` ⚠️（BE）
  - 相依：T1.2、T1.10、T1.11、T1.12、T1.13
  - 範圍：`PlaceOrderRequest`（§9.5 的驗證規則），通過驗證後輸出**轉好型別**的輸入（[checkout-flow.md](./checkout-flow.md) §3.1），`request_hash` 與 `PlaceOrder` 使用同一份；檢查順序依 §9.5；交易內容依 §3.2（先 INSERT 訂單、明細、history，最後才 `reserve`）；寫入 `idempotency_key` 與 `request_hash`（§八）；缺少 header 回 400 `IDEMPOTENCY_KEY_REQUIRED`；回應 201 與完整的 `Order` 物件。重送處理在 T2.1
  - 驗收：LIMITED 下單後 `available −q`、`reserved +q`、ledger 一筆 `RESERVE`；UNLIMITED 下單後 `inventories` 與 ledger 都沒有變化；庫存不足 409 `OUT_OF_STOCK` 且沒有新訂單；`quantity` 超過上限 422 `QUANTITY_LIMIT_EXCEEDED`；`expected_total` 錯誤 409 `PRICE_CHANGED`、`details.total_amount` 是正確金額、沒有新訂單；`expected_total: "1600"`（字串）且金額正確時回 201，不是 `PRICE_CHANGED`；下架商品 409 `PRODUCT_INACTIVE`；body 帶 `total_amount: 1` 不會影響寫入的金額
  - §五：AC-O1、AC-O4、AC-C1、AC-C2 ／ INV：INV-02、INV-05、INV-06、INV-11

- [x] **T1.15** 查詢訂單：`GET /api/orders/{id}` 與 `OrderResource`（BE）
  - 相依：T1.14
  - 範圍：§9.5 的 `Order`、`OrderItem`、`Payment`、`StatusHistory`；計算 `pay_deadline_at`、`server_time`、`has_payment_in_progress`、`can_pay`、`can_cancel`；`payments` 新的在前、`status_histories` 舊的在前
  - 驗收：欄位、型別、排序與 §9.5 完全相同；用 `Carbon::setTestNow()` 驗證超過 `pay_deadline_at` 時 `can_pay = false`、`can_cancel = true`；`{id}` 不是 UUID 或不存在時回 404 `ORDER_NOT_FOUND`；回應不包含 `idempotency_key`、`request_hash`、`needs_review_at`、`review_reason`
  - §五：— ／ INV：INV-13

- [x] **T1.16** Mock 金流 `MockPaymentGateway` ⚠️（BE）
  - 相依：T1.7
  - 範圍：`PaymentGateway` 介面（`charge()`、`query()`）、`ChargeResult`、`MockPaymentGateway`：卡號 4242 成功、0002 `card_declined`、其他 `invalid_card`，用 query builder 寫入 `mock_gateway_charges`；同一個 `merchant_reference` 第二次 `charge()` 回傳既有紀錄。逾時卡號在 T3.1
  - 驗收：`charge()` 在 DB transaction 內被呼叫時丟出 `LogicException`（`DB::transactionLevel() > 0`），用來守住 INV-07；`query()` 查無紀錄時回傳「not found」結果（沒有金額、沒有 `charge_id`）而不是例外；`mock_gateway_charges` 只存末四碼
  - §五：AC-B2、AC-B4 ／ INV：INV-07、INV-13

- [x] **T1.17** 付款結果處理 `PaymentResultHandler` ⚠️（BE）
  - 相依：T1.11、T1.13、T1.16
  - 範圍：[checkout-flow.md](./checkout-flow.md) §4.2：金額比對 → payments CAS（0 列時讀出目前狀態，判斷冪等或衝突）→ （SUCCEEDED 時）orders CAS → history → 逐筆 `confirm` → ledger；需要人工處理的四種情況寫入 `needs_review_at`、`review_reason`（`COALESCE`，保留第一次的原因）；actor 由呼叫端傳入；回傳 `HandlingResult`（`PROCESSED`、`ALREADY_PROCESSED`、`AMOUNT_MISMATCH`、`CONFLICT`）
  - 驗收：LIMITED 成功 → `PAID`、`reserved −q`、`sold +q`、一筆 `CONFIRM`；UNLIMITED 成功 → `PAID`、沒有庫存異動；同一個結果處理兩次 → 第二次回傳 `ALREADY_PROCESSED`，ledger 仍然只有一筆 `CONFIRM`；`FAILED` → 訂單與庫存不變；**對帳的「查無紀錄」結果（沒有金額）不做金額比對**，轉成 `FAILED`／`NOT_FOUND_AT_GATEWAY`、`provider_trade_no` 是 NULL；金額不一致 → 付款狀態不變、`review_reason = AMOUNT_MISMATCH`、alert log、回傳 `AMOUNT_MISMATCH`；付款已經是 `FAILED` 時收到 `SUCCEEDED` → 付款維持 `FAILED`、`review_reason = STATUS_CONFLICT`、CRITICAL log、回傳 `CONFLICT`、訂單與庫存不變；訂單已經不是 `PENDING_PAYMENT` 時 → **不拋例外**、付款保持 `SUCCEEDED`（已 COMMIT）、`review_reason = ORDER_NOT_PENDING`、CRITICAL log；payments CAS 違反 `uq_payments_succeeded` → 這筆付款維持原狀態、`review_reason = DUPLICATE_SUCCESS`（另一個 transaction 寫入）、CRITICAL log、回傳 `CONFLICT`
  - §五：AC-B2、AC-B3、AC-B4、AC-C1、AC-C2 ／ INV：INV-03、INV-04、INV-05、INV-06、INV-08、INV-09

- [x] **T1.18** 發起付款：`StartPayment` 與 `POST /api/orders/{id}/payments` ⚠️（BE）
  - 相依：T1.15、T1.17
  - 範圍：`StartPaymentRequest`（§9.6）；交易 1：`SELECT orders FOR UPDATE` → 檢查狀態與 `pay_deadline_at` → 檢查進行中的付款 → INSERT `PROCESSING`（只存末四碼、`request_hash` 依 §八 的付款例外）→ COMMIT；COMMIT 之後才 `charge()`；結果交給 handler（actor `CUSTOMER`）；**處理結束後重新讀取 `payments` 與 `orders`**，由 `PaymentAttemptResponse` 依讀到的 `payment.status` 組出 §9.6 的回應與狀態碼（[checkout-flow.md](./checkout-flow.md) §4.1）。加鎖前、加鎖後的 key 查詢在 T2.2，`uq_payments_active` 違反的轉換在 T2.3
  - 驗收：4242 → 200、`SUCCEEDED`、訂單 `PAID`；0002 → 200、`FAILED`、`failure_code = card_declined`、訂單仍是 `PENDING_PAYMENT`、`can_pay = true`；`PAID` 的訂單再付款 → 409 `ORDER_NOT_PAYABLE`；超過 `pay_deadline_at` → 422 `ORDER_EXPIRING`；**用假的 gateway 回報不一致的金額 → 202、`payment.status = PROCESSING`**；**用假的 gateway 在 `charge()` 內先以 actor `WEBHOOK` 呼叫 handler（模擬 webhook 搶先）再回傳 `SUCCEEDED` → 200、`SUCCEEDED`、只有一筆 `CONFIRM`、history 的 actor 是 `WEBHOOK`**；付款後在資料庫（`payments`、`mock_gateway_charges`）與 `storage/logs` 都找不到完整卡號、`exp`、`cvc`；`DB::transaction` 的 closure 內沒有呼叫 gateway；`PaymentController` 沒有依 `ChargeResult` 或 `HandlingResult` 決定狀態碼
  - §五：AC-B2、AC-B3、AC-B4、AC-E4 ／ INV：INV-06、INV-07、INV-08、INV-10、INV-13

- [x] **T1.19** Demo 狀態：`GET /api/demo/state`（BE）
  - 相依：T1.9、T1.15
  - 範圍：`DemoController@state`、`DemoStateResource`（§9.7，`recent_payments` 包含 `review_reason`）；Demo 路由**一律註冊**，套用 `demo.only` middleware（`EnsureDemoEnvironment`，在請求時檢查 `APP_ENV` 是 `local` 或 `testing`，否則 404 `NOT_FOUND`，[trade-offs.md](./trade-offs.md) #34；`testing` 也開放已由使用者確認，2026-10-19）
  - 驗收：欄位與 §9.7 完全相同；UNLIMITED 商品的 `inventory`、`ledger` 是 `null`、`ledger_entry_count = 0`；測試內設定 `$this->app['env'] = 'production'` 後呼叫 → 404 `NOT_FOUND`，`local` 與 `testing` → 200；`routes/api.php` 沒有依環境決定是否註冊路由的 `if`
  - §五：AC-C1 ／ INV：INV-04、INV-05

- [x] **T1.20** M1 流程測試（BE）
  - 相依：T1.18、T1.19
  - 範圍：用 HTTP feature test 走完 Demo 1、2、3。使用 `DatabaseTruncation`（`backend/tests/Pest.php` 已對所有 Feature test 套用），**不使用 `RefreshDatabase`**：`RefreshDatabase` 把每個測試包在一個 transaction 裡，`DB::transactionLevel()` 永遠大於 0，T1.16 的「`charge()` 在 transaction 內呼叫就丟出 `LogicException`」會在每一次付款時誤觸發，也測不到真實的 COMMIT 與鎖（INV-07）
  - 驗收：每個情境結束都呼叫 `assertLedgerBalanced()`，並斷言 history 的筆數等於轉換次數；Demo 3 結束時一筆訂單、兩筆付款、一筆 `CONFIRM`；`tests/` 底下搜尋 `RefreshDatabase` 只出現在說明為什麼不用它的註解
  - §五：AC-B2、AC-B3、AC-B4、AC-C1、AC-C2 ／ INV：INV-04、INV-05、INV-07、INV-08

### 前端

- [x] **T1.21** API client 與共用工具（FE）
  - 相依：T0.7（只依賴 §九 合約）
  - 範圍：`api/client.js`：成功時回傳 `data`；失敗時統一轉成 `{ status, code, message, details }`，沒有回應（網路錯誤）時 `code = 'NETWORK_ERROR'`；`newIdempotencyKey()`（`crypto.randomUUID()`；app 只綁定 localhost，屬於 secure context）；金額格式化（`Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 })`）；時間格式化（UTC 字串轉成當地時間）
  - 驗收：錯誤一律用 `ElMessage` 顯示 `message`；沒有 `console.log`；沒有自訂 CSS
  - §五：— ／ INV：—

- [x] **T1.22** 首頁 `/`（FE）
  - 相依：T1.21；串接驗證相依 T1.10
  - 範圍：`el-input` 輸入 Product ID 後前往 `/checkout?product_id=`；`el-table` 列出所有商品（名稱、價格、類型 `el-tag`、可賣數量，UNLIMITED 顯示「不限量」、單筆上限、是否上架），每一列有「結帳」按鈕
  - 驗收：輸入不是正整數時按鈕停用；下架商品的「結帳」按鈕停用
  - §五：AC-B1 ／ INV：—

- [x] **T1.23** 結帳頁 `/checkout`（FE）
  - 相依：T1.21；串接驗證相依 T1.14
  - 範圍：`el-descriptions` 顯示商品；`el-input-number` 選數量（最小 1，最大 `min(max_quantity_per_order, available ?? max_quantity_per_order)`）；`el-form` 填姓名、Email（前端驗證規則和 §9.5 相同）；顯示應付金額 = `price × quantity`，並以它作為 `expected_total`；**進入頁面時產生一次** Idempotency-Key，下單成功後就不再使用；送出時按鈕顯示 loading 並停用；成功後前往 `/orders/:id`
  - 驗收：商品不存在顯示 `el-result`；`OUT_OF_STOCK` → 提示並重新載入商品；`PRICE_CHANGED` → 用 `ElMessageBox` 顯示 `details.total_amount`，重新載入商品後讓使用者再確認；`QUANTITY_LIMIT_EXCEEDED`、`PRODUCT_INACTIVE` 顯示訊息；`VALIDATION_FAILED` 把 `details.fields` 顯示在對應欄位
  - §五：AC-B1、AC-O1、AC-O4 ／ INV：INV-06、INV-11

- [x] **T1.24** 訂單頁 `/orders/:id`（FE）
  - 相依：T1.21；串接驗證相依 T1.18
  - 範圍：`el-steps`（下單 → 付款 → 完成；`CANCELLED` 時付款步驟顯示 error 狀態）；倒數計時以 `pay_deadline_at − server_time` 計算；付款表單（卡號、`exp`、`cvc`），用 `el-alert` 列出測試卡號；**每次按下付款都產生新的** Idempotency-Key；依 §9.6 的表格處理 `SUCCEEDED`／`FAILED`／`UNKNOWN`／`PROCESSING`；付款紀錄 `el-table`（末四碼、狀態、`failure_code`、時間）；狀態歷史 `el-timeline`（`actor_type`、`reason`）；`has_payment_in_progress = true` 時每 2 秒輪詢，變成 `false` 或離開頁面時停止；付款按鈕只在 `can_pay = true` 時可以按
  - 驗收：0002 失敗後顯示原因並可以重新付款，再用 4242 成功，頁面顯示兩筆付款；`ORDER_NOT_PAYABLE`、`ORDER_EXPIRING` 顯示訊息並重新載入訂單；卡號送出前移除空白；畫面上只出現末四碼
  - §五：AC-B1、AC-B4 ／ INV：INV-11、INV-13

- [x] **T1.25** Demo 頁 `/demo`：狀態顯示（FE）
  - 相依：T1.21；串接驗證相依 T1.19
  - 範圍：商品表格（`inventory` 與 `ledger` 的三個欄位並排，`is_consistent` 用 `el-tag` 顯示）；`all_consistent` 用 `el-alert`；最近的訂單、付款、webhook 紀錄三個表格，訂單 ID 連到 `/orders/:id`；付款表格有「需要人工處理」欄，`review_reason` 不是 null 時用 `el-tag type="danger"` 顯示原因；「重新整理」按鈕。操作按鈕在 T2.11、T3.10
  - 驗收：Demo 1 付款後重新整理，看得到 `reserved → sold`；API 回 404 時顯示 `el-result`「只在 local 環境開放」
  - §五：AC-C1 ／ INV：—

- [x] **T1.26** M1 Demo 驗收（QA）
  - 相依：T1.20、T1.22～T1.25、T1.27～T1.36
  - 範圍：`docker compose down -v && docker compose up`，在瀏覽器手動走完 Demo 1、2、3
  - 驗收：三個情境都能完成；`/demo` 的 `all_consistent = true`
  - §五：AC-B1～AC-B4 ／ INV：—

### M1 修正（設計審查第 1 輪）

M1 已經依審查前的文件實作。以下任務把已實作的程式改成符合目前的文件；上面的原任務驗收條件已經同步更新，完成修正後原任務的驗收也要全部通過。`backend/` 尚未部署、也還沒有任何正式資料，**migration 直接修改原檔**，不新增 ALTER migration；修改後本機要執行 `docker compose exec app php artisan migrate:fresh --seed`（或 `docker compose down -v`）。

- [x] **T1.27** 明確命名 Idempotency-Key 的 UNIQUE 約束 ⚠️（BE）
  - 相依：T1.5、T1.7
  - 審查意見：A1
  - 範圍：`database/migrations/2026_10_19_000002_create_orders_tables.php` 的 `idempotency_key VARCHAR(64) NOT NULL UNIQUE` 改成欄位 `NOT NULL` 加上表格層級的 `CONSTRAINT uq_orders_idempotency_key UNIQUE (idempotency_key)`；`2026_10_19_000004_create_payments_tables.php` 同樣改成 `CONSTRAINT uq_payments_idempotency_key UNIQUE (idempotency_key)`；其他 UNIQUE 不改（[database-schema.md](./database-schema.md) §五）；`tests/Feature/Schema/*SchemaTest.php` 補上約束名稱的斷言
  - 驗收：`SELECT conname FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'u'` 包含 `uq_orders_idempotency_key`、不包含 `orders_idempotency_key_key`；`payments` 同理；重複 INSERT 的 `QueryException` 訊息包含約束名稱
  - §五：AC-I1 ／ INV：INV-11

- [x] **T1.28** `payments` 加上需要人工處理的標記 ⚠️（BE）
  - 相依：T1.27
  - 審查意見：A6、B2、Q3
  - 範圍：`2026_10_19_000004_create_payments_tables.php` 加上 `needs_review_at TIMESTAMPTZ`、`review_reason VARCHAR(30) CHECK (...)`、`CHECK ((needs_review_at IS NULL) = (review_reason IS NULL))`、`idx_payments_needs_review`；新增 `App\Enums\ReviewReason`；`Payment` model 的 cast（`review_reason` → `ReviewReason`），不放進 `$fillable`；`PaymentsSchemaTest` 補上 T1.7 新增的驗收
  - 驗收：T1.7 驗收中與 `needs_review_at`、`review_reason` 有關的項目通過；`EnumTransitionTest`（或新的 unit test）斷言 `ReviewReason` 的值和 `CHECK` 一致
  - §五：— ／ INV：INV-03、INV-08

- [x] **T1.29** `PaymentResultHandler`：CAS 0 列判斷冪等或衝突，寫入人工處理標記 ⚠️（BE）
  - 相依：T1.28
  - 審查意見：A6、B6、Q3
  - 範圍：`app/Payments/PaymentResultHandler.php`：(1) 金額不一致時在 handler 的 transaction 內寫入 `AMOUNT_MISMATCH` 標記（目前只寫 log 就 return）；(2) payments CAS 回傳 `false` 時 `SELECT status`，和目標相同才回傳 `AlreadyProcessed`，不同時寫入 `STATUS_CONFLICT`、`Log::critical`、回傳新的 `HandlingResult::Conflict`（目前一律 `AlreadyProcessed`）；(3) 訂單 CAS 0 列時寫入 `ORDER_NOT_PENDING`，維持「不拋例外、COMMIT」；(4) 捕捉違反 `uq_payments_succeeded`（依約束名稱判斷）：讓原 transaction ROLLBACK，之後另開一個 transaction 寫入 `DUPLICATE_SUCCESS`、`Log::critical`、回傳 `Conflict`；標記一律 `COALESCE`。`app/Payments/HandlingResult.php` 加上 `Conflict = 'CONFLICT'`。寫入標記的 UPDATE 放在 handler 內的私有方法，不放進 `PaymentStateMachine`（不是狀態轉換）
  - 驗收：T1.17 驗收全部通過（`tests/Feature/PaymentResultHandlerTest.php` 補上 `STATUS_CONFLICT`、`ORDER_NOT_PENDING`、`DUPLICATE_SUCCESS`、`AMOUNT_MISMATCH` 標記、查無紀錄不比對金額的案例）；`app/` 搜尋 `needs_review_at` 的寫入只出現在 `PaymentResultHandler`
  - §五：AC-B2、AC-C1 ／ INV：INV-03、INV-04、INV-08、INV-09

- [x] **T1.30** 付款回應一律重新讀取資料庫 ⚠️（BE）
  - 相依：T1.29
  - 審查意見：A2
  - 範圍：新增 `app/Http/Resources/PaymentAttemptResponse.php`：輸入**重新讀取**的 `Payment` 與 `Order`，輸出 §9.6 的 body 與 200／202（依 `payment.status`）；`app/Http/Controllers/Api/PaymentController.php` 改用它（目前的 `in_array(...) ? 200 : 202` 移進去）。`app/Actions/StartPayment.php` 目前已經在 handler 之後重新 `findOrFail`，**不修改它的流程**，只在方法註解寫明「回應不可以使用 `ChargeResult`」。T2.2 的冪等重送沿用 `PaymentAttemptResponse`
  - 驗收：T1.18 新增的兩個驗收（金額不一致 → 202 `PROCESSING`；webhook 搶先 → 200 `SUCCEEDED`、一筆 `CONFIRM`）通過；`PaymentAttemptResponse` 有 unit test 覆蓋四種 `payment.status` 的狀態碼
  - §五：AC-B2、AC-I1 ／ INV：INV-08

- [x] **T1.31** Demo 路由改用 `demo.only` middleware（BE）
  - 相依：T1.19
  - 審查意見：A4
  - 範圍：新增 `app/Http/Middleware/EnsureDemoEnvironment.php`（不是 `local`／`testing` 時丟出 `NotFoundHttpException`，交給 T1.2 的 renderer 輸出 404 `NOT_FOUND`）並在 `bootstrap/app.php` 註冊別名 `demo.only`；`routes/api.php` 移除 `if (app()->environment([...]))`，改成 `Route::prefix('demo')->middleware('demo.only')->group(...)`
  - 驗收：feature test：設定 `$this->app['env'] = 'production'` 後呼叫 `/api/demo/state` → 404、`error.code = NOT_FOUND`；`testing` → 200。程式碼審查：`routes/api.php` 沒有依環境的 `if`，環境判斷只出現在 `EnsureDemoEnvironment`（不受 `route:cache` 影響是這個結構的推論，見 [trade-offs.md](./trade-offs.md) #34，不另外測試）
  - §五：— ／ INV：—

- [x] **T1.32** 輸入型別正規化，hash 與 Action 共用 ⚠️（BE）
  - 相依：T1.14
  - 審查意見：C2、Q5
  - 範圍：`app/Http/Requests/PlaceOrderRequest.php` 新增 `input(): array`（或 `toPlaceOrderInput()`），把 `product_id`、`quantity`、`expected_total` 轉成 `int`；`app/Http/Controllers/Api/OrderController.php` 用它計算 `RequestHash::make()`，也把**同一份**陣列傳給 `PlaceOrder::handle()`；`app/Support/RequestHash.php` 的註解寫明「輸入必須已經轉好型別」
  - 驗收：feature test：同一個 body 分別以整數與字串（`"quantity": "2"`、`"expected_total": "1600"`）送出（不同的 key），資料庫中兩筆訂單的 `request_hash` 相同；T1.14 新增的 `expected_total: "1600"` 驗收通過
  - §五：AC-I1、AC-I2 ／ INV：INV-06、INV-11

- [x] **T1.33** `DomainException` 改名為 `ApiDomainException`（BE）
  - 相依：T1.2
  - 審查意見：疑慮 2
  - 範圍：`app/Exceptions/DomainException.php` 改名為 `ApiDomainException.php`，所有子類別（`app/Exceptions/*Exception.php`）與 `ApiErrorRenderer`、`bootstrap/app.php` 的引用一起改；`refactor:` commit
  - 驗收：`app/` 搜尋 `extends DomainException`、`App\Exceptions\DomainException` 沒有結果；T1.2 新增的「`\DomainException` 回 500」測試通過；全部測試通過
  - §五：— ／ INV：—

- [x] **T1.34** 啟動檢查補上時間關係（BE）
  - 相依：T1.1、T0.8
  - 審查意見：B10
  - 範圍：`config/checkout.php` 加上 `request_terminate_timeout_seconds`（讀 `PHP_FPM_REQUEST_TERMINATE_TIMEOUT`，預設 30）；`app/Support/StartupChecks.php` 補上 `gateway_timeout_seconds < request_terminate_timeout_seconds`、`reconcile_safe_wait_seconds ≥ 2 × request_terminate_timeout_seconds` 兩條；`.env.example` 加上 `PHP_FPM_REQUEST_TERMINATE_TIMEOUT=30`
  - 驗收：T1.1 的 `StartupChecks` 驗收通過
  - §五：AC-E1 ／ INV：INV-09

- [x] **T1.35** Demo 頁顯示需要人工處理的付款（FE）
  - 相依：T1.25、T1.28
  - 審查意見：Q3
  - 範圍：依 T1.25 更新後的範圍，在最近的付款表格加上 `review_reason` 欄
  - 驗收：用 tinker 對一筆付款寫入 `review_reason = 'AMOUNT_MISMATCH'`（同時寫 `needs_review_at`）後重新整理，該列顯示紅色 tag；沒有自訂 CSS
  - §五：— ／ INV：—

### M1 修正（設計審查第 2 輪）

規則同上一節（migration 直接修改原檔，修改後 `migrate:fresh --seed`）。

- [x] **T1.36** `idx_payments_reconcile` 的 partial 條件加上 `needs_review_at IS NULL` ⚠️（BE）
  - 相依：T1.28
  - 審查意見：第 2 輪 #5
  - 範圍：`database/migrations/2026_10_19_000004_create_payments_tables.php` 的 `idx_payments_reconcile` 改成 `ON payments (updated_at) WHERE status IN ('PROCESSING', 'UNKNOWN') AND needs_review_at IS NULL`（[database-schema.md](./database-schema.md) §五），和對帳掃描的 WHERE（[checkout-flow.md](./checkout-flow.md) §6.3）一致；`PaymentsSchemaTest` 補上斷言
  - 驗收：`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_payments_reconcile'` 包含 `needs_review_at IS NULL`；T1.7 的其他驗收不受影響、全部測試通過
  - §五：AC-E1 ／ INV：INV-09

---

## M2：冪等、webhook、併發（Prompt 2，Demo 情境 4、6）

**里程碑驗收**：執行 `docker compose exec app ./vendor/bin/pest --group=concurrency --filter=oversell` 後，`/demo` 顯示商品 2 `available = 0`、`reserved = 5`（Demo 4）；在 `/demo` 對同一筆付款依序按兩次「送出 webhook」，第二次顯示 `HTTP 200 DUPLICATE`，庫存不變（Demo 6）。

### 後端

- [x] **T2.1** 下單的冪等重送 ⚠️（BE）
  - 相依：T1.14、T1.27、T1.32
  - 範圍：[checkout-flow.md](./checkout-flow.md) §3.1 第 0 步：先用 key 查詢，存在時比對 `request_hash`；交易內 INSERT 違反 `uq_orders_idempotency_key` 時（**只認這個約束名稱**，其他 unique 違反照常拋出）ROLLBACK 後改為查詢；重送回 201、同一筆訂單、加上 `Idempotent-Replayed: true`（[trade-offs.md](./trade-offs.md) #27，使用者已確認這個解釋，2026-10-19）
  - 驗收：同一個 key 同內容送兩次 → 兩個 201、`id` 相同、只有一筆訂單、ledger 只有一筆 `RESERVE`；同一個 key 不同 `quantity` → 422 `IDEMPOTENCY_KEY_REUSED`；同一個 key、`quantity` 分別是 `2` 與 `"2"` → 第二次是重送（201），不是 422；第一次因缺貨失敗後，用同一個 key 重試會重新執行；價格改變後重送已成功的請求，仍然回 201 而不是 `PRICE_CHANGED`
  - §五：AC-I1、AC-I2 ／ INV：INV-11

- [x] **T2.2** 付款的冪等重送 ⚠️（BE）
  - 相依：T1.18、T1.27、T1.30
  - 範圍：[checkout-flow.md](./checkout-flow.md) §4.1：**加鎖前**用 key 查詢付款一次；`FOR UPDATE` 之後、檢查訂單狀態**之前**再查一次；INSERT 違反 `uq_payments_idempotency_key` 時 ROLLBACK 後改為查詢（只認這個約束名稱）。三個位置找到既有付款時的處理相同：`request_hash` 相同 → 重送，不同 → 422。`request_hash` 依 §八 的付款例外（末四碼，不含 `exp`、`cvc`）。重送依付款**目前的** `status` 回 200 或 202，用 `PaymentAttemptResponse` 組回應（與第一次請求同一段程式），加上 `Idempotent-Replayed: true`
  - 驗收：4242 成功後用同一個 key 重送 → 200、同一筆付款、沒有第二次 `charge()`（`mock_gateway_charges` 只有一筆）；同一個 key 換一個末四碼不同的卡號 → 422；同一個 key 送到另一筆訂單的路徑 → 422；`payments.request_hash` 不等於用完整卡號計算出的 hash；程式碼審查：`StartPayment` 在 `lockForUpdate()` 之後的第一個檢查就是 key 查詢，排在訂單狀態、期限、進行中付款的檢查之前（§4.1 第 1 步）。同 key 真正併發時的行為（兩個回應都是 2xx、同一筆付款）由 T2.9 驗證
  - §五：AC-I1、AC-I2 ／ INV：INV-10、INV-11、INV-13

- [x] **T2.3** 進行中付款的阻擋與狀態歷史完整性 ⚠️（BE）
  - 相依：T1.18
  - 範圍：INSERT 付款違反 `uq_payments_active` → ROLLBACK、回 409 `PAYMENT_IN_PROGRESS`，不呼叫 gateway；補齊「每一次轉換都有 history」的測試
  - 驗收：先用測試資料建立一筆 `PROCESSING` 付款，再發起付款 → 409 `PAYMENT_IN_PROGRESS`，`mock_gateway_charges` 沒有新紀錄；`CANCELLED` 的訂單付款 → 409 `ORDER_NOT_PAYABLE`；M1 的三個流程測試都斷言 history 的 `from_status → to_status` 序列完全正確
  - §五：AC-E4、AC-C2 ／ INV：INV-03、INV-09、INV-10

- [x] **T2.4** Webhook：`POST /api/webhooks/payments` ⚠️（BE）
  - 相依：T1.17、T1.29
  - 範圍：[checkout-flow.md](./checkout-flow.md) §5.2 的驗證規則與步驟：解析 raw body，算出 `payload` 與 `event_key`（`charge_id + ':' + status`，不查詢資料庫）→ `hash_equals` 驗證 HMAC，失敗時 INSERT `signature_valid = false`、**`payment_id` 一律 NULL** 的事件並回 401（[trade-offs.md](./trade-offs.md) #40）→ 驗簽成功後才算出 `payment_id`（`merchant_reference` 不是 UUID 時不查詢、`payment_id` 為 NULL）→ **INSERT `payment_events` 不在任何 transaction 內**（獨立 COMMIT）；違反 `uq_payment_events_valid` 時讀出既有事件，`processed_at` 有值 → `DUPLICATE`，NULL → 沿用既有事件繼續 → payload 驗證（`status ∈ {SUCCEEDED, FAILED}` 等）不通過 → 400 `INVALID_PAYLOAD`（`processed_at` 保持 NULL）→ 找不到付款 → 填 `processed_at`、`IGNORED`／`UNKNOWN_PAYMENT` → 交給 handler（actor `WEBHOOK`）→ `processed_at IS NULL` 時填入 → 依 §4.2 的對照表回應（`CONFLICT` → `IGNORED`／`STATUS_CONFLICT`）；金鑰是空字串時一律驗簽失敗
  - 驗收：錯誤簽章 → 401 `INVALID_SIGNATURE`，有一筆 `signature_valid = false`；**簽章錯誤、但 `merchant_reference` 是一筆真實存在的付款 → 401，該事件的 `payment_id` 是 NULL、`event_key` 是 `charge_id:status`、`payload` 完整保存**；同一個事件依序送兩次 → 第二次 `DUPLICATE`，只有一筆 `signature_valid = true`，ledger 只有一筆 `CONFIRM`；先送一個簽章錯誤但 `event_key` 相同的假事件，再送真的 → 真的仍然 `PROCESSED`；同步回應已經處理過的付款收到 webhook → `PROCESSED`、沒有任何重複異動；不存在的 `merchant_reference` → `IGNORED`／`UNKNOWN_PAYMENT`；`merchant_reference = "abc"` → 200 `IGNORED`／`UNKNOWN_PAYMENT`（不是 500）；`status = "PENDING"` → 400 `INVALID_PAYLOAD`；金額不一致 → `IGNORED`／`AMOUNT_MISMATCH`，付款狀態不變、`review_reason = AMOUNT_MISMATCH`；付款已經是 `FAILED` 時收到 `SUCCEEDED` → `IGNORED`／`STATUS_CONFLICT`；**處理中斷後重送**：手動 INSERT 一筆相同 `event_key`、`processed_at` 是 NULL 的驗簽成功事件，再送出真的 webhook → `PROCESSED`、付款狀態改變、既有事件的 `processed_at` 被填入、`payment_events` 沒有新增驗簽成功的列；`WebhookController` 內沒有包住事件 INSERT 的 `DB::transaction`；程式碼審查：查詢 `payments` 的程式碼排在驗簽之後
  - §五：AC-I3、AC-E5 ／ INV：INV-04、INV-08、INV-12

- [x] **T2.5** 送出 webhook 的指令與 Demo API ⚠️（BE）
  - 相依：T2.4、T1.19、T1.31
  - 範圍：`mock-gateway:webhook {payment}`：依 `mock_gateway_charges` 組出事件、用 `MOCK_GATEWAY_WEBHOOK_SECRET` 簽章、對 `MOCK_GATEWAY_WEBHOOK_URL` 發出 HTTP 請求（逾時 5 秒），輸出第一行 `HTTP {status} {result}`；`POST /api/demo/payments/{id}/webhook` 用 `Artisan::call()` 執行它，回應格式依 §9.7
  - 驗收：feature test 用 `Http::fake()` 驗證簽章與 body；付款不存在 → 404 `PAYMENT_NOT_FOUND`；付款在金流端沒有紀錄 → 422 `DEMO_COMMAND_FAILED`；在 docker 環境中依序實際按兩次，第二次輸出 `HTTP 200 DUPLICATE`
  - §五：AC-I3 ／ INV：INV-12

- [x] **T2.6** 重設 Demo 資料：`demo:reset` 與 `POST /api/demo/reset`（BE）
  - 相依：T1.19、T1.31
  - 範圍：在一個 transaction 內 `TRUNCATE` 所有業務資料表（[database-schema.md](./database-schema.md) 的 9 張表，包含 `mock_gateway_charges`）`RESTART IDENTITY CASCADE`，再執行 seeder；**不包含 Laravel 預設的表**（`users`、`password_reset_tokens`、`sessions`、`cache`、`cache_locks`、`jobs`、`job_batches`、`failed_jobs`、`migrations`）；`APP_ENV` 不是 `local`／`testing` 時指令以 exit code 1 結束（[trade-offs.md](./trade-offs.md) #31）
  - 驗收：重設後商品 ID 是 1、2、3，商品 2 `available = 5`，`all_consistent = true`，沒有任何訂單、付款、金流紀錄；重設前在 `users` 建立一筆資料，重設後仍然存在；`APP_ENV=production` 執行時失敗且資料不變
  - §五：— ／ INV：INV-05

### 併發測試

- [x] **T2.7** 併發測試的基礎設施（QA）
  - 相依：T2.6
  - 範圍：`config/database.php` 新增指向 `checkout` 的 `pgsql_app` 連線；Pest helper：`resetDemo()`（呼叫 `POST {CONCURRENCY_BASE_URL}/api/demo/reset`）、`appLedgerBalanced()`（用 `pgsql_app` 或 `GET /api/demo/state`）；`concurrency` group 的測試**不使用** `RefreshDatabase`（見 `concurrency-testing` skill）
  - 驗收：一般測試執行前後，`checkout` 資料庫的資料不變；`concurrency` group 可以單獨執行
  - §五：— ／ INV：—

- [x] **T2.8** 併發：不超賣與 UNLIMITED ⚠️（QA）
  - 相依：T2.7、T2.1
  - 範圍：測試開始前 `resetDemo()`；對商品 2 用 `Http::pool` 同時送 20 個購買 1 件的請求（各自不同的 key）；對商品 3 同時送 20 個請求。測試結束時**不清除結果**，讓 `/demo` 可以展示（Demo 4 就是執行這個測試）。這和 `concurrency-testing` skill「測試前後自己清理資料」的文字不同，理由：Demo 4 需要在 `/demo` 展示結果；測試開始前一定會重設，所以前一次留下的資料不會影響結果
  - 驗收：商品 2 剛好 5 個 201、15 個 409 `OUT_OF_STOCK`，`available = 0`、`reserved = 5`、ledger 5 筆 `RESERVE`；商品 3 全部 201，`inventory_ledger` 沒有商品 3 的紀錄；`all_consistent = true`
  - §五：AC-O2、AC-O3、AC-C1 ／ INV：INV-02、INV-04、INV-05

- [x] **T2.9** 併發：同 key 下單、同 key 付款與 webhook 重送 ⚠️（QA）
  - 相依：T2.7、T2.1、T2.2、T2.4
  - 範圍：同一個 Idempotency-Key 同時送出 2 次下單；同一筆訂單、同一個 Idempotency-Key、同一張 4242 卡同時送出 2 次付款；同一個驗簽成功的 webhook 同時送 5 次
  - 驗收：下單：只有一張訂單，兩個回應的 `id` 相同。付款：兩個回應都是 2xx（不可以出現 409 `ORDER_NOT_PAYABLE` 或 `PAYMENT_IN_PROGRESS`）、`payment.id` 相同、`payments` 只有一筆、`mock_gateway_charges` 只有一筆、ledger 只有一筆 `CONFIRM`（狀態碼可能一個 200、一個 202，依 #27 不比對整個 body）。webhook：訂單只轉 `PAID` 一次、ledger 只有一筆 `CONFIRM`、只有一筆 `signature_valid = true`、5 個回應都是 200（`PROCESSED` 或 `DUPLICATE`）。最後 `all_consistent = true`
  - §五：AC-I1、AC-I3、AC-C1 ／ INV：INV-04、INV-08、INV-10、INV-11、INV-12

### 前端

- [x] **T2.10** 冪等相關的前端處理（FE）
  - 相依：T1.23、T1.24；串接驗證相依 T2.1、T2.2
  - 範圍：下單、付款遇到 `NETWORK_ERROR` 時，提供「重試」按鈕並**沿用同一個 key**（讓伺服器去重）；收到 `IDEMPOTENCY_KEY_REUSED` 時產生新的 key 並請使用者重新確認
  - 驗收：用瀏覽器開發者工具模擬離線後重試，只建立一筆訂單／付款
  - §五：AC-I1 ／ INV：INV-11

- [x] **T2.11** Demo 頁：「送出 webhook」「重設資料」按鈕（FE）
  - 相依：T1.25；串接驗證相依 T2.5、T2.6
  - 範圍：最近的付款表格每一列有「送出 webhook」按鈕；「重設資料」用 `ElMessageBox` 確認；用 `ElMessage` 顯示回應的 `output`；直接使用回應中的 `state` 更新畫面；`DEMO_COMMAND_FAILED` 顯示 `details.output`
  - 驗收：同一筆付款依序按兩次，第二次顯示 `HTTP 200 DUPLICATE`，商品表格的數字不變
  - §五：AC-I3 ／ INV：—

- [x] **T2.12** M2 Demo 驗收（QA）
  - 相依：T2.8～T2.11
  - 範圍：手動走完 Demo 4、6
  - 驗收：兩個情境的結果與里程碑驗收描述相同
  - §五：AC-O2、AC-I3 ／ INV：—

---

## M3：結果不明、對帳、取消與逾時（Prompt 3，Demo 情境 5、7）

**里程碑驗收**：用 9995 付款 → 訂單頁顯示「付款確認中」、不能重新付款或取消 → 在 `/demo` 按「執行對帳」→ 訂單變成 `PAID`、狀態歷史的 actor 是 `SYSTEM`（Demo 5）；建立訂單後在 `/demo` 按「執行逾時釋放」→ 訂單 `CANCELLED`（`TIMEOUT`）、`reserved` 減少（Demo 7）。

### 後端

- [x] **T3.1** 逾時卡號與 `UNKNOWN` ⚠️（BE）
  - 相依：T1.18、T2.3
  - 範圍：`MockPaymentGateway` 處理 9995／9987：先寫入 `mock_gateway_charges`（`SUCCEEDED`／`FAILED`），再**立即**拋出 `GatewayTimeoutException`（[checkout-flow.md](./checkout-flow.md) §5.1）；`StartPayment` 捕捉後用 `PaymentStateMachine` 把付款從 `PROCESSING` 轉成 `UNKNOWN`（CAS 0 列時不做任何事），回 202（由 `PaymentAttemptResponse` 依重新讀取的狀態決定）
  - 驗收：9995 → 202、付款 `UNKNOWN`、訂單仍是 `PENDING_PAYMENT`、`can_pay = false`、`can_cancel = false`；接著再付款 → 409 `PAYMENT_IN_PROGRESS`；`UNKNOWN` 的轉換不在 DB transaction 內呼叫 gateway；`UNKNOWN` 的轉換不經過 `PaymentResultHandler`（[state-machines.md](./state-machines.md) §三）
  - §五：AC-E1 ／ INV：INV-03、INV-07、INV-09

- [x] **T3.2** 取消與逾時共用的釋放交易 ⚠️（BE）
  - 相依：T1.11、T1.13
  - 範圍：[checkout-flow.md](./checkout-flow.md) §6.1：`SELECT orders FOR UPDATE` → 檢查進行中的付款 → 訂單 CAS → history → 逐筆 `release` → ledger。抽成共用元件 `App\Actions\ReleaseReservedOrder`（[architecture.md](./architecture.md) §二；只有一種實作，不抽介面），`CancelOrder`、`ExpireOrder` 只負責各自的前提條件、`cancel_reason` 與 actor
  - 驗收：第一個查詢就是 `lockForUpdate()`，所有判斷都使用鎖住後讀到的值；CAS 回傳 `false` 時不呼叫 `release`；UNLIMITED 明細不碰 `inventories`
  - §五：AC-E3、AC-C1、AC-C2 ／ INV：INV-03、INV-04、INV-05、INV-10

- [x] **T3.3** 取消訂單：`CancelOrder` 與 `POST /api/orders/{id}/cancel` ⚠️（BE）
  - 相依：T3.2、T1.15
  - 範圍：前提：`status = PENDING_PAYMENT` 且沒有進行中的付款；`cancel_reason = USER`、actor `CUSTOMER`；回應 200 與 `Order`
  - 驗收：LIMITED 取消後 `reserved −q`、`available +q`、一筆 `RELEASE`；有 `UNKNOWN` 付款 → 409 `PAYMENT_IN_PROGRESS`、庫存不變；`PAID`／`CANCELLED` → 409 `ORDER_NOT_CANCELLABLE`，`details.status` 正確；重複取消不會產生第二筆 `RELEASE`
  - §五：AC-E1、AC-E4、AC-C1、AC-C2 ／ INV：INV-04、INV-09、INV-10

- [x] **T3.4** 逾時：`ExpireOrder` 與 `orders:expire` ⚠️（BE）
  - 相依：T3.2
  - 範圍：`ExpireOrder` 的前提：鎖住後 `expires_at < now()` 且沒有進行中的付款，否則跳過；`cancel_reason = TIMEOUT`、actor `SYSTEM`。指令依 §6.2 掃描（**`NOT EXISTS` 排除有進行中付款的訂單**、`ORDER BY expires_at`、`LIMIT checkout.sweep_batch_size`），每筆訂單一個獨立的 transaction，單筆失敗只記錄 log 不中斷；`--force` 只略過 `expires_at`，只在 `local`／`testing` 允許（[trade-offs.md](./trade-offs.md) #30）；輸出第一行 `Expired {n} order(s), skipped {m}.`
  - 驗收：到期且沒有進行中付款 → `CANCELLED`（`TIMEOUT`）、庫存釋放；到期但有 `UNKNOWN` 付款 → 不被處理、訂單與庫存不變（`--force` 時也一樣）；未到期的訂單不受影響（沒有 `--force` 時）；`APP_ENV=production` 帶 `--force` → exit code 1；**不會被卡住**：把 `sweep_batch_size` 設成 2，建立 3 筆有 `UNKNOWN` 付款、`expires_at` 最早的到期訂單，加上 1 筆沒有付款的到期訂單，執行一次 → 後者被取消；**鎖內重新檢查**：對一筆已到期、而且已有 `PROCESSING` 付款的訂單直接呼叫 `ExpireOrder`（不經過掃描，等同「掃描之後才建立付款」）→ 跳過，訂單與庫存不變
  - §五：AC-E2、AC-E3、AC-C1、AC-C2 ／ INV：INV-04、INV-05、INV-09、INV-10

- [x] **T3.5** 對帳：`payments:reconcile` ⚠️（BE）
  - 相依：T3.1、T1.29、T1.36
  - 範圍：依 §6.3 掃描（`needs_review_at IS NULL`、`ORDER BY updated_at`、安全等待時間來自 `checkout.reconcile_safe_wait_seconds`）；對每一筆呼叫 `query()`，查到紀錄或查無紀錄都交給 `PaymentResultHandler`（actor `SYSTEM`；查無紀錄為 `FAILED`／`NOT_FOUND_AT_GATEWAY`、沒有金額、`provider_trade_no` 為 NULL）；`--force` 只讓 `UNKNOWN` 略過等待，`PROCESSING` 仍然要等滿；輸出第一行 `Reconciled {n} payment(s), skipped {m}.`
  - 驗收：9995 的 `UNKNOWN` → `SUCCEEDED`、訂單 `PAID`、history 的 actor 是 `SYSTEM`、一筆 `CONFIRM`；9987 → `FAILED`、訂單仍是 `PENDING_PAYMENT`、可以重新付款；停在 `PROCESSING` 且金流端沒有紀錄、超過等待時間 → `FAILED`／`NOT_FOUND_AT_GATEWAY`；未滿等待時間的 `PROCESSING` 在 `--force` 時也不會被處理；**停在 `PROCESSING`、金流端已經是 `SUCCEEDED`（模擬 `charge()` 成功後、交給 handler 前當機）、超過等待時間 → `SUCCEEDED`、訂單 `PAID`**；有 `needs_review_at` 的付款不會被掃描；把 `sweep_batch_size` 設成 1，最舊的付款被 handler 拒絕（金額不一致）之後，下一次執行會處理下一筆
  - §五：AC-E1、AC-E2、AC-C1、AC-C2 ／ INV：INV-08、INV-09

- [x] **T3.6** Scheduler 註冊（BE）
  - 相依：T3.4、T3.5
  - 範圍：`routes/console.php` 註冊 `orders:expire`、`payments:reconcile`：`everyMinute()->withoutOverlapping()`（mutex 使用 `CACHE_STORE=file`，只存排程鎖，不存業務資料）
  - 驗收：`php artisan schedule:list` 列出兩個任務；`scheduler` 容器的 log 每分鐘看得到兩個指令執行
  - §五：AC-E3 ／ INV：INV-01

- [x] **T3.7** Demo API：`POST /api/demo/expire`、`POST /api/demo/reconcile`（BE）
  - 相依：T3.4、T3.5、T1.19、T1.31
  - 範圍：用 `Artisan::call()` 執行 `orders:expire --force`、`payments:reconcile --force`，回應格式依 §9.7；路由在 `demo.only` group 內
  - 驗收：回應的 `command`、`exit_code`、`output`、`state` 正確；測試內把環境設成 `production` 時 404 `NOT_FOUND`
  - §五：AC-E1、AC-E3 ／ INV：INV-09

- [x] **T3.8** M3 流程測試（BE）
  - 相依：T3.3～T3.7
  - 範圍：用 HTTP feature test 走完 Demo 5、7，以及 AC-E1～AC-E4 的每一條
  - 驗收：每個情境結束都呼叫 `assertLedgerBalanced()`；history 的序列與 actor 正確
  - §五：AC-E1～AC-E4、AC-C1、AC-C2 ／ INV：INV-04、INV-05、INV-08、INV-09

### 前端

- [x] **T3.9** 訂單頁：取消、付款確認中、倒數結束（FE）
  - 相依：T1.24；串接驗證相依 T3.1、T3.3
  - 範圍：「取消訂單」按鈕（`ElMessageBox` 確認，只在 `can_cancel = true` 時可以按）；`has_payment_in_progress = true` 時顯示 `el-alert`「付款確認中，確認之前不能重新付款或取消」；`CANCELLED` 時顯示原因（`USER` → 使用者取消、`TIMEOUT` → 逾時未付款）；倒數到 0 時重新載入訂單
  - 驗收：9995 付款後頁面每 2 秒輪詢，在 `/demo` 按「執行對帳」後 2 秒內自動顯示付款完成；取消收到 409 時顯示訊息並重新載入
  - §五：AC-E1、AC-E3、AC-E4 ／ INV：INV-09

- [x] **T3.10** Demo 頁：「執行逾時釋放」「執行對帳」按鈕（FE）
  - 相依：T2.11；串接驗證相依 T3.7
  - 範圍：兩個按鈕，處理方式與 T2.11 相同
  - 驗收：Demo 5、7 可以完全在瀏覽器內完成
  - §五：AC-E1、AC-E3 ／ INV：—

- [x] **T3.11** M3 Demo 驗收（QA）
  - 相依：T3.8～T3.10
  - 範圍：手動走完 Demo 5、7
  - 驗收：結果與里程碑驗收描述相同
  - §五：AC-E1、AC-E3 ／ INV：—

---

## M4：QA 與 E2E

**里程碑驗收**：`concurrency` group 重複執行 20 次都通過；Playwright 錄下 Demo 1～7 的影片；requirements.md §五 的每一條都對應到至少一個自動化測試。

### 併發測試（補齊 `concurrency-testing` skill 的必測情境）

- [x] **T4.1** 併發：同一筆訂單同時發起兩次付款 ⚠️（QA）
  - 相依：T2.7、T2.3
  - 範圍：同一筆訂單、兩個不同的 key、都用 4242，同時送出
  - 驗收：剛好一筆 `SUCCEEDED`；另一個請求是 409（`PAYMENT_IN_PROGRESS` 或 `ORDER_NOT_PAYABLE`）；`mock_gateway_charges` 只有一筆成功；ledger 只有一筆 `CONFIRM`
  - §五：AC-B2、AC-C1 ／ INV：INV-07、INV-09、INV-10

- [x] **T4.2** 併發：同一筆訂單同時付款與取消 ⚠️（QA）
  - 相依：T2.7、T3.3
  - 範圍：同時送出 4242 付款與取消
  - 驗收：最終只會是「`PAID` + 一筆 `SUCCEEDED`」或「`CANCELLED` + 沒有成功的付款」；不會出現「有成功的付款但庫存已釋放」；`all_consistent = true`
  - §五：AC-E4、AC-C1 ／ INV：INV-04、INV-10

- [x] **T4.3** 併發：逾時任務與付款成功同時執行 ⚠️（QA）
  - 相依：T2.7、T3.4、T3.5
  - 範圍：用 `symfony/process` 同時啟動 `orders:expire --force` 與 `mock-gateway:webhook {payment}`（或 `payments:reconcile --force`），每個 process 有自己的 DB 連線。**子程序一律明確設定 `DB_DATABASE=checkout`**（`new Process([...], env: ['DB_DATABASE' => 'checkout', ...])`）：子程序預設繼承測試程序的 `DB_DATABASE=checkout_test`，而 webhook 指令打的 `http://app` 使用 `checkout`，兩邊會看到不同的資料庫（[architecture.md](./architecture.md) §一）。測試資料一律透過 API 準備（`resetDemo()`、`POST /api/orders`、9995 付款產生 `UNKNOWN`），斷言用 `pgsql_app` 或 `GET /api/demo/state`，不用預設連線
  - 驗收：最終只會是 `PAID` 或 `CANCELLED` 其中之一；ledger 沒有同時出現 `CONFIRM` 與 `RELEASE`；`all_consistent = true`；測試開始時用同樣的環境變數啟動一次 `php artisan tinker --execute="echo config('database.connections.pgsql.database');"`，斷言輸出是 `checkout`
  - §五：AC-E2、AC-C1 ／ INV：INV-04、INV-08、INV-09

- [x] **T4.4** 併發測試的穩定性（QA）
  - 相依：T2.8、T2.9、T4.1～T4.3
  - 範圍：每個併發測試加上 `->repeat(20)`
  - 驗收：連續執行 20 次全部通過；不使用 `sleep()`、不用重試掩蓋失敗
  - §五：AC-O2 ／ INV：—

- [x] **T4.5** 敏感資料檢查（QA）
  - 相依：T3.8
  - 範圍：走完所有卡號的付款後，搜尋所有資料表（包含 `payment_events.payload`）與測試期間的 log
  - 驗收：找不到任何完整卡號、`exp`、`cvc`；`payments.request_hash` 與用完整卡號計算的 hash 不同
  - §五：— ／ INV：INV-13

### E2E

- [x] **T4.6** Playwright 執行環境（PE）
  - 相依：T0.7
  - 範圍：決定 Playwright 在 host 執行，或用 compose profile（例如 `e2e`，預設不啟動）執行官方 Playwright image；`baseURL`、影片錄製（`video: 'on'`）、輸出目錄；`workers: 1`（測試共用資料）
  - 驗收：一個指令就能執行全部 E2E 並產生影片；預設的 `docker compose up` 不會啟動任何新服務（INV-01）
  - §五：— ／ INV：INV-01

- [x] **T4.7** E2E：Demo 1、2、3（QA）
  - 相依：T4.6、T1.26
  - 範圍：每個 spec 開始前呼叫 `POST /api/demo/reset`；在瀏覽器操作首頁 → 結帳頁 → 訂單頁，最後打開 `/demo` 確認數字
  - 驗收：三支影片；斷言畫面上的訂單狀態、付款筆數，以及 `/demo` 的 `reserved`／`sold`
  - §五：AC-B1～AC-B4 ／ INV：—

- [x] **T4.8** E2E：Demo 4（QA）
  - 相依：T4.6、T2.12
  - 範圍：在 Playwright 內用 `Promise.all` 同時送出 20 個 `POST /api/orders`（商品 2），再打開 `/demo` 截圖；最後再對商品 2 下單一次，畫面顯示庫存不足
  - 驗收：影片中 5 筆成功、商品 2 `available = 0`、`reserved = 5`；最後一次下單顯示 `OUT_OF_STOCK` 的訊息
  - §五：AC-O1、AC-O2 ／ INV：—

- [x] **T4.9** E2E：Demo 5、6、7（QA）
  - 相依：T4.6、T3.11
  - 範圍：全部在瀏覽器內操作，使用 `/demo` 的按鈕
  - 驗收：Demo 5 的狀態歷史出現 `SYSTEM`；Demo 6 第二次顯示 `HTTP 200 DUPLICATE`；Demo 7 的訂單顯示「逾時未付款」
  - §五：AC-E1、AC-E3、AC-I3 ／ INV：—

- [x] **T4.10** 驗收標準總檢（QA）
  - 相依：T4.1～T4.9
  - 範圍：`docker compose down -v && docker compose up` 之後執行所有測試；整理「§五 每一條 → 對應的測試名稱」對照表，附在 PR 說明中
  - 驗收：AC-B1～AC-C2 每一條都至少有一個自動化測試，而且全部通過
  - §五：全部 ／ INV：全部
