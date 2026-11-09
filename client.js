/**
 * @local/dsh-engine-switch —— 客户端半边（浏览器 bundle）
 *
 * 这是 L6 的交付物：把「引擎」做成**主会话框上的独立下拉 Chip**（Engine ⊥ Preset 的 UI 面），
 * 与 Agent 预设（标准 / PTC / 极简 / 创造）并排展示，两者互不绑架。
 *
 * ── 它挂在哪两个官方插槽上 ────────────────────────────────────────────────
 *
 *   ① `conversation.hero.options`（order 30）—— 新会话起始页那一行右侧的选项区，
 *      与「工作目录」chip / Agent 预设同排（DSH 官方契约：list/session，
 *      "Compact options right-aligned in the New Session row after the workspace and preset controls"）。
 *   ② `conversation.input.dock`（order 30）—— 输入框卡片**上方**的通栏区
 *      （同上契约："Full-width entries above the composer card"，宿主自己的
 *      QueueDock / TodoDock / GoalDock 就在这一排）。即老板说的「主会话框上方」。
 *
 *   点击 Chip 弹出的选择面板挂在 ③ `shell.overlay`（整帧浮层，list/root）——
 *   官方契约原话："Frame-wide floating layer, above every column and outside their scroll
 *   containers… entries order among themselves. The layer itself is click-through — entries
 *   opt back into pointer events"。所以浮层**不往 document.body 追加 DOM**，
 *   也规避了「输入框附近有 transform 容器，position:fixed 会被就地收住」这个坑。
 *
 * ── 它写的是哪一个值（与 host 侧同源，不是第二套权威）─────────────────────
 *
 * 引擎选择器的权威值是 **本插件自己的 profile entry 的 volatile 字段 `engine`**
 * （见 index.js 的 `Config.engine`）。三个入口写的是同一个值：
 *   ① `/engine <native|pi|echo>` 斜杠命令（host 侧 registerEngineCommand）
 *   ② 设置页里的 engine 字段
 *   ③ **本 Chip**（走 `ctx.remote.settings.update(ns, {engine}, revision)`）
 *
 * 为什么客户端不用自定 Typert remote、也不用自开 HTTP 路由：`ctx.remote.settings`
 * 是 DSH 给浏览器半边准备的**通用设置写入口**（`@deepseek-ai/dsh-api-settings-controller`
 * 生成的 namespace），官方自己的 `dsh-client-ui-permission-presets` 写
 * `defaultPreset` 用的就是这条：`remote.settings.mutate(ns, [{op:'set',…}], revision)`。
 * 第三方插件无需自带生成物即可写回 host，且带 revision 乐观锁（陈旧写入会被拒而不是覆盖别人）。
 *
 * ── 语义边界（诚实说明，与 host 侧 README 一致）─────────────────────────
 *
 * 引擎是**建 Agent 那一刻**定下来的（第三方插件没有活体换装口，见
 * ENGINE-SELECTOR-EVIDENCE.md §4.2）。所以这个 Chip 的语义是
 * **「接下来的任务用哪个引擎」**，不是「当前任务换引擎」：
 * 已经跑着的会话不受影响，它在下次被 DSH 重新载入（重启桌面端 / 重新打开该任务）时才跟随。
 * 面板上的提示文案如实这么写，不假装当场生效。
 *
 * ── 失败面纪律（这条决定桌面端能不能起来）───────────────────────────────
 *
 * 客户端 bundle 是 **boot 关键路径**：任何一条 client 条目 `import failed` 或
 * `pending`（等一个不存在的服务），整页会停在 "Failed to load plugins"。所以：
 *   - 本文件只能 `require("react")` / `require("react/jsx-runtime")`（平台种子表内的两项）；
 *   - `apply` 里不做任何可能抛出的动作，slot 注册与事件订阅全部包在 effect 里；
 *   - settings 服务是**可选依赖**：拿不到就渲染「不可用」并在面板里说清原因，
 *     绝不抛、绝不把整页拖下水（也不硬 inject `remote.settings`，避免它缺席时本条目 pending）。
 */

window.__ModuleLoader__.load({
	id: "@local/dsh-engine-switch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");

		/** 本地化字典命名空间。 */
		const NS = "engineSwitch";
		/**
		 * settings 命名空间名 = 本插件在 profile 里的 **entry id**。
		 * 与 host 侧 `DEFAULT_ENTRY_ID`（index.js）必须同值 —— 两边写的是同一个值，
		 * 名字漂了就会出现「UI 显示 A、命令写 B」的哑火。测试里有一条断言钉死这个等式。
		 */
		const SETTINGS_NS = "engine-switch";
		/**
		 * 认下来的引擎取值：与 host 侧 `engine-intent.mjs` 的 `ENGINE_IDS` 逐字同源。
		 * 这里再写一份是**客户端侧的第一道闸**（负向防误杀）：只有精确取值才发写请求，
		 * `'PI'` / `'pi '` / `'pi-lite'` / 空串 / 非字符串一律当场拒掉，不落到 host。
		 */
		const ENGINE_IDS = ["native", "pi", "echo"];
		/** 缺省引擎（与 host 的 `NATIVE_ENGINE_ID` 同值）。 */
		const NATIVE_ENGINE_ID = "native";

		/**
		 * 引擎取值归一化：只承认精确的 native / pi / echo。
		 * @param value 候选取值（来自 UI、来自 settings 文档、或来自调用方）
		 * @returns 归一化后的引擎 id，或不作数时的 null
		 */
		function normalizeEngineId(value) {
			return typeof value === "string" && ENGINE_IDS.indexOf(value) !== -1 ? value : null;
		}

		/** 把任意抛出物拍成一行可读文本（错误处理快速失败 + 说清原因，不静默吞）。 */
		function messageOf(error) {
			if (error === null || error === undefined) return "unknown failure";
			if (typeof error === "string") return error;
			return typeof error.message === "string" && error.message.length > 0 ? error.message : String(error);
		}

		/** 客户端 Remote 的失败信封：`{ok:false, error:{code, message}}`。 */
		function errorCodeOf(error) {
			return error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "remote-failed";
		}
		function errorMessageOf(error) {
			return error !== null && typeof error === "object" && typeof error.message === "string"
				? error.message
				: messageOf(error);
		}

		const zh = {
			chipPrefix: "引擎",
			// 「标签 + 值」的分隔符按语言取：中文全角冒号，英文 ": "（硬编码会让英文界面出现全角冒号）。
			chipSeparator: "：",
			chipTitle: "选择引擎（预设管内容面，引擎管底座，两者互不影响）",
			chipLoading: "读取中…",
			chipUnavailable: "不可用",
			pickerTitle: "选择引擎",
			pickerHint: "改的是本插件的 engine 选择器 —— 与输入框里敲 /engine 写的是同一个值。",
			pickerEffective: "对之后新建的任务生效；已经跑着的会话保持原引擎，重启桌面端重新载入后才跟随。",
			pickerOrthogonal: "Agent 预设（标准 / PTC / 极简 / 创造）不受影响：引擎与预设是两个正交维度。",
			pickerCurrent: "当前",
			pickerClose: "关闭",
			pickerBusy: "正在写入…",
			pickerFailed: "写入失败",
			pickerUnavailable: "读不到引擎选择器",
			pickerUnavailableHint: "settings 服务或 engine-switch 命名空间不在，本 Chip 暂时只能看不能改。检查设置 → 插件里本插件是否启用。",
			engineNative: "原生引擎",
			engineNativeHint: "DSH 自带的 AgentLoop：工具卡、流式输出、中断都完整",
			enginePi: "Pi 引擎",
			enginePiHint: "OAR 驱动的 Pi 子进程；模型列表跟着 Pi 走（模型选择器里出现「Pi」模型组）",
			engineEcho: "回声引擎",
			engineEchoHint: "只回显固定文本、不起模型，联调专用",
		};

		const en = {
			chipPrefix: "Engine",
			chipSeparator: ": ",
			chipTitle: "Pick the engine (the preset owns the content side, the engine owns the driver)",
			chipLoading: "Loading…",
			chipUnavailable: "Unavailable",
			pickerTitle: "Pick an engine",
			pickerHint: "This writes the plugin's engine selector — the same value the /engine command writes.",
			pickerEffective: "Applies to tasks created from now on; a running Session keeps its engine until the desktop reloads it.",
			pickerOrthogonal: "The Agent preset (Standard / PTC / Minimal / Cordis) is unaffected: engine and preset are orthogonal.",
			pickerCurrent: "current",
			pickerClose: "Close",
			pickerBusy: "Saving…",
			pickerFailed: "Write failed",
			pickerUnavailable: "The engine selector is unavailable",
			pickerUnavailableHint: "The settings service or the engine-switch namespace is absent, so this chip is read-only for now. Check that the plugin is enabled under Settings → Plugins.",
			engineNative: "Native engine",
			engineNativeHint: "DSH's own AgentLoop: tool cards, streaming and aborts all work",
			enginePi: "Pi engine",
			enginePiHint: "A Pi subprocess driven by OAR; the model list follows Pi (a «Pi» model group appears in the model picker)",
			engineEcho: "Echo engine",
			engineEchoHint: "Echoes fixed text without calling a model — for wiring checks",
		};

		/** 每个引擎的展示名与一句话说明（文案只有这一处来源）。 */
		const ENGINE_TEXT = {
			native: { label: "engineNative", hint: "engineNativeHint" },
			pi: { label: "enginePi", hint: "enginePiHint" },
			echo: { label: "engineEcho", hint: "engineEchoHint" },
		};

		const styles = {
			// 插槽外壳：与「工作目录」chip 同排时不能撑满（hero 那一行是 inline 流），
			// 而在输入框上方的通栏里要占满整行、把胶囊放在右端（与宿主自己的 Queue/Todo/Goal 同款对齐）。
			chipRowInline: {
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
			},
			chipRowDock: {
				display: "flex",
				justifyContent: "flex-end",
				alignItems: "center",
				gap: "6px",
				width: "100%",
			},
			chipButton: {
				font: "inherit",
				fontSize: "12px",
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				padding: "4px 10px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, inherit)",
				cursor: "pointer",
				maxWidth: "240px",
			},
			chipButtonUnavailable: {
				font: "inherit",
				fontSize: "12px",
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				padding: "4px 10px",
				borderRadius: "999px",
				border: "1px dashed var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-label-tertiary, inherit)",
				cursor: "pointer",
				maxWidth: "240px",
			},
			chipLabel: {
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			},
			// 选择浮层：fixed 居中，挂在 shell.overlay 上（不占输入框旁边的位置）。
			modalBackdrop: {
				position: "fixed",
				inset: "0",
				zIndex: 1000,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: "24px",
				background: "rgba(0, 0, 0, 0.35)",
			},
			modalPanel: {
				width: "min(460px, 100%)",
				maxHeight: "min(70vh, 560px)",
				overflowY: "auto",
				padding: "16px",
				borderRadius: "14px",
				background: "var(--dsw-alias-bg-layer, #fff)",
				color: "var(--dsw-alias-label-primary, #111)",
				boxShadow: "0 12px 40px rgba(0, 0, 0, 0.28)",
				display: "flex",
				flexDirection: "column",
				gap: "10px",
			},
			modalHeading: { margin: 0, fontSize: "14px", fontWeight: 600 },
			hint: {
				margin: 0,
				fontSize: "12px",
				lineHeight: "18px",
				color: "var(--dsw-alias-label-secondary, inherit)",
			},
			modalList: { display: "flex", flexDirection: "column", gap: "6px" },
			pickerItem: {
				font: "inherit",
				fontSize: "13px",
				textAlign: "left",
				padding: "8px 12px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				display: "flex",
				flexDirection: "column",
				gap: "2px",
			},
			pickerItemActive: {
				font: "inherit",
				fontSize: "13px",
				textAlign: "left",
				padding: "8px 12px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-state-business-primary, #4b7bec)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				display: "flex",
				flexDirection: "column",
				gap: "2px",
			},
			pickerItemName: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 500 },
			pickerItemBadge: {
				fontSize: "11px",
				padding: "1px 6px",
				borderRadius: "999px",
				border: "1px solid var(--dsw-alias-state-business-primary, #4b7bec)",
				color: "var(--dsw-alias-state-business-primary, #4b7bec)",
			},
			pickerItemHint: {
				fontSize: "12px",
				lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary, inherit)",
			},
			messageError: {
				margin: 0,
				fontSize: "12px",
				lineHeight: "18px",
				color: "var(--dsw-alias-state-error-primary, #d64545)",
			},
			button: {
				font: "inherit",
				fontSize: "12px",
				padding: "6px 12px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				alignSelf: "flex-start",
			},
		};

		// ── 读 / 写：settings 命名空间（唯一权威值） ──────────────────────────

		/**
		 * 取本页的 settings Remote 命名空间。
		 *
		 * 用 `ctx.get(...)` 而不是 `inject`：它是**可选依赖**——拿不到时本条目照常激活
		 * （渲染「不可用」），而不是把整页卡在 "entries did not activate"。
		 * 优先取宿主注册的同名服务（`remote.settings`），取不到再从 `remote` 服务上下钻。
		 * @param ctx 浏览器插件上下文
		 * @returns settings Remote 命名空间，或缺席时的 undefined
		 */
		function settingsServiceOf(ctx) {
			if (ctx === null || ctx === undefined || typeof ctx.get !== "function") return undefined;
			let direct;
			try {
				direct = ctx.get("remote.settings");
			} catch {
				direct = undefined;
			}
			if (direct !== null && direct !== undefined) return direct;
			let remote;
			try {
				remote = ctx.get("remote");
			} catch {
				remote = undefined;
			}
			const nested = remote === null || remote === undefined ? undefined : remote.settings;
			return nested === null || nested === undefined ? undefined : nested;
		}

		/**
		 * 在 `settings.describe()` 的结果里定位本插件的命名空间。
		 *
		 * 两级判据：
		 *   ① 按名字（`engine-switch`，= 本插件在 profile 里的 entry id）—— 常态命中；
		 *   ② 按**形状**兜底：命名空间里有一个值属于已知引擎取值的 `engine` 字段。
		 *      这条是给「fork 出去用别的 entry id 装载」准备的：命名空间名会跟着 entry id 变，
		 *      而 descriptor 的形状不变。判据要求取值**精确属于** ENGINE_IDS，
		 *      所以别的插件里恰好叫 engine 的字段（例如 `{engine: "v8"}`）不会被误认。
		 * @param described `describe()` 的 value（`{writable, hasDocument, namespaces}`）
		 * @returns `{row, source}` 或 null
		 */
		function locateSettingsNamespace(described) {
			const rows = described !== null && typeof described === "object" && Array.isArray(described.namespaces)
				? described.namespaces
				: [];
			const byId = rows.find((row) => row !== null && typeof row === "object" && row.ns === SETTINGS_NS);
			if (byId !== undefined) return { row: byId, source: "id" };
			const byShape = rows.find((row) => nodeEngineOf(row) !== null);
			return byShape === undefined ? null : { row: byShape, source: "shape" };
		}

		/** 从一个命名空间视图里读归一化后的 engine 取值（读不到 ⇒ null）。 */
		function nodeEngineOf(row) {
			if (row === null || row === undefined || typeof row !== "object") return null;
			const value = row.value;
			if (value === null || typeof value !== "object") return null;
			return normalizeEngineId(value.engine);
		}

		/** 从一个命名空间视图里读 revision（乐观锁用；缺失 ⇒ undefined = 无条件写）。 */
		function revisionOf(row) {
			return row !== null && typeof row === "object" && typeof row.revision === "number" ? row.revision : undefined;
		}

		/**
		 * 读引擎选择器。
		 * 不抛：失败以 `{ok:false, error, detail?}` 返回，由 UI 翻成人话。
		 * @param ctx 浏览器插件上下文
		 * @returns Promise<{ok:true, value:{engine, ns, revision, writable, source}} | {ok:false, error:string, detail?:string}>
		 */
		async function readEngineSelector(ctx) {
			const settings = settingsServiceOf(ctx);
			if (settings === undefined || typeof settings.describe !== "function") {
				return { ok: false, error: "settings-unavailable" };
			}
			let response;
			try {
				response = await settings.describe();
			} catch (error) {
				return { ok: false, error: "read-failed", detail: messageOf(error) };
			}
			if (response === null || typeof response !== "object") {
				return { ok: false, error: "read-failed", detail: "malformed describe payload" };
			}
			if (response.ok !== true) {
				return { ok: false, error: errorCodeOf(response.error), detail: errorMessageOf(response.error) };
			}
			const described = response.value;
			const located = locateSettingsNamespace(described);
			if (located === null) {
				return { ok: false, error: "namespace-unavailable", detail: SETTINGS_NS };
			}
			return {
				ok: true,
				value: {
					// 命名空间在、但值不是三个精确取值之一时如实返回 null（例如配置写错了），
					// 而不是猜一个 —— 猜出来的值会被用户当成「当前选择」。
					engine: nodeEngineOf(located.row),
					ns: located.row.ns,
					revision: revisionOf(located.row),
					writable: described === null || typeof described !== "object" || described.writable !== false,
					source: located.source,
				},
			};
		}

		/**
		 * 写引擎选择器（与 host 侧 `writeEngineSelector` 同语义、同权威值）。
		 *
		 * 取值纪律在**这里就先挡一道**：近似/未知取值不落盘，直接 `unknown-engine` 返回，
		 * 与 host 侧 `/engine` 命令的负向行为逐字一致（负向防误杀）。
		 *
		 * @param ctx 浏览器插件上下文
		 * @param engine 目标引擎（`native` / `pi` / `echo`）
		 * @param target `{ns?, revision?}`：写哪个命名空间、带哪个 revision（乐观锁）
		 * @returns Promise<{ok:true, value:{engine, ns, revision}} | {ok:false, error:string, token?:string, detail?:string}>
		 */
		async function writeEngineSelector(ctx, engine, target = {}) {
			const normalized = normalizeEngineId(engine);
			if (normalized === null) return { ok: false, error: "unknown-engine", token: String(engine) };
			const settings = settingsServiceOf(ctx);
			if (settings === undefined || typeof settings.update !== "function") {
				return { ok: false, error: "settings-unavailable" };
			}
			const ns = typeof target.ns === "string" && target.ns.length > 0 ? target.ns : SETTINGS_NS;
			let response;
			try {
				response = await settings.update(ns, { engine: normalized }, target.revision);
			} catch (error) {
				return { ok: false, error: "write-failed", detail: messageOf(error) };
			}
			if (response === null || typeof response !== "object") {
				return { ok: false, error: "write-failed", detail: "malformed update payload" };
			}
			if (response.ok !== true) {
				// host 的拒绝（settings/conflict = revision 陈旧、settings/rejected = 组合层不认）原样带出。
				return { ok: false, error: errorCodeOf(response.error), detail: errorMessageOf(response.error) };
			}
			const view = response.value;
			const engineNow = nodeEngineOf(view);
			return {
				ok: true,
				value: {
					// 写答案里就带着新值；读出不来（极端情况）时回落到刚写进去的值，并记为 null 让 UI 重读。
					engine: engineNow === null ? normalized : engineNow,
					ns: view !== null && typeof view === "object" && typeof view.ns === "string" ? view.ns : ns,
					revision: revisionOf(view),
				},
			};
		}

		// ── 选择器状态：两个插槽里的 Chip 与浮层共用一份 ──────────────────────

		/**
		 * 引擎选择器的共享快照（一个极简 store）：
		 * 读、写、乐观锁、失败文案都收在这里，组件只做渲染。
		 *
		 * 为什么不做成「每个 Chip 各自 fetch」：hero 那一行与输入框上方是**两个独立插槽组件**，
		 * 各读一次会出现同一屏两个 Chip 短暂不同步；而写盘只有一个权威值，
		 * 两份状态就是两份真话。store 由 `apply` 挂 reader（见 attachBridge）。
		 */
		function createSelectorStore() {
			let snapshot = {
				status: "idle", // idle | loading | ready | unavailable
				engine: null,
				ns: SETTINGS_NS,
				revision: undefined,
				writable: true,
				source: null,
				error: null,
				detail: null,
				busy: false,
			};
			const listeners = new Set();
			let bridge = null;
			let inFlight = null;

			const publish = (patch) => {
				snapshot = { ...snapshot, ...patch };
				for (const listener of [...listeners]) {
					try {
						listener(snapshot);
					} catch {
						// 一个订阅者炸掉不该拖垮其它订阅者（渲染层自己会兜住组件异常）。
					}
				}
			};

			const store = {
				get: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				/** 挂上读写桥（apply 调用；卸载时取消订阅）。 */
				attachBridge: (next) => {
					bridge = next;
					return () => {
						if (bridge === next) bridge = null;
					};
				},
				/** 首次挂载时读一次；已有值就不重复读（避免两个 Chip 各打一次）。 */
				ensure: () => {
					if (snapshot.status === "ready" || snapshot.status === "unavailable") return Promise.resolve(snapshot);
					return store.load();
				},
				/** 强制重读（settings 文档变更 / 连接重置 / 打开浮层前）。 */
				load: () => {
					if (inFlight !== null) return inFlight;
					if (bridge === null || typeof bridge.read !== "function") {
						publish({ status: "unavailable", error: "settings-unavailable", detail: null });
						return Promise.resolve(snapshot);
					}
					publish({ status: snapshot.status === "idle" ? "loading" : snapshot.status, error: null, detail: null });
					inFlight = Promise.resolve()
						.then(() => bridge.read())
						.then((result) => {
							if (result === null || typeof result !== "object" || result.ok !== true) {
								const failure = result !== null && typeof result === "object" ? result : {};
								publish({
									status: "unavailable",
									engine: null,
									source: null,
									error: typeof failure.error === "string" ? failure.error : "read-failed",
									detail: typeof failure.detail === "string" ? failure.detail : null,
								});
								return snapshot;
							}
							const value = result.value ?? {};
							publish({
								status: "ready",
								engine: normalizeEngineId(value.engine),
								ns: typeof value.ns === "string" && value.ns.length > 0 ? value.ns : SETTINGS_NS,
								revision: value.revision,
								writable: value.writable !== false,
								source: typeof value.source === "string" ? value.source : null,
								error: null,
								detail: null,
							});
							return snapshot;
						})
						.catch((error) => {
							publish({ status: "unavailable", engine: null, error: "read-failed", detail: messageOf(error) });
							return snapshot;
						})
						.then((value) => {
							inFlight = null;
							return value;
						});
					return inFlight;
				},
				/**
				 * 选中一个引擎并落盘。
				 * 调用方（浮层）只关心 `{ok, error?, detail?}`：ok ⇒ 关掉面板。
				 * @param engine 目标引擎取值
				 */
				select: async (engine) => {
					if (snapshot.busy) return { ok: false, error: "busy" };
					const normalized = normalizeEngineId(engine);
					if (normalized === null) return { ok: false, error: "unknown-engine", token: String(engine) };
					if (bridge === null || typeof bridge.write !== "function") {
						publish({ status: "unavailable", error: "settings-unavailable", detail: null });
						return { ok: false, error: "settings-unavailable" };
					}
					publish({ busy: true, error: null, detail: null });
					let result;
					try {
						result = await bridge.write(normalized, { ns: snapshot.ns, revision: snapshot.revision });
					} catch (error) {
						result = { ok: false, error: "write-failed", detail: messageOf(error) };
					}
					if (result === null || typeof result !== "object" || result.ok !== true) {
						const failure = result !== null && typeof result === "object" ? result : {};
						publish({
							busy: false,
							// 写失败不改当前值：下次重读也还是 host 里真实的那个值。
							error: typeof failure.error === "string" ? failure.error : "write-failed",
							detail: typeof failure.detail === "string" ? failure.detail : null,
						});
						return { ok: false, error: snapshot.error, detail: snapshot.detail };
					}
					const value = result.value ?? {};
					publish({
						busy: false,
						status: "ready",
						engine: normalizeEngineId(value.engine) ?? normalized,
						ns: typeof value.ns === "string" && value.ns.length > 0 ? value.ns : snapshot.ns,
						revision: typeof value.revision === "number" ? value.revision : snapshot.revision,
						error: null,
						detail: null,
					});
					return { ok: true, value: snapshot };
				},
				/** 清掉上一次**写失败**的残留（打开面板时调用，避免旧错误一直挂着）。
				 *
				 * 读不到选择器（`unavailable`）时**不清**：那一条错误本身就是诊断
				 * （settings 服务缺席 / 命名空间不在 / describe 抛了什么），
				 * 擦了之后面板只剩「未知原因」——那等于把唯一一条线索丢掉。
				 */
				dismissError: () => {
					if (snapshot.status === "unavailable") return;
					publish({ error: null, detail: null });
				},
			};
			return store;
		}

		/** 本页共享的选择器 store 与浮层开关。 */
		const selectorStore = createSelectorStore();
		const pickerStore = {
			state: { open: false },
			listeners: new Set(),
			get: () => pickerStore.state,
			set: (patch) => {
				pickerStore.state = { ...pickerStore.state, ...patch };
				for (const listener of [...pickerStore.listeners]) listener();
			},
			subscribe: (listener) => {
				pickerStore.listeners.add(listener);
				return () => pickerStore.listeners.delete(listener);
			},
		};

		/**
		 * 打开选择面板（两个插槽里的 Chip 都走这里）。
		 *
		 * 这里用 `load()` 而不是 `ensure()`：**每次点开都现读一次**。
		 * 一是能盖住「首次读的时候 settings 还没激活 / 读挂了」的瞬时失败（不能永远停在「不可用」），
		 * 二是老板刚在设置页改过值时，面板里的「当前」徽标就是最新的。
		 */
		function openPicker() {
			selectorStore.dismissError();
			selectorStore.load();
			pickerStore.set({ open: true });
		}

		/** 引擎展示名。 */
		function engineLabel(t, engine) {
			const text = engine === null || engine === undefined ? undefined : ENGINE_TEXT[engine];
			return text === undefined ? null : t(text.label);
		}

		/** 引擎一句话说明。 */
		function engineHint(t, engine) {
			const text = ENGINE_TEXT[engine];
			return text === undefined ? "" : t(text.hint);
		}

		// ── 组件 ────────────────────────────────────────────────────────────

		/**
		 * 「⚡ 引擎：<当前值> ▾」胶囊。
		 *
		 * 挂在 `conversation.hero.options` 与 `conversation.input.dock` 两处（同一枚组件）。
		 * 状态如实表达：
		 *   - 读盘中 → 「引擎：读取中…」；
		 *   - 读到了 → 「引擎：原生 / Pi 引擎 / 回声引擎」；
		 *   - 读不到 → 「引擎：不可用」（虚线边、可点，点开面板里有具体原因）。
		 * 三种状态都渲染，**不静默不渲染**：看不见的按钮和没做出来在用户眼里是同一件事。
		 */
		function EngineChip(props) {
			const t = typeof props?.t === "function" ? props.t : (key) => key;
			const store = props?.store ?? selectorStore;
			// 外壳形态由所在插槽决定（`inject` 传进来）：hero 那一行是 inline 流，通栏那一行要占满右对齐。
			const docked = props?.variant === "dock";
			const [snapshot, setSnapshot] = react.useState(() => store.get());

			react.useEffect(() => {
				const off = store.subscribe(() => setSnapshot(store.get()));
				store.ensure();
				return off;
			}, [store]);

			const ready = snapshot.status === "ready";
			const label = ready ? engineLabel(t, snapshot.engine) : null;
			// 命名空间在、但值不是三个精确取值之一（配置写错）也按「不可用」显示，不猜。
			const shown = label === null ? (snapshot.status === "idle" || snapshot.status === "loading" ? t("chipLoading") : t("chipUnavailable")) : label;
			const style = ready && label !== null ? styles.chipButton : styles.chipButtonUnavailable;
			const title = ready && label !== null ? t("chipTitle") : `${t("chipUnavailable")}：${snapshot.error ?? "unknown"}${snapshot.detail === null || snapshot.detail === undefined ? "" : ` (${snapshot.detail})`}`;

			return jsxRuntime.jsx("div", {
				style: docked ? styles.chipRowDock : styles.chipRowInline,
				"data-dsh-engine-variant": docked ? "dock" : "inline",
				children: jsxRuntime.jsxs("button", {
					type: "button",
					style,
					title,
					"aria-haspopup": "dialog",
					"data-dsh-engine": snapshot.engine === null ? "unknown" : snapshot.engine,
					"data-dsh-engine-state": snapshot.status,
					onClick: () => openPicker(),
					children: [
						jsxRuntime.jsx("span", { children: "⚡" }, "engine-bolt"),
						jsxRuntime.jsx("span", { children: t("chipPrefix") }, "engine-prefix"),
						jsxRuntime.jsx("span", { children: t("chipSeparator") }, "engine-sep"),
						jsxRuntime.jsx("span", { style: styles.chipLabel, children: shown }, "engine-label"),
						jsxRuntime.jsx("span", { children: "▾" }, "engine-chevron"),
					],
				}, "engine-chip"),
			});
		}

		/**
		 * 引擎选择浮层。
		 *
		 * 注册在 `shell.overlay`（整帧浮层）——不往 document.body 追加 DOM，
		 * 也不受输入框附近容器的影响。点背景关、Esc 关、写盘成功自动关。
		 * 写盘失败**不关**：把 host 的拒绝原因（如 revision 陈旧 = settings/conflict）留在眼前。
		 */
		function EnginePickerOverlay(props) {
			const t = typeof props?.t === "function" ? props.t : (key) => key;
			const store = props?.store ?? selectorStore;
			const pickers = props?.picker ?? pickerStore;
			const [snapshot, setSnapshot] = react.useState(() => store.get());
			const [open, setOpen] = react.useState(() => pickers.get().open);

			react.useEffect(() => {
				const offStore = store.subscribe(() => setSnapshot(store.get()));
				const offPicker = pickers.subscribe(() => setOpen(pickers.get().open));
				return () => {
					offStore();
					offPicker();
				};
			}, [store, pickers]);

			react.useEffect(() => {
				if (open !== true || typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				const onKeyDown = (event) => {
					if (event !== null && event !== undefined && event.key === "Escape") pickers.set({ open: false });
				};
				window.addEventListener("keydown", onKeyDown);
				return () => window.removeEventListener("keydown", onKeyDown);
			}, [open, pickers]);

			if (open !== true) return null;

			const close = () => pickers.set({ open: false });
			const ready = snapshot.status === "ready";
			const unavailable = snapshot.status === "unavailable";
			const failed = snapshot.error !== null && snapshot.error !== undefined && snapshot.error !== "busy";

			const options = ENGINE_IDS.map((id) => {
				const active = ready && snapshot.engine === id;
				return jsxRuntime.jsxs("button", {
					type: "button",
					style: active ? styles.pickerItemActive : styles.pickerItem,
					disabled: snapshot.busy === true || unavailable,
					"data-dsh-engine-option": id,
					onClick: () => {
						store.select(id).then((result) => {
							if (result.ok === true) close();
						});
					},
					children: [
						jsxRuntime.jsxs("span", {
							style: styles.pickerItemName,
							children: [
								jsxRuntime.jsx("span", { children: engineLabel(t, id) ?? id }, `option-label-${id}`),
								active ? jsxRuntime.jsx("span", { style: styles.pickerItemBadge, children: t("pickerCurrent") }, `option-current-${id}`) : null,
							],
						}, `option-name-${id}`),
						jsxRuntime.jsx("span", { style: styles.pickerItemHint, children: engineHint(t, id) }, `option-hint-${id}`),
					],
				}, `option-${id}`);
			});

			return jsxRuntime.jsx("div", {
				style: styles.modalBackdrop,
				"data-dsh-engine-picker": "open",
				// 点背景空白处关闭；点面板内部不关（事件目标不是背景本身）。
				onClick: (event) => {
					if (event !== null && event !== undefined && event.target === event.currentTarget) close();
				},
				children: jsxRuntime.jsxs("div", {
					style: styles.modalPanel,
					role: "dialog",
					"aria-modal": true,
					"aria-label": t("pickerTitle"),
					children: [
						jsxRuntime.jsx("h3", { style: styles.modalHeading, children: t("pickerTitle") }, "picker-title"),
						jsxRuntime.jsx("p", { style: styles.hint, children: t("pickerHint") }, "picker-hint"),
						jsxRuntime.jsx("p", { style: styles.hint, children: t("pickerEffective") }, "picker-effective"),
						jsxRuntime.jsx("p", { style: styles.hint, children: t("pickerOrthogonal") }, "picker-orthogonal"),
						unavailable
							? jsxRuntime.jsx("p", { style: styles.messageError, "data-dsh-engine-diagnostic": snapshot.error ?? "unknown", children: t("pickerUnavailableHint") }, "picker-unavailable")
							: null,
						failed
							? jsxRuntime.jsx("p", {
								style: styles.messageError,
								"data-dsh-engine-error": snapshot.error,
								children: `${t("pickerFailed")}：${snapshot.error}${snapshot.detail === null || snapshot.detail === undefined ? "" : ` (${snapshot.detail})`}`,
							}, "picker-error")
							: null,
						snapshot.busy === true ? jsxRuntime.jsx("p", { style: styles.hint, children: t("pickerBusy") }, "picker-busy") : null,
						jsxRuntime.jsx("div", { style: styles.modalList, children: options }, "picker-list"),
						jsxRuntime.jsx("button", {
							type: "button",
							style: styles.button,
							onClick: close,
							children: t("pickerClose"),
						}, "picker-close"),
					],
				}, "picker-panel"),
			});
		}

		/**
		 * 需要注入的客户端服务。
		 *
		 * 只 inject 这两个 —— 它们是 DSH 客户端树的常驻服务（`slots` 由 ui-renderer 提供、
		 * `locale` 由 client-locale 提供），**不 inject `remote.settings`**：
		 * 客户端条目一旦 pending（等服务）会拖垮整页 boot，而 settings 对 UI 只是可选依赖。
		 * settings 走 `ctx.get()` 现取，拿不到就渲染「不可用」。
		 */
		const inject = ["slots", "locale"];

		/**
		 * 把「引擎」接到两个插槽 + 一个浮层上。
		 * @param ctx 浏览器插件上下文
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "@local/dsh-engine-switch: dictionaries");
			const t = ctx.locale.bind(NS);

			// 读写桥：两个插槽组件、浮层、以及「外部改值」都走同一份 store。
			ctx.effect(() => selectorStore.attachBridge({
				read: () => readEngineSelector(ctx),
				write: (engine, target) => writeEngineSelector(ctx, engine, target),
			}), "@local/dsh-engine-switch: selector bridge");

			// 选择器可能在别处被改（设置页 / `/engine` 命令）⇒ 跟着刷新，
			// 否则 Chip 上会一直挂着旧值（两份真话）。用宿主自己的文档失效事件，不自造轮询。
			ctx.effect(() => {
				const refresh = () => {
					selectorStore.load();
				};
				const disposers = [];
				try {
					const remote = typeof ctx.get === "function" ? ctx.get("remote") : undefined;
					if (remote !== null && remote !== undefined && typeof remote.$on === "function") {
						disposers.push(remote.$on("settings/document-updated", refresh));
					}
					if (typeof ctx.on === "function") disposers.push(ctx.on("connection/reset", refresh));
				} catch {
					// 订阅失败只影响「自动刷新」，Chip 仍可用（打开面板前会重读）。
				}
				return () => {
					for (const dispose of disposers) {
						try {
							dispose();
						} catch {
							// 卸载期的清理失败不该抛回渲染层。
						}
					}
				};
			}, "@local/dsh-engine-switch: selector refresh");

			// ① 新会话起始页：与「工作目录」chip / Agent 预设同排（order 30 = 紧挨预设）。
			ctx.slots.inject("conversation.hero.options", () => ctx.slots.register({
				name: "conversation.hero.options",
				id: "engine-hero",
				order: 30,
				locale: NS,
				inject: () => ({ t, variant: "inline" }),
			}, EngineChip));

			// ② 主会话框上方（输入框卡片上方的通栏区，宿主自己的 Queue/Todo/Goal 就在这一排）。
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "engine-dock",
				order: 30,
				locale: NS,
				inject: () => ({ t, variant: "dock" }),
			}, EngineChip));

			// ③ 选择浮层：整帧浮层插槽，居中显示，不往 document.body 追加 DOM。
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "engine-picker",
				order: 50,
				locale: NS,
				inject: () => ({ t }),
			}, EnginePickerOverlay));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.NS = NS;
		exports.SETTINGS_NS = SETTINGS_NS;
		exports.ENGINE_IDS = ENGINE_IDS;
		exports.NATIVE_ENGINE_ID = NATIVE_ENGINE_ID;
		exports.normalizeEngineId = normalizeEngineId;
		exports.settingsServiceOf = settingsServiceOf;
		exports.locateSettingsNamespace = locateSettingsNamespace;
		exports.readEngineSelector = readEngineSelector;
		exports.writeEngineSelector = writeEngineSelector;
		exports.createSelectorStore = createSelectorStore;
		exports.selectorStore = selectorStore;
		exports.pickerStore = pickerStore;
		exports.openPicker = openPicker;
		exports.EngineChip = EngineChip;
		exports.EnginePickerOverlay = EnginePickerOverlay;
		return module.exports;
	},
});
