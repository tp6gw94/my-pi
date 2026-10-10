# 在句子中選入 skill

這份指南供已使用 Pi 的使用者閱讀。輸入句中的 `/` 可搜尋 skill，確認候選後繼續寫提示；送出時附上選入 skill 的路徑，由 agent 自行讀取。

## 啟用

在 Pi 執行 `/reload`。Extension 位於 `~/.pi/agent/extensions/inline-skills/index.ts`，由個人 extension 目錄自動載入。

如果其他 extension 已替換主編輯器，本 extension 會顯示警告並停止安裝，不覆蓋它。

## 選入 skill

1. 輸入 `請用 /write`。在 `/` 前留空白，清單會隨關鍵字篩選。
2. 用上下方向鍵選候選，再按 `Tab` 或 `Enter`。Pi 插入 `/skill:名稱`，這次按鍵不送出訊息。
3. 繼續寫提示。清單關閉後按 `Enter` 才送出，訊息末尾會附上 `<selected_skills>` 區塊，列出各 skill 的名稱與 `SKILL.md` 路徑，並要求 agent 先用 read 工具讀取。正文不會塞進 prompt，避免 agent 重複讀取時浪費 token。

```mermaid
flowchart LR
    A[句中輸入 /] --> B[篩選候選]
    B --> C[Tab 或 Enter 插入]
    C --> D[繼續寫提示]
    D --> E[送出並附上 skill 路徑]
```

同一則訊息可選入多個 skill，同名 skill 只列一次。開頭若是原生 `/skill:名稱`，該 skill 仍由 Pi 原生載入完整內容，後面不再重複列出。

也可先輸入 `/skill:todd-mode `，再於後面的提示中使用 `/` 搜尋其他 skill。開頭的 skill 名稱須已登錄，指令後須留一個普通空格；後面的提示可以換行。第一個技能選單仍由 Pi 原生處理，一般指令與 shell 參數不開啟行內技能選單。

## 不選取時繼續打字

按空白或 `Esc` 可關閉清單，原文字保留。游標離開詞元或沒有符合項目時也會關閉；普通打字不會自動套用候選。

未選取的 `/關鍵字` 保持文字。URL、檔案路徑與原生行首指令維持原有行為。

## 編輯與讀取失敗

改寫或刪除選入的引用後，重新選取 skill。從歷史紀錄取回提示、貼上或 undo 後也須重新選取，避免普通文字誤取得選取資格。

送出前會確認 skill 檔可讀；檔案不存在或無法讀取時會顯示錯誤並阻擋送出。若尚未開始新草稿，Pi 會恢復完整提示；修好技能檔後可直接重試。恢復後若再修改提示，須重新選入 skill。若已有新草稿，Pi 不覆蓋它。

接受候選使用原生編輯操作，撤銷替換可能需要多次 undo。

## 執行測試

在目前安裝的 Pi 1.1.0 環境執行：

```bash
node ~/.pi/agent/extensions/inline-skills/tests/run.mjs
```

測試使用真實編輯器與 input handler，涵蓋選取、取消、路徑附加和錯誤恢復。測試檔的套件路徑對應目前的本機安裝；可透過 `PI_ROOT` 環境變數指定其他 Pi 安裝目錄，透過 `EVIDENCE` 指定測試證據目錄。
