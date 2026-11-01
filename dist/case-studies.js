(() => {
  const cases = {
    inventory: { label: '庫存 API', page: 'inventory-report.html', title: 'MRP 庫存 API 重構分享' },
    bom: { label: 'PostgreSQL Production Incident', page: 'bom-incident.html', title: 'BOM 查詢磁碟事故復盤' },
    ci: { label: 'CI 效率', page: 'ci-efficiency.html', title: '1120 秒到 161 秒' },
    mo: {
      label: '併發正確性',
      number: '02', tag: 'CONCURRENCY & DESIGN',
      title: '製造工單取號：把 race condition 視為流程問題，而非單點鎖問題',
      summary: '重構 MAC 位址分配與工單建立流程，優先守住生產關鍵路徑的正確性，同時把序號類型拆成可擴充的抽象。',
      facts: [['風險', '重複／無效序號'], ['策略', 'Queue serialization'], ['範圍', 'MAC · SN · SAS']],
      sections: [
        ['問題邊界', '建立與確認工單包含跨表、跨步驟的先讀後寫取號流程；舊有 2-Digit 工廠判定也導致 MAC 位址區間浪費。'],
        ['取捨', '沒有把每個節點各自加 DB 或 Redis lock。鎖只能保護單一 critical section，卻難以保護多步驟的完整工作流。'],
        ['最後做法', '把 create MO 改為 queue job，confirm MO 改為 queue event；同一 worker 序列化處理整段取號流程。另以 interface 拆分 MAC、SAS、SN 取號邏輯。'],
        ['結果', '降低生產路徑中的併發衝突、避免 MAC 資源浪費，並讓未來新增序號類型不必把規則硬塞回單一流程。']
      ]
    },
    delivery: {
      label: '產品交期服務',
      number: '03', tag: 'BUSINESS SYSTEM',
      title: '交期計算引擎：沿用既有資料，維持跨系統一致性',
      summary: '沿用其他系統已整理好的庫存與訂單資料，將人工跨訂單與月份資料的交期判讀轉為可追蹤的計算服務，並維持 2 個系統使用相同的資料。',
      facts: [['人工流程', '每型號約 20 分鐘'], ['核心運算', '單次約 1 秒'], ['迭代', '10 次 MR']],
      sections: [
        ['問題邊界', '交期不只是查詢；錯誤的庫存資訊會造成多人承諾同一批貨，進一步帶來搶貨、客戶關係與合約風險。'],
        ['關鍵決策', '選擇沿用其他系統既有資料表中已整理好的庫存與訂單資訊，避免重新從 SAP 資料庫進行欄位對應與資料整理。2 個系統共用相同的資料來源，也能減少各自整理資料造成的差異，讓使用者看到一致的資訊。'],
        ['最後做法', '以其他系統已整理好的庫存與訂單資料作為計算基礎，將多型號、替代料、跨倉與安全庫存規則收斂在計算層，保留運算 log 供真實 PO 比對。'],
        ['結果', '單一型號從至少約 20 分鐘人工查找縮至約 1 秒，並以可追蹤規則持續收斂上線後才出現的商業例外。']
      ]
    }
  };

  const esc = value => String(value).replace(/[&<>"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
  const inventoryStory = () => `
    <article class="inventory-story">
      <p class="story-verdict">後端執行時間減少 <strong>86%</strong>，SQL 查詢減少 <strong>93%</strong>。更重要的是，共通規則只需維護 1 處，CEO 檢視仍保有自己的業務差異。</p>
      <section class="story-chapter">
        <p class="story-kicker">01 ／ 重構時機</p>
        <h2>當初分開是合理取捨，現在整合也需要理由</h2>
        <div class="story-comparison">
          <div><h3>需求變動時：優先隔離</h3><p>CEO 檢視是老闆的特殊需求。團隊刻意將 <code>modelInventory</code> 與 <code>modelInventoryCeoView</code> 分開，讓 CEO 頁面調整時，不影響原本的機種庫存頁。</p></div>
          <div><h3>穩定數月後：降低維護成本</h3><p>2 支 API 的篩選、分頁與銷量彙總高度相似。需求穩定後，共通修正仍要改 2 處，整合的價值才超過持續隔離。</p></div>
        </div>
        <p class="story-decision"><b>決策：</b>整合穩定的共用流程，將 CEO 專屬處理留在 <code>CeoInventoryDecorator</code>。代價是修改共用流程時，必須同時驗證2 種檢視。</p>
      </section>
      <section class="story-chapter">
        <p class="story-kicker">02 ／ 找到真正的慢點</p>
        <h2>先減少資料庫往返，再優化單條 SQL</h2>
        <p>分段計時發現，<code>getMonthlyAverageSalesSummary</code> 占 API 執行時間的 <strong>71%</strong>。近6 個月平均銷量在迴圈內逐月聚合，每月往返遠端資料庫 18 次，6 個月共 108 次。</p>
        <ol class="story-evidence">
          <li><b>觀察</b><span>時間主要花在遠端資料庫往返，PHP 運算並非主要瓶頸。</span></li>
          <li><b>選擇</b><span>先合併迴圈內的重複查詢；整支 API 的 SQL 查詢由 210 次降至 14 次。</span></li>
          <li><b>再改善</b><span>將 materialized view 的年月算術條件改為 row comparison，讓年月欄位可使用索引；單條查詢由 5.8 ms 降至 1.9 ms。</span></li>
        </ol>
      </section>
      <section class="story-chapter">
        <p class="story-kicker">03 ／ 責任怎麼拆</p>
        <h2>共用流程集中，差異明確保留</h2>
        <p>將重複邏輯抽成3 個可獨立測試的單元，再合併查詢，讓2 支 API 共用改善成果；2 支 controller 各縮至 4 行。</p>
        <dl class="story-modules">
          <div><dt><code>ModelInventoryQuery</code></dt><dd>專責解析篩選條件，將輸入處理與庫存查詢流程分開。</dd></div>
          <div><dt><code>ModelStockPageService</code></dt><dd>統一查詢、分頁與資料組裝，共通邏輯修 1 次，2 支 API 生效。</dd></div>
          <div><dt><code>CeoInventoryDecorator</code></dt><dd>封裝 CEO 檢視的額外處理，讓專屬需求能獨立調整。</dd></div>
        </dl>
        <p class="story-decision"><b>設計考量：</b>依職責拆分篩選解析、流程協調與 CEO 差異，讓各單元有明確的修改理由。共通規則集中維護，專屬需求獨立調整，也能分別測試，減少改 1 處牽動整支 API 的風險。</p>
      </section>
      <section class="story-chapter">
        <p class="story-kicker">04 ／ 成果與驗證</p>
        <h2>把變快與沒改壞，分別交出證據</h2>
        <div class="story-results"><div><span>後端執行時間</span><p>3,080 ms → <strong>427 ms</strong></p><small>減少約 86%</small></div><div><span>每次請求的 SQL 查詢</span><p>210 → <strong>14 次</strong></p><small>減少約 93%</small></div></div>
        <p>分別比對2 支 API 重構前後的輸出，確認庫存計算與回傳結果一致；再以突變測試確認測試能偵測邏輯錯誤。上述時間為後端執行時間的量測結果。</p>
      </section>
    </article>`;

  const renderCase = item => item.page ? `
    <div class="drawer-top"><p class="drawer-label">${esc(item.label)}</p><div class="drawer-top-actions"><button class="drawer-open-window" type="button" aria-label="在新視窗完整閱讀">↗</button><button class="drawer-close" type="button" aria-label="關閉案例">×</button></div></div>
    <iframe class="bom-original-frame" src="${esc(item.page)}?view=drawer&v=2" title="${esc(item.title)}"></iframe>
    ` : `
    <div class="drawer-top"><p class="drawer-label">${esc(item.label)}</p><div class="drawer-top-actions"><button class="drawer-open-window" type="button" aria-label="在新視窗完整閱讀" title="在新視窗完整閱讀">↗</button><button class="drawer-close" type="button" aria-label="關閉案例">×</button></div></div>
    <h1>${esc(item.title)}</h1><p class="drawer-summary">${esc(item.summary)}</p>
    <div class="drawer-facts">${item.facts.map(([label, value]) => `<div class="drawer-fact"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join('')}</div>
    ${item.story ? inventoryStory() : item.sections.map(([title, copy]) => `<section class="drawer-section"><h2>${esc(title)}</h2><p>${esc(copy)}</p></section>`).join('')}
    `;

  const query = new URLSearchParams(location.search);
  const casePage = query.get('case');
  if (cases[casePage]?.page) {
    location.replace('./' + cases[casePage].page);
    return;
  }
  if (casePage && cases[casePage]) {
    document.body.classList.add('case-page');
    document.body.innerHTML = `<main class="case-page"><div class="case-drawer" style="transform:none;box-shadow:none;width:auto;height:auto;padding:0;margin-top:28px">${renderCase(cases[casePage])}</div></main>`;
    document.querySelector('.drawer-open-window').remove();
    return;
  }

  const triggers = [...document.querySelectorAll('[data-case]')];
  if (!triggers.length) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.innerHTML = '<aside class="case-drawer" role="dialog" aria-modal="true" aria-label="工程案例詳細內容"></aside>';
  document.body.append(backdrop);
  const drawer = backdrop.querySelector('.case-drawer');
  let current = null;
  const close = () => { backdrop.classList.remove('is-open'); backdrop.setAttribute('aria-hidden', 'true'); document.body.classList.remove('drawer-lock'); };
  const open = key => { current = key; drawer.innerHTML = renderCase(cases[key]); backdrop.classList.add('is-open'); backdrop.setAttribute('aria-hidden', 'false'); document.body.classList.add('drawer-lock'); drawer.querySelector('.drawer-close').focus(); drawer.querySelector('.drawer-close').addEventListener('click', close); drawer.querySelector('.drawer-open-window').addEventListener('click', () => window.open(`case.html?case=${encodeURIComponent(current)}`, '_blank', 'noopener')); };
  triggers.forEach(trigger => {
    trigger.addEventListener('click', () => open(trigger.dataset.case));
    trigger.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(trigger.dataset.case); } });
  });
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && backdrop.classList.contains('is-open')) close(); });
})();
