# RPC subagents 交付狀態

已完成本次核准範圍。所有子代理由真正的 `pi --mode rpc` 執行，沒有 SDK fallback。使用指南見 [README](README.md)，實測與限制見 [驗證紀錄](VALIDATION.md)。

## 實作

- 同步與背景任務，可指定 model、thinking、prompt 及 fresh 或 fork。
- Codemode 可依序 chain 或以 Promise.allSettled 平行呼叫。
- 主 Pi 提供即時 widget 與 `/rpc-subagents` 互動清單。
- Herdr 可按需開啟同一任務的 replay/live viewer，重用 pane，不搶焦點。
- 主 Pi 在線時執行持久排程，支援 at、interval、時區 cron、pause、resume 與取消。取消可選擇中止該排程的 active tasks。
- 關閉主程序清理 owned children、timers 與 owner lock，不接管其他 Pi 的工作。

## 驗證

89 項測試通過，0 fail、0 skip。語法與嚴格型別檢查通過。獨立 source review 沒有剩餘問題。核心 RPC、codemode、同行程 TUI、排程中止與 Herdr 開啟及重用均有實際證據。

含真實 compaction/context_edit 的 fork、cron/DST 活體、跨程序 owner 競態、啟動後對話，以及有執行中任務的 reload 尚未活體驗證。Provider 啟動期等待對話目前明確不支援。

## 交付邊界

依賴已安裝並固定為 croner@9.1.0。沒有修改使用者既有設定、auth 或 pi-subagents，沒有 stage、commit 或 publication。執行紀錄存於私有 data，測試排程已取消，驗證建立的 panes 與程序已清理。此版本其後更名為 `rpc-subagents`；舊 `rpc-fleet` 目錄僅保留既有 `data/`，作為既有安裝的儲存根目錄。
