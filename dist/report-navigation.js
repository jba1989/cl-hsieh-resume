(() => {
  if (window.self !== window.top) {
    document.querySelector('nav.toc')?.setAttribute('hidden', '');
    return;
  }
  const headings = [...document.querySelectorAll('h2')];
  if (!headings.length) return;
  const existing = document.querySelector('nav.toc');
  const nav = document.createElement('nav');
  nav.className = 'report-navigation';
  nav.setAttribute('aria-label', '章節導覽');
  const label = document.createElement('p');
  label.textContent = '章節導覽';
  nav.append(label);
  if (existing) {
    existing.querySelectorAll('a').forEach(link => nav.append(link.cloneNode(true)));
    existing.hidden = true;
  } else {
    headings.forEach((heading, index) => {
      if (!heading.id) heading.id = `report-section-${index + 1}`;
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.innerText.replace(/\s+/g, ' ').trim();
      nav.append(link);
    });
  }
  document.body.prepend(nav);
  document.body.classList.add('report-with-navigation');
  const links = [...nav.querySelectorAll('a')];
  const targets = links.map(link => document.getElementById(decodeURIComponent(link.hash.slice(1))));
  let scheduled = false;
  const update = () => {
    let current = 0;
    targets.forEach((target, index) => {
      if (target && target.getBoundingClientRect().top <= 120) current = index;
    });
    links.forEach((link, index) => {
      if (index === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    scheduled = false;
  };
  window.addEventListener('scroll', () => {
    if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
})();
