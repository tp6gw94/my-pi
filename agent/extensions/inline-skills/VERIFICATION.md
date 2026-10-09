# 設計與驗收紀錄

這份紀錄供維護 extension 的工程師閱讀。最終程式通過 96 項測試、嚴格型別檢查與真實 Pi 終端驗證。獨立正確性審查通過，註解審查沒有發現問題。

只新增 `inline-skills/`。Pi 本體、其他 extension 的既有變更與依賴設定均未修改，未建立 commit 或 PR。

## 選擇自有選單

沿用 `CustomEditor` 編輯文字，自有 `SelectList` 負責句中候選。只有明確接受操作才記錄引用，送出時透過 `input` handler 載入完整指令。

| 方案 | 決策 |
|---|---|
| 自有選單與公開編輯操作 | 採用。接受同步完成，保留原生編輯器。替換可能需要多次 undo。 |
| 非同步原生補全橋接 | 未採用。需要額外的接受佇列與取消時序。 |
| 搜尋提示文字直接展開 skill | 未採用。無法區分明確選取與普通文字。 |

Model the Domain 原則使候選、已選引用與提交快照分開。Prove It Works 原則要求測到真正的編輯器與 input 展開結果，避免只靠型別檢查判定。

## 開發拆分

- 阻擋步驟先完成。先核對已安裝 API，再比較設計。
- 獨立工作並行。設計稿和審查各有自己的輸出位置。
- 共享寫入序列化。每輪只有一位程式寫入者，其他使用者變更不在範圍內。
- 使用最小安全分工。一個 extension 維護選取與提交狀態，再由獨立審查與 fresh simplifier 驗證。

## 驗證結果

- `node tests/run.mjs` 通過 96 項檢查。涵蓋取消、明確接受、多技能去重、引用修改、歷史紀錄、貼上恢復、讀檔失敗、非同步草稿和生命週期。
- `tsc` 使用 `strict: true`、`noEmit: true` 檢查 extension，結果為結束碼 0。相依宣告使用 `skipLibCheck: true`。
- 真實 Pi 1.1.0 的 fullscreen 與 60 欄 regular 模式通過。驗證 Tab／Enter 只插入、原生指令與檔案補全、完整 skill 正文、reload、阻擋讀檔失敗與重試。
- 測試探針在 input 展開後攔截提交。未發出模型網路請求，沒有用模型回答是否遵循 skill 來推測載入結果。

本機證據位於 `/tmp/pi-inline-skills-20261008/evidence/`。型別檢查設定為 `typecheck.json`，終端驗證腳本為 `parent-runtime.py`，最終獨立判定為 `final-review/acceptance.md`。

## 最終委派結果

| 階段 | Task ID | 結果 |
|---|---|---|
| Fresh code simplifier | `e394db92-ad1b-4f83-8708-97cd09b28de5` | completed。確認兩個程式檔無須進一步修改，重跑全部驗證。 |
| 正確性審查 | `a9cc4823-a70f-4fc7-b371-522067e9ff43` | completed。重跑型別檢查及 96 項測試，未發現必修問題。 |
| 註解審查 | `7bbf39aa-0acc-4cc5-abf0-d0d6be252d8a` | completed。沒有程式註解或檢查抑制指令。 |

部分前期代理工作因超時失敗，另有一份設計的模型回報與設定不符，均未當作通過證據。父層核對留下的程式與重現案例，修正後重新驗證最終檔案；最終審查未使用舊版測試 harness。

## 尚未驗證的範圍

- 未逐一測試所有終端的修飾 Enter 傳輸。tmux 測試畫面提示 extended-keys 未啟用，自訂鍵與 repeat／release 主要由真實編輯器測試涵蓋。
- 未測其他 Pi 版本或所有 extension 組合。其他 extension 若已替換主編輯器，本 extension 會拒絕覆蓋。
- 本 extension 沒有已設定的 lint／formatter，沒有把工具缺席計為檢查通過。
