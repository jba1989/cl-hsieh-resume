(() => {
  // The parent resume already supplies navigation for embedded drawer reports.
  if (window.self !== window.top) return;
  const header = document.createElement('header');
  header.className = 'site-navbar';
  header.innerHTML = `<div class="site-navbar-inner">
    <span class="site-navbar-logo">CL / ENGINEERING</span>
    <nav class="site-navbar-links" aria-label="網站導覽">
      <a href="index.html#resume">履歷</a><span aria-hidden="true">・</span>
      <a href="index.html#experience">專案優化</a><span aria-hidden="true">・</span>
      <a href="checkout-docs.html">結帳流程Demo相關文件</a>
    </nav>
  </div>`;
  document.body.querySelector(':scope > header.top')?.remove();
  const spacer = document.createElement('div');
  spacer.className = 'site-navbar-spacer';
  spacer.setAttribute('aria-hidden', 'true');
  document.body.prepend(header, spacer);
  document.body.classList.add('has-site-navbar');
  const resize = () => document.documentElement.style.setProperty('--site-navbar-height', `${header.getBoundingClientRect().height}px`);
  new ResizeObserver(resize).observe(header);
  resize();
})();
