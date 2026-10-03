# RPC subagents 使用指南

這份指南供已使用 Pi、想管理子代理任務的使用者閱讀。此擴充功能在主 Pi 程序內管理獨立的 `pi --mode rpc` 子程序，沒有 SDK 執行或備援。

已實測同步與背景任務、codemode chain 與平行、一般 fork、排程觸發與中止，以及同行程 fleet UI。Herdr 可開啟執行中任務的唯讀 viewer，重播並追蹤同一份 RPC 事件，第二次開啟會重用 pane 且不搶焦點。測試範圍與尚未活體驗證的情境列於 [驗證紀錄](VALIDATION.md)；本文件不重複列出可能過期的總數。

## 載入擴充功能

1. 保留此目錄於 `~/.pi/agent/extensions/rpc-subagents`。
2. 若要使用 cron，先在此目錄執行 `npm install --ignore-scripts`。依賴固定為 `croner@9.1.0`。runtime 驗證已安裝此版本並保留 lockfile。
3. 在主 Pi 執行 `/reload`。此操作會中止舊 runtime 的 RPC 任務，再載入排程。
4. 執行 `/rpc-subagents` 開啟任務與排程清單。

若目前沒有啟用 codemode，可用一次性的 CLI 選項啟動 Pi，不需改既有設定。

```sh
pi --tools read,bash,edit,write,codemode,rpc_subagents_run,rpc_subagents_status,rpc_subagents_result,rpc_subagents_wait,rpc_subagents_cancel,rpc_subagents_respond,rpc_subagents_pending,rpc_subagents_reply,rpc_subagents_steer,rpc_subagents_view,rpc_subagents_schedule_create,rpc_subagents_schedule_list,rpc_subagents_schedule_pause,rpc_subagents_schedule_resume,rpc_subagents_schedule_cancel
```

`--tools` 是完整 allowlist，漏列的 extension 工具連 codemode 都無法呼叫。上面列出全部 15 個名稱，不含只存在於 child 的 model-only `rpc_subagents_parent`。若你的既有設定已用 `defaultTools: ["+codemode"]` 啟用 codemode，直接執行 `pi` 即可保留預設與 extension 工具；本擴充功能不修改設定。

擴充功能只註冊 `rpc_subagents_*` 工具，全部使用 `exposure: "codemode"`。它不更動主 session 的 active tools。

## 儲存位置與舊版資料路徑

runtime 資料（tasks、projects、schedules、templates）放在 `data/`。程式碼更名為 `rpc-subagents` 後，若同一層仍有舊的 `rpc-fleet/data`，擴充功能會繼續把它當作儲存根目錄，既有受管理 session、catalog 與 schedule template 的絕對路徑因此不變，不需搬移、symlink 或改寫 catalog。全新安裝沒有舊目錄時，才使用 `rpc-subagents/data`。這個判斷在第一次需要 runtime 時才進行，不在註冊階段讀取檔案系統。舊的 `rpc-fleet` 目錄只保留 `data/`，不應再載入其中的程式碼；`rpc-fleet` 舊名稱只存在於這個儲存路徑，工具、command 與 skill 都不提供舊名稱別名。

## 載入 agent 操作 skill

擴充功能透過 `resources_discover` 提供內附的 [rpc-subagents skill](skills/rpc-subagents/SKILL.md)。主 Pi 啟動或 `/reload` 後會將名稱與觸發描述加入可用 skills，agent 在操作 RPC 任務、排程或 viewer 時按需讀取。

需要明確載入時，執行 `/skill:rpc-subagents`。不需修改設定或另外安裝 skill。此 skill 供主代理使用，RPC child 不會繼承它。

## 找到工具

在 codemode 執行下列程式。

```js
text(await searchTools("rpc_subagents", { namespace: "rpc_subagents" }));
text(await describeTool("rpc_subagents_run"));
text(await describeNamespace("rpc_subagents"));
```

## 串接同步任務

同步是預設行為。工具等待 `agent_settled`，再回傳包含 `status`、`text` 與 `taskId` 的物件。`agent_end` 或 prompt 接受回應都不是完成訊號。

```js
const first = await tools.rpc_subagents_run({
	name: "Review",
	prompt: "Review the current project and summarize the main risks.",
	context: "fork"
});
if (first.status !== "completed") throw new Error(first.error ?? first.status);
const second = await tools.rpc_subagents_run({
	name: "Checklist",
	prompt: `Turn these findings into a short checklist: ${first.text}`,
	context: "fresh"
});
return { first: first.taskId, status: second.status, text: second.text };
```

省略 `model` 時，擴充功能擷取目前 `ctx.model` 的 provider 與 ID，明確傳給 child。你也可以傳入 `model: { provider: "<provider>", id: "<exact-model-id>" }` 與 `thinking: "high"`。child 必須回報相同模型及支援的 thinking level，否則任務失敗，不使用其他模型或 SDK fallback。

## 平行執行

所有任務共用指定的 `cwd`。平行寫入同一檔案會發生碰撞。此擴充功能不建立 worktree，也不鎖住專案檔案。

```js
const results = await Promise.allSettled([
	tools.rpc_subagents_run({ name: "Tests", prompt: "Inspect test coverage without editing files." }),
	tools.rpc_subagents_run({ name: "API", prompt: "Inspect public API consistency without editing files." })
]);
return results;
```

## 執行背景任務

`async: true` 在本機佇列接受任務後立即回傳 ID。回傳 `queued` 不代表 child 已完成啟動或 provider 已成功接受 prompt。請用 `status` 或 `wait` 取得後續結果。

```js
const task = await tools.rpc_subagents_run({
	name: "Background review",
	prompt: "Inspect the project and report issues without editing files.",
	async: true,
	timeoutMs: 1800000
});
store("reviewTask", task.taskId);
return { taskId: task.taskId, status: task.status };
```

```js
const taskId = load("reviewTask");
const result = await tools.rpc_subagents_wait({ taskId, timeoutMs: 60000 });
return { taskId, status: result.status, text: result.text };
```

`rpc_subagents_wait` 的期限只限制這次等待，不取消背景任務。codemode 結束或中止等待也不停止刻意分離的背景任務。同步 `run` 的 AbortSignal 則會取消 child，完成有限期限的程序清理後才結束呼叫。

## 指定子任務工具

`tools` 可換掉 child 的預設工具清單。預設是 `read`、`write`、`edit`、`bash`、`codemode`；傳入自訂陣列會完整取代預設，傳 `[]` 表示不提供執行工具。`rpc_subagents_parent` 由 child 端另外以 model-only 加入，不受 `tools` 影響。

```js
const task = await tools.rpc_subagents_run({
	name: "Read-only review",
	prompt: "Inspect the API without edits. Report concrete risks.",
	tools: ["read", "bash"]
});
return task;
```

`webAccess` 是獨立於上述五個預設工具的能力：省略 `tools` 時預設為 `true`；明確提供自訂 `tools`（包含 `[]`）時預設為 `false`。可明確設定 `webAccess: true` 加入網路能力，或 `false` 關閉。排程會保存此選項；舊排程已有明確 `tools` 時不會自動加入網路能力。

啟用時只載入已安裝的本機 `pi-web-access` 入口，不下載、安裝套件或開啟其他 extension。沿用既有設定與繼承的憑證；支援 `auto`、`dynamic`、`eager`、重新命名及停用工具。若有可用的 `web_enable`，child 依其 prompt 指示自行啟用；eager 模式不要求 loader。`capabilities.webTools` 列出核准的設定工具，`active`／`reachable` 在啟用後更新。套件、入口、factory 缺失或全部工具停用時，任務明確失敗，不宣稱可用。`--tools` 包含完整精確的核准 family，parent 仍拒絕其他額外可呼叫工具。

這只是工具清單，不是沙箱。child 與主程序同權限，仍可能依 prompt 指示或其他路徑碰觸檔案。需要隔離時請自行限制工作目錄與指令。排程的 `tools` 同樣會保存，並在每次觸發時沿用，包含 `[]`。

### `safe-pi` 與 append-path

子程序直接以 Node 啟動目前安裝的 Pi CLI。父 Pi 若由 `safe-pi` 啟動，子程序會繼承既有沙箱及啟動時的 `--append-path` 授權，不需要重新執行 wrapper 或重播參數。父程序直接使用 Pi 時，擴充功能不額外建立沙箱。

已用實際 `safe-pi` 與正式 RPC transport 測試：兩個 append 目錄（含空白路徑）在父、子 Pi 都可寫入，未授權的合成目錄則都回報 `EPERM`。子程序變更 cwd 後結果相同；指定未授權 cwd 時會啟動失敗。這項測試只驗證上述檔案權限，未涵蓋網路政策；完整 manager 在沙箱內的額外測試遭中止，未列為通過。詳見 [驗證紀錄](VALIDATION.md)。

## 子任務提問與回報

child 可用 model-only 的 `rpc_subagents_parent` 向主 session 提問（`kind: "ask"`）或單向回報（`kind: "report"`）。只有 `async: true` 的任務能提問；同步任務會立即得到 `requires_async`，不會阻塞等待。

新的提問會讓主 Pi 收到一次 follow-up 喚醒（同一 taskId 與 requestId 只喚醒一次），訊息只帶 ID，要求主代理自行查看並明確回覆。主代理用 `rpc_subagents_pending` 讀取待處理請求與回報，再用 `rpc_subagents_reply` 回答。回報不會喚醒模型，只在 `pending` 中出現。

```js
const pending = await tools.rpc_subagents_pending({ taskId: load("reviewTask") });
text(pending.requests);
return await tools.rpc_subagents_reply({
	taskId: load("reviewTask"),
	requestId: pending.requests[0].requestId,
	value: "Use the existing test fixture; do not edit shared files."
});
```

無法回答時傳 `cancelled: true`。child 的問題是未受信任的請求，不是批准；擴充功能不自動回答、不自動核准敏感操作。答案上限 65536 字元；child 的提問上限 8192 字元，等待時間 1 秒至 120 秒（預設 120 秒），逾期由擴充功能代為取消。每個任務同時最多 16 個待處理請求，回報保留最近 64 筆；`pending` 的 `after` 與 `limit` 可續讀回報尾端。

## 引導執行中的任務

`rpc_subagents_steer` 對已接受且正在串流的 live 任務送出原生 RPC steer。回傳的 `disposition` 為 `handled` 或 `queued`，只代表 child 收下訊息，不代表已消費；它不會重試，也不能解除等待中的提問。

```js
return await tools.rpc_subagents_steer({ taskId: load("reviewTask"), message: "Stop expanding scope; finish the current file." });
```

## 續接已完成的工作階段

`session` 可續接同一個受管理的已完成工作階段，而不是開新 context。可傳 child 回報的 session ID，或該受管理 session 的完整絕對 `.jsonl` 路徑。`session` 與 `context` 互斥。

```js
const first = await tools.rpc_subagents_run({ name: "First", prompt: "Start the review.", context: "fresh" });
const second = await tools.rpc_subagents_run({ name: "Continue", prompt: "Continue from your last review.", session: first.sessionId });
return { first: first.taskId, second: second.taskId, continuedFrom: second.continuedFromTaskId };
```

續接會產生新的 `taskId`，但沿用原本的 session ID 與檔案，且要求完全相同的 cwd 與 model。同一時間只有一個 writer lease：同檔續接若已被租用會快速失敗，不排隊等待。清理或保存結果不確定時，擴充功能保留 lease 並標記 `sessionReusable: false`，需人工檢查後才能再次續接。不支援任意接手其他 session。排程不支援 `session`，建立與還原都會拒絕。

```js
return await tools.rpc_subagents_cancel({ taskId: load("reviewTask") });
```

取消可重複呼叫。排隊或準備中的任務不再啟動。待回應對話只嘗試拒絕，不等待 stdin 寫入才開始取消；每筆 stdin 寫入（含佇列等待）最多 1 秒。執行中的任務先嘗試送出 `clear_queue`、`abort`，再關閉 stdin，必要時升級為 SIGTERM 與 SIGKILL。

## 回應子程序對話

child 完成啟動後若提出 `confirm`、`select`、`input` 或 `editor`，任務會顯示 `waiting_input`。擴充功能不自動核准。

目前安裝路徑 0.99.2（manifest 1.0.0）的 Pi RPC 仍先等待 `session_start`，再安裝 stdin reader。因此 **provider 在 `session_start` 等待使用者對話的啟動流程不受支援**：即使送出回應，Pi 也尚未讀取；啟動 handshake 最多 30 秒後失敗並終止 child，總任務期限若較短則更早失敗。請使用不需啟動期對話的 provider。只有啟動後的對話支援明確回應，不自動核准、不改走 SDK。

在 `/rpc-subagents` 選取任務，按 `r` 顯示原始請求。也可以先讀取 `rpc_subagents_status` 的 `state.dialogs`，再明確回應其 ID。

```js
return await tools.rpc_subagents_respond({
	taskId: "<task-id>",
	dialogId: "<pending-dialog-id>",
	cancelled: true
});
```

確認對話使用 `confirmed: true` 或 `false`。其他對話使用 `value`，`select` 的值必須是原始選項之一。未回應的對話最多等待 120 秒，之後送出匹配 ID 的取消回應。child 自訂的較短 timeout 仍有效。非互動環境也使用同樣的拒絕政策，不留下不可見的無限等待。

`rpc_subagents_respond` 只處理一般 UI 對話，`dialogId` 必須來自 `state.dialogs`。協調請求使用 `state.requests` 的 `requestId` 與 `rpc_subagents_reply`；把協調 requestId 傳給 `rpc_subagents_respond` 會被拒絕。任務只有協調請求、沒有一般對話時，`/rpc-subagents` 的 `r` 仍可顯示請求內容（已去除終端控制序列）並送出回答，取消則送出 `{cancelled:true}`；一般對話與協調請求同時存在時，`r` 先處理一般對話。

## 建立排程

`rpc_subagents_schedule_list` 只讀既有 owner 或磁碟快照；查詢另一個 cwd 不取得 lock、不啟動 timer、不修改資料。`session_start` 與明確排程管理操作才啟動該 cwd 的 owner。

排程只在有主 Pi owner 的時候執行。建立時間的 fork 是不可變範本，每次觸發再建立新的 child session。後來的主 session 對話不會改變範本。

```js
const schedule = await tools.rpc_subagents_schedule_create({
	name: "Later review",
	task: {
		name: "Scheduled review",
		prompt: "Review the captured context and summarize the remaining work.",
		context: "fork"
	},
	trigger: { type: "at", at: "+10m" }
});
store("reviewSchedule", schedule.scheduleId);
return schedule;
```

定期排程把 `trigger` 改為 `{ type: "interval", every: "30m" }`。cron 使用五個欄位，並明確指定 IANA 時區。

```js
return await tools.rpc_subagents_schedule_create({
	task: { prompt: "Inspect the project and report its current test status." },
	trigger: { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Taipei" }
});
```

一次性絕對時間需要 `Z` 或 UTC offset，例如 `2027-01-01T09:00:00+08:00`。每個排程只能有一種 trigger。

```js
const scheduleId = load("reviewSchedule");
await tools.rpc_subagents_schedule_pause({ scheduleId });
await tools.rpc_subagents_schedule_resume({ scheduleId });
return await tools.rpc_subagents_schedule_cancel({ scheduleId, abortRunning: true });
```

`pause` 不停止既有任務。`cancel` 不復活排程。`abortRunning: true` 只取消該排程自己的 active task IDs。在互動畫面的排程頁，`p` 暫停或恢復，`c` 只取消未來觸發，`a` 取消並中止既有任務。

排程任務不支援 `session`：建立時在取得 owner 前即拒絕，還原持久化資料時也會 fail closed。排程保存的 `tools` 會原樣沿用，包含 `[]`。

重新載入後，過期的一次性排程標記為 `missed`。重複排程只安排嚴格晚於現在的觸發，不補跑離線期間的工作。同一排程若已有排隊或執行中的任務，略過當次觸發。

## 開啟唯讀檢視器

在 Herdr 中執行 `/rpc-subagents-view <task-id>`，或在任務清單按 `v`。檢視器以獨立 Node 程序重播並追蹤該任務的 `events.jsonl`，不重新執行模型。

Herdr opener 要求 `HERDR_ENV=1`。它保存呼叫者的 `HERDR_PANE_ID`，只在身分未改變時使用已查驗的 `pane split --current ... --no-focus`。不省略 target，不追隨 UI 焦點，也不關閉其他 pane。已建立且仍存在的 pane 才能重用。

自動右側或下方分割讀取 `pane layout --pane <saved-id>` 回應中的 `result.layout.panes[]`，以 `pane_id` 找到呼叫者並使用 `rect.width`／`rect.height`；亦相容舊的 geometry 格式。此形狀與 opener 已在 Herdr 0.9.3 實測，首次回傳 `opened`，再次開啟同一任務回傳相同 pane ID 與 `reused: true`。若自動判斷失敗，可明確選擇方向，仍不得指定另一個未查驗的 caller。

```js
return await tools.rpc_subagents_view({ taskId: "<task-id>", direction: "right" });
```

opener 不可用時，回傳 `status: "unavailable"`、原因與已 quote 的獨立 viewer 指令。在一般終端執行該指令即可看同一份記錄。關閉 viewer 不會取消任務。較早超過 1 MiB 的記錄會顯示略過提示。viewer 會移除 terminal escape、控制字元及跨 delta 分段的 escape sequence；大型結果或記錄額度耗盡仍有小型終端標記，尾段略過大型終端事件時也會讀取 state.json 確認完成後結束。

## 加入額外 provider bootstrap

這些 bootstrap 來源必須能在不等待啟動期使用者對話的情況下完成 `session_start`。

已存在的 `~/.pi/agent/extensions/deepinfra-provider` 與 `opencode-provider` 會自動加入明確 allowlist。child 使用 `--no-extensions --no-skills --no-prompt-templates`，只額外載入這些來源、child bridge，以及任務啟用網路能力時的受控 web wrapper。

若需要其他 provider，複製 `config.example.json` 為本目錄的 `config.json`。在指定 canonical cwd 的 `providerSources` 加入本機路徑。相對路徑以 rpc-subagents 目錄為基準。擴充功能不掃描任意 extension 來猜測 provider，也不安裝來源或修改使用者設定。

## 執行靜態與單元檢查

```sh
RPC_SUBAGENTS_PI_PACKAGE=/absolute/path/to/@earendil-works/pi-coding-agent \
  npm test --prefix ~/.pi/agent/extensions/rpc-subagents
npm run check --prefix ~/.pi/agent/extensions/rpc-subagents
RPC_SUBAGENTS_PI_PACKAGE=/absolute/path/to/@earendil-works/pi-coding-agent \
  node ~/.pi/agent/extensions/rpc-subagents/test/typecheck.mjs
```

型別檢查需要 PATH 上已有 `tsc`，只讀取指定 Pi 的宣告檔，不執行 Pi。指定 `RPC_SUBAGENTS_PI_PACKAGE` 的測試會使用該安裝的純 context projection 與 TUI 寬度工具，不建立 Pi session 或執行模型。未指定 package 時這些測試明確略過；cron DST 測試在缺少依賴時明確略過。測試使用假 RPC process 與可控時計，不呼叫 provider API 或 Herdr CLI。

完整狀態、儲存與限制見 [參考文件](REFERENCE.md)。實測範圍與證據見 [驗證紀錄](VALIDATION.md)。
