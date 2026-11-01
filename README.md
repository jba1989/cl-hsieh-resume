# CL · Portfolio

公開履歷與結帳流程設計 Demo 的靜態網站。

網站由 GitHub Pages 自動部署；所有 Mermaid 圖表直接取自 `dist/demo-docs/` 的原始 Markdown 定義。

## 維護方式

所有要發布的網站檔案都在 `dist/`。GitHub Pages 與私有履歷站都使用這個目錄，因此只需在這裡修改一次。

## 本機預覽

```bash
python3 -m http.server 4173 --directory dist
```

開啟 `http://localhost:4173`。
