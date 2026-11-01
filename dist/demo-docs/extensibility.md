# 擴充設計

> 這次只用原價計算，促銷碼與限時優惠價**只設計、不實作**。本文件說明預留了哪些擴充點，以及未來要加功能時需要修改哪些地方。

## 一、設計原則

- **只在「確定會有第二種實作」的地方抽介面**：商品已經有兩種庫存類型、計價已經確定會有優惠價和促銷碼、面試時很可能被要求「再接一家金流」。其他地方不預先抽象
- **新增功能時，盡量只新增類別，不修改既有的流程**（開放封閉原則）
- **資料表先預留不會造成負擔的欄位**：`order_items.list_price`、`unit_price`、`discount_amount`，以及 `orders.discount_amount`。會增加維護成本的表（`product_prices`、`promo_codes`）則等到真的要做時才建立

| 擴充點 | 目前的實作 | 未來可以新增的實作 |
|---|---|---|
| `InventoryPolicy` | `LimitedInventory`、`UnlimitedInventory` | 預購（`PreorderInventory`）、多倉庫 |
| `PricingRule` | 無（直接使用原價） | `SalePriceRule`、`PromoCodeRule`、滿額折扣 |
| `PaymentGateway` | `MockPaymentGateway` | 綠界、Stripe |
| `OrderPaid` 事件（Laravel event，不是自訂介面） | 無 listener（只確認事件有發出） | 付款確認信、出貨通知（§六） |

---

## 二、庫存策略：`InventoryPolicy`

```php
interface InventoryPolicy
{
    /** 在下單的 transaction 內呼叫；庫存不足時丟出 OutOfStockException */
    public function reserve(string $orderId, int $productId, int $quantity): void;

    /** 付款成功時，在同一個 transaction 內呼叫 */
    public function confirm(string $orderId, int $productId, int $quantity): void;

    /** 取消或逾時時，在同一個 transaction 內呼叫 */
    public function release(string $orderId, int $productId, int $quantity): void;
}
```

| 實作 | `reserve` | `confirm` | `release` |
|---|---|---|---|
| `LimitedInventory` | 條件式 UPDATE `available → reserved`，0 列時丟出例外；寫入 ledger `RESERVE` | `reserved → sold`；寫入 ledger `CONFIRM` | `reserved → available`；寫入 ledger `RELEASE` |
| `UnlimitedInventory` | 不做任何事 | 不做任何事 | 不做任何事 |

**依據什麼決定要用哪一個實作**（`InventoryPolicyResolver`）：

- `reserve`：依照商品**目前的** `products.inventory_policy`
- `confirm`、`release`：依照明細的**快照** `order_items.is_inventory_tracked`。這樣就算商品在訂單進行中改變了類型，也只會釋放當初真的保留過的庫存

**為什麼不在 Action 裡用 `if ($product->isLimited())`**：同樣的判斷會出現在下單、付款成功、取消、逾時這 4 個地方。新增「預購」類型時，就要找出這 4 個 `if` 逐一修改，漏掉任何一個都會造成庫存錯誤。改成策略模式之後，只需要新增一個類別，再在 resolver 加一行對應。

### 未來：新增「預購」類型

1. `products.inventory_policy` 的 `CHECK` 加上 `'PREORDER'`
2. 新增 `PreorderInventory`，例如只檢查預購上限，不扣實體庫存
3. 在 `InventoryPolicyResolver` 加上對應
4. **不需要修改**：`PlaceOrder`、`PaymentResultHandler`、`CancelOrder`、`ExpireOrder`

---

## 三、計價 pipeline：`PriceCalculator`

```php
final readonly class PricingContext
{
    public function __construct(
        public array $lines,                  // list<array{product: Product, quantity: int}>
        public CarbonImmutable $pricedAt,     // 計價時間：限時優惠價依這個時間判斷
        public ?string $promoCode = null,     // 目前一律為 null
    ) {}
}

interface PricingRule
{
    /** 回傳新的 PriceQuote，不修改傳入的物件 */
    public function apply(PriceQuote $quote, PricingContext $context): PriceQuote;
}

final class PriceCalculator
{
    /** @param list<PricingRule> $rules 依照順序執行；目前是空陣列 */
    public function __construct(private readonly array $rules) {}

    public function quote(PricingContext $context): PriceQuote
    {
        return array_reduce(
            $this->rules,
            fn (PriceQuote $quote, PricingRule $rule) => $rule->apply($quote, $context),
            PriceQuote::fromListPrices($context),   // 起點：每一行都是原價
        );
    }
}
```

`PriceQuote` 是不可變的物件，包含：

- 每一行（`QuoteLine`）：`product_id`、`list_price`、`unit_price`、`quantity`、`discount_amount`、`line_total`
- 訂單層級：`subtotal`、`discount_amount`、`total_amount`
- 每一筆折扣的來源（`applied_discounts`），之後要寫入 `order_discounts`

`PriceQuote` 的欄位**和 `order_items`、`orders` 的金額欄位一一對應**，下單時直接寫入。

**規則的執行順序**決定了計算結果，所以在 service provider 裡明確註冊：

```php
$this->app->when(PriceCalculator::class)->needs('$rules')->give(fn ($app) => [
    // $app->make(SalePriceRule::class),   // 1. 先決定成交單價
    // $app->make(PromoCodeRule::class),   // 2. 再計算折扣
]);
```

### 什麼時候計價

**下單時才計價**，不使用 checkout session 鎖定價格（取捨見 [trade-offs.md](./trade-offs.md) #21）。前端會帶上它顯示給使用者看的 `expected_total`，後端重新計算後，如果不一致就回傳 `409 PRICE_CHANGED`，請使用者重新確認。

---

## 四、未來：限時優惠價

### 資料表

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE product_prices (
    id         BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id),
    price      INT NOT NULL CHECK (price > 0),
    starts_at  TIMESTAMPTZ NOT NULL,
    ends_at    TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    -- 同一個商品的優惠期間不可以重疊
    EXCLUDE USING gist (product_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
);
```

- **用 exclusion constraint 防止期間重疊**：如果兩段優惠期間重疊，同一個時間點就會有兩個價格，要用哪一個就很難說清楚。PostgreSQL 可以直接在資料庫層禁止這種資料，MySQL 只能靠應用程式檢查
- `'[)'` 代表包含開始時間、不包含結束時間。兩段優惠可以頭尾相接，例如 12:00 結束、12:00 開始，不會被判定為重疊

### 套用方式

`SalePriceRule` 查詢 `starts_at <= :priced_at AND ends_at > :priced_at` 的優惠價，把它設為那一行的 `unit_price`。`list_price` 維持原價，前端就能顯示「原價 $1,000，優惠價 $800」。

| 要修改 | 不需要修改 |
|---|---|
| 新增 migration、`ProductPrice` model、`SalePriceRule`；在 provider 註冊；商品 API 回傳目前的優惠價與結束時間 | `orders`／`order_items` 的結構、下單交易、狀態機、付款流程 |

**邊界情況**：使用者在 11:59 看到優惠價，12:01 才按下單，這時優惠已經結束。後端計算出的金額和 `expected_total` 不一致，所以回傳 `PRICE_CHANGED`。使用者不會在不知情的情況下被收取比較高的金額。

---

## 五、未來：促銷碼

### 資料表

```sql
CREATE TABLE promo_codes (
    id              BIGSERIAL PRIMARY KEY,
    code            VARCHAR(32) NOT NULL UNIQUE,            -- 一律存大寫
    discount_type   VARCHAR(10) NOT NULL CHECK (discount_type IN ('FIXED', 'PERCENT')),
    discount_value  INT NOT NULL CHECK (discount_value > 0),
    min_subtotal    INT NOT NULL DEFAULT 0 CHECK (min_subtotal >= 0),
    max_discount    INT CHECK (max_discount > 0),            -- PERCENT 折扣的金額上限
    max_redemptions INT CHECK (max_redemptions > 0),         -- NULL 表示不限次數
    redeemed_count  INT NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    CHECK (discount_type <> 'PERCENT' OR discount_value <= 100),
    CHECK (max_redemptions IS NULL OR redeemed_count <= max_redemptions)
);

CREATE TABLE promo_code_redemptions (
    id            BIGSERIAL PRIMARY KEY,
    promo_code_id BIGINT NOT NULL REFERENCES promo_codes(id),
    order_id      UUID NOT NULL UNIQUE REFERENCES orders(id),   -- 一筆訂單只能用一組促銷碼
    released_at   TIMESTAMPTZ,                                  -- 訂單取消時填入
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_discounts (
    id            BIGSERIAL PRIMARY KEY,
    order_id      UUID NOT NULL REFERENCES orders(id),
    order_item_id BIGINT REFERENCES order_items(id),            -- NULL 表示訂單層級的折扣
    source_type   VARCHAR(20) NOT NULL CHECK (source_type IN ('PROMO_CODE')),
    source_id     BIGINT NOT NULL,
    amount        INT NOT NULL CHECK (amount > 0),
    description   VARCHAR(255) NOT NULL,                        -- 快照，例如「新會員折 100」
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 使用次數：和庫存用同一套做法

促銷碼的「可用次數」本質上就是另一種庫存，所以用相同的模式處理：

```sql
-- 下單 transaction 內：條件式 UPDATE 防止超用
UPDATE promo_codes
   SET redeemed_count = redeemed_count + 1
 WHERE id = :id
   AND is_active
   AND now() >= starts_at AND now() < ends_at
   AND (max_redemptions IS NULL OR redeemed_count < max_redemptions);
-- 0 列 → ROLLBACK，回傳 409 PROMO_CODE_UNAVAILABLE
INSERT INTO promo_code_redemptions (promo_code_id, order_id) VALUES (:id, :order_id);

-- 取消或逾時的 transaction 內：用 released_at 做 CAS，避免重複歸還
UPDATE promo_code_redemptions SET released_at = now()
 WHERE order_id = :order_id AND released_at IS NULL;
-- 1 列時才執行：
UPDATE promo_codes SET redeemed_count = redeemed_count - 1 WHERE id = :id;
```

| 要修改 | 不需要修改 |
|---|---|
| 3 張表的 migration；`PromoCodeRule`；下單 API 增加 `promo_code` 欄位；`PlaceOrder` 在交易內扣減次數；`CancelOrder`／`ExpireOrder` 歸還次數 | 狀態機、付款流程、庫存策略 |

**這次不做的限制**：「每個會員限用一次」需要登入機制，不在這次的範圍內。

---

## 六、付款後的動作：`OrderPaid` 事件

`PaymentResultHandler` 在訂單轉成 `PAID`（訂單 CAS 成功）時發出 `App\Events\OrderPaid`，只帶 order id。事件實作 `ShouldDispatchAfterCommit`：transaction COMMIT 之後才**同步**發出，ROLLBACK 就不發，不經過 Queue（INV-01）。同步回應、webhook、對帳三條路徑都經過 handler，訂單 CAS 只會成功一次，所以每筆訂單最多發出一次（[checkout-flow.md](./checkout-flow.md) §4.2、[architecture.md](./architecture.md) §二）。

**目前沒有 listener**。寄確認信依使用者的決定，這次只需要確認事件有發出（feature test 以 `Event::fake()` 斷言），不寫 email 內容。

### 未來：寄付款確認信

1. 新增 `SendOrderPaidMail` listener（Laravel 依型別自動註冊，或在 provider 用 `Event::listen` 註冊）
2. listener 用 order id 重新讀取訂單（事件只帶 id，不帶可能過時的資料），寄出 Mailable
3. **不需要修改**：`PaymentResultHandler`、狀態機、付款流程、任何 Action

| 注意事項 | 說明 |
|---|---|
| listener 失敗不影響付款結果 | 事件在 COMMIT 之後才發出，付款、訂單、庫存都已經寫入；listener 拋出例外也無法 ROLLBACK。listener 要自行捕捉例外並寫 log，否則同步回應的請求會回 500（訂單其實已經是 `PAID`），webhook 也不會填入 `processed_at` |
| 失敗後不會自動重寄 | 重送的付款結果在 handler 內是 `ALREADY_PROCESSED`，不會再發出事件。需要「一定寄得到」時，改成在 handler 的同一個 transaction 內寫入 outbox 資料表，由 Scheduler 每分鐘掃描未寄出的列（沿用 [trade-offs.md](./trade-offs.md) #11 的掃描模式，不需要 Queue） |
| 同步寄信佔住 php-fpm worker | 付款請求要等寄信完成才回應。寄信變慢時，改成 outbox 加 Scheduler；若要改用 `ShouldQueue` listener，需要引入 Queue worker，**要由使用者決定**（requirements.md §三、§七 不引入 Queue） |
| 不變量 | listener 只讀取訂單、不改變任何狀態，不影響 INV-03、INV-08；事件不經過 Queue、Redis，維持 INV-01 |

---

## 七、面試時可能被要求的其他功能

| 功能 | 要修改的地方 | 不需要修改的地方 |
|---|---|---|
| 多商品購物車 | 下單 API 改成接收 `items[]`；`PlaceOrder` 依 `product_id` 排序後逐一呼叫 `reserve`，任何一個失敗就整筆 ROLLBACK，並回報所有缺貨的商品 | 資料表（`order_items` 本來就支援多筆）、狀態機、付款流程 |
| 第二家金流 | 新增一個 `PaymentGateway` 實作；`payments.provider` 填入對應的值；webhook 依 provider 分流 | 付款狀態機、`PaymentResultHandler`、對帳流程 |
| 退款 | 新增 `refunds` 表與它的狀態機（`PENDING → SUCCEEDED / FAILED`）；`PaymentGateway` 增加 `refund()`；訂單增加 `REFUNDED` 狀態 | 下單流程、庫存策略（是否把庫存加回來，由商業規則決定） |
| 會員登入 | 新增 `users`；`orders` 增加 `user_id`；訂單 API 改成檢查擁有者 | 交易流程 |
| 限時搶購 | 先量測，確認瓶頸在 `inventories` 的單一熱點列，才考慮用 Redis 預扣。資料庫仍然是最終的依據 | 狀態機、付款流程 |
| 0 元訂單（全額折抵） | 下單時如果 `total_amount = 0`，就直接轉成 `PAID`（同樣要發出 `OrderPaid`）；`orders.total_amount` 的 CHECK 改成 `>= 0` | 付款流程 |
| 付款確認信、出貨通知 | 新增 `OrderPaid` 的 listener（§六） | `PaymentResultHandler`、狀態機、付款流程 |
