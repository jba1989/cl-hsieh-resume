const docs = [
  ['README.md', '總覽'], ['requirements.md', '需求與範圍'], ['architecture.md', '系統架構'], ['checkout-flow.md', '結帳流程'], ['state-machines.md', '狀態機'], ['database-schema.md', '資料庫結構'], ['trade-offs.md', '設計取捨'], ['extensibility.md', '擴充設計'], ['tasks.md', '開發任務'], ['design-review.md', '設計審查']
];
const tabRoot = document.querySelector('#doc-tabs');
const content = document.querySelector('#doc-content');
let selected = new URLSearchParams(location.search).get('doc') || 'README.md';
if (!docs.some(([file]) => file === selected)) selected = 'README.md';

function esc(value) { return value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function inline(value) {
  return esc(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const file = href.replace(/^\.\//, '').split('#')[0];
      return docs.some(([name]) => name === file)
        ? `<a href="?doc=${encodeURIComponent(file)}">${label}</a>`
        : `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
    });
}
function renderTable(lines) {
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => inline(cell.trim()));
  const head = cells(lines[0]); const rows = lines.slice(2).map(cells);
  return `<table><thead><tr>${head.map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n'); let html = ''; let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim(); const block = []; index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) block.push(lines[index++]); index += 1;
      if (lang === 'mermaid') {
        html += `<figure class="mermaid-diagram"><pre class="mermaid">${esc(block.join('\n'))}</pre></figure>`;
      } else html += `<pre><code>${esc(block.join('\n'))}</code></pre>`;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|?\s*:?-{3,}/.test(lines[index + 1] || '')) { const table = [line, lines[index + 1]]; index += 2; while (index < lines.length && /^\|.*\|\s*$/.test(lines[index])) table.push(lines[index++]); html += renderTable(table); continue; }
    if (/^---+$/.test(line.trim())) { html += '<hr>'; index += 1; continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/); if (heading) { const level = heading[1].length; html += `<h${level}>${inline(heading[2])}</h${level}>`; index += 1; continue; }
    if (/^>\s?/.test(line)) { const quote = []; while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, '')); html += `<blockquote>${inline(quote.join(' '))}</blockquote>`; continue; }
    const list = line.match(/^(\s*)[-*+]\s+(.+)$/); const ordered = line.match(/^(\s*)\d+\.\s+(.+)$/); if (list || ordered) { const tag = ordered ? 'ol' : 'ul'; const items = []; while (index < lines.length) { const match = lines[index].match(ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/); if (!match) break; items.push(`<li>${inline(match[1])}</li>`); index += 1; } html += `<${tag}>${items.join('')}</${tag}>`; continue; }
    if (!line.trim()) { index += 1; continue; }
    const paragraph = [line.trim()]; index += 1; while (index < lines.length && lines[index].trim() && !/^(#|>|```|\||[-*+]\s+|\d+\.\s+|---+$)/.test(lines[index])) paragraph.push(lines[index++].trim()); html += `<p>${inline(paragraph.join(' '))}</p>`;
  }
  return html;
}
function renderTabs() {
  tabRoot.innerHTML = docs.map(([file, label]) => `<button class="doc-tab" type="button" role="tab" aria-selected="${file === selected}" data-file="${file}">${label}</button>`).join('');
  tabRoot.querySelectorAll('button').forEach(button => button.addEventListener('click', () => loadDoc(button.dataset.file)));
}
function renderChapterNavigation() {
  const nav = document.querySelector('#checkout-chapters');
  nav.replaceChildren();
  const label = document.createElement('p');
  label.textContent = '章節導覽';
  nav.append(label);
  content.querySelectorAll('h2').forEach((heading, index) => {
    heading.id = `checkout-section-${index + 1}`;
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.textContent = heading.textContent;
    nav.append(link);
  });
  updateChapterNavigation();
}
function updateChapterNavigation() {
  const links = [...document.querySelectorAll('#checkout-chapters a')];
  let current = 0;
  links.forEach((link, index) => {
    const heading = document.getElementById(link.hash.slice(1));
    if (heading && heading.getBoundingClientRect().top <= 130) current = index;
  });
  links.forEach((link, index) => {
    if (index === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}
window.addEventListener('scroll', updateChapterNavigation, { passive: true });
async function loadDoc(file) {
  selected = file; renderTabs(); content.innerHTML = '<p>載入文件中…</p>';
  try {
    const response = await fetch(`demo-docs/${file}`);
    if (!response.ok) throw new Error(response.status);
    content.innerHTML = renderMarkdown(await response.text());
    renderChapterNavigation();
    await mermaid.run({ nodes: content.querySelectorAll('.mermaid') });
    history.replaceState(null, '', `?doc=${encodeURIComponent(file)}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  catch { content.innerHTML = '<p>文件暫時無法載入，請重新整理後再試一次。</p>'; }
}
renderTabs(); loadDoc(selected);
