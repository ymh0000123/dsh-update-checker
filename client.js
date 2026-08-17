window.__ModuleLoader__.load({
	id: "dsh-update-checker",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let React = require("react");

		const NAME = "dsh-update-checker";
		const API_PATH = "/dsh-update-checker/api";
		const POLL_MS = 400;

		// Theme the panel with the GUI's design tokens (dsw alias variables),
		// following the shell's own injected-<style> pattern (data-plugin-css).
		const PANEL_CSS = `
.uc-root { display: flex; flex-direction: column; gap: 14px; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary); }
.uc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.uc-head-l { min-width: 0; }
.uc-title { font-size: 15px; font-weight: 600; letter-spacing: 0.01em; }
.uc-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 3px; }
.uc-dot { opacity: 0.45; }
.uc-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.uc-stat { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 10px 13px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); cursor: pointer; text-align: left; transition: border-color 0.15s ease, background 0.15s ease; }
.uc-stat:hover { border-color: var(--dsw-alias-border-l2); }
.uc-stat-n { font-size: 21px; font-weight: 650; line-height: 1.25; font-variant-numeric: tabular-nums; }
.uc-stat-l { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.uc-stat-upd .uc-stat-n { color: var(--dsw-alias-state-error-primary); }
.uc-stat-ok .uc-stat-n { color: var(--dsw-alias-state-success-primary); }
.uc-stat-pre .uc-stat-n { color: var(--dsw-alias-state-warn-primary); }
.uc-stat-err .uc-stat-n { color: var(--dsw-alias-state-error-primary); }
.uc-stat-on { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); }
.uc-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.uc-meta-k { opacity: 0.75; flex: none; }
.uc-meta-v { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.uc-card-flat { background: transparent; }
.uc-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.uc-card-title { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.uc-chipn { font-size: 11px; font-weight: 500; padding: 1px 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.uc-card-tools { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.uc-card-body { padding: 12px 14px 11px; }
.uc-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; margin-bottom: 11px; background: var(--dsw-alias-bg-layer-2); }
.uc-seg-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border: none; border-right: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; font-family: inherit; }
.uc-seg-btn:last-child { border-right: none; }
.uc-seg-btn:hover { color: var(--dsw-alias-label-primary); }
.uc-seg-on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary); }
.uc-seg-n { font-size: 11px; opacity: 0.65; font-variant-numeric: tabular-nums; }
.uc-search { width: 170px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: inherit; box-sizing: border-box; }
.uc-search:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.uc-tw { width: 100%; overflow-x: auto; }
.uc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.uc-table th { text-align: left; font-weight: 500; font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2); white-space: nowrap; }
.uc-table td { padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; vertical-align: middle; }
.uc-table tbody tr:last-child td { border-bottom: none; }
.uc-table tbody tr:hover td { background: var(--dsw-alias-bg-layer-2); }
.uc-table td.uc-name { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dsw-alias-label-primary); white-space: normal; word-break: break-all; max-width: 250px; }
.uc-table td.uc-repo { white-space: normal; word-break: break-all; max-width: 180px; }
.uc-cell-r { text-align: right; }
.uc-ver { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-variant-numeric: tabular-nums; }
.uc-code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.uc-ver-new { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.uc-arrow { opacity: 0.45; margin: 0 5px; }
.uc-dim { opacity: 0.42; }
.uc-tag { margin-left: 6px; font-size: 10px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); vertical-align: 1px; }
.uc-badge { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 11px; border: 1px solid transparent; white-space: nowrap; }
.uc-b-upd { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent); }
.uc-b-ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 38%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.uc-b-pre { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); }
.uc-b-err { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent); }
.uc-btn { padding: 5px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; white-space: nowrap; font-family: inherit; }
.uc-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.uc-btn:disabled { opacity: 0.5; cursor: default; border-color: var(--dsw-alias-border-l1); }
.uc-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); font-weight: 600; }
.uc-btn-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); color: var(--dsw-alias-state-error-primary); }
.uc-btn-sm { padding: 3px 10px; font-size: 11px; border-radius: 6px; }
.uc-acts { display: inline-flex; align-items: center; gap: 7px; justify-content: flex-end; }
.uc-done { color: var(--dsw-alias-state-success-primary); font-size: 11px; white-space: nowrap; }
.uc-banner { display: flex; align-items: center; gap: 10px; padding: 9px 13px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-size: 12px; }
.uc-banner-t { font-weight: 600; white-space: nowrap; flex: none; }
.uc-banner-d { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-banner-info { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent); }
.uc-banner-ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 7%, transparent); }
.uc-banner-ok .uc-banner-t { color: var(--dsw-alias-state-success-primary); }
.uc-banner-err { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); }
.uc-banner-err .uc-banner-t { color: var(--dsw-alias-state-error-primary); }
.uc-x { border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; flex: none; font-family: inherit; }
.uc-spin { width: 12px; height: 12px; flex: none; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); border-top-color: var(--dsw-alias-brand-primary); animation: uc-rot 0.7s linear infinite; box-sizing: border-box; }
.uc-spin-sm { width: 10px; height: 10px; }
@keyframes uc-rot { to { transform: rotate(360deg); } }
.uc-prog-head { display: flex; align-items: center; gap: 9px; font-size: 12px; }
.uc-prog-phase { font-weight: 600; white-space: nowrap; }
.uc-prog-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.uc-prog-n { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.uc-prog { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin-top: 9px; }
.uc-prog-bar { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width 0.25s ease; }
.uc-note { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.uc-empty { padding: 20px 0; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.uc-foot { margin-top: 9px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.uc-err-card { display: flex; flex-direction: column; align-items: flex-start; gap: 9px; padding: 14px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); }
.uc-err-title { font-weight: 600; color: var(--dsw-alias-state-error-primary); }
.uc-err-body { font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
@media (max-width: 680px) { .uc-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .uc-search { width: 120px; } }
`;
		const STYLE_ID = "dsh-update-checker/panel.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = NAME;
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = PANEL_CSS;
			document.head.appendChild(tag);
		}

		/** Both halves speak JSON over one local route; every call returns fast. */
		const call = (payload) => fetch(API_PATH, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		}).then((res) => res.json());

		// Cross-render bookkeeping: which report timestamp / update result the
		// page has already consumed. Reset on mount so a remount refetches.
		const local = { resultAt: 0, resultSeq: 0, fetching: false };

		const STATUS = {
			update: { label: "可更新", cls: "uc-b-upd" },
			latest: { label: "已最新", cls: "uc-b-ok" },
			preview: { label: "预发布", cls: "uc-b-pre" },
			failed: { label: "失败", cls: "uc-b-err" },
		};
		const PHASE = { init: "初始化", npm: "查询 npm 仓库", github: "检查 GitHub 仓库", done: "完成" };

		const fmtTime = (iso) => {
			const s = String(iso || "").replace("T", " ");
			return s.length >= 19 ? s.slice(5, 19) : s;
		};
		const shortSha = (c) => (c ? String(c).slice(0, 7) : "");
		const el = React.createElement;
		const dash = () => el("span", { className: "uc-dim" }, "—");
		const val = (v) => (v ? String(v) : dash());

		function Badge(props) {
			const info = STATUS[props.status] || STATUS.failed;
			return el("span", { className: "uc-badge " + info.cls, title: props.title || "" }, info.label);
		}

		function Seg(props) {
			return el("div", { className: "uc-seg" },
				...props.keys.map((k) => el("button", {
					key: k,
					className: "uc-seg-btn" + (props.value === k ? " uc-seg-on" : ""),
					onClick: () => props.onChange(k),
				},
					el("span", null, k === "all" ? "全部" : STATUS[k].label),
					el("span", { className: "uc-seg-n" }, String(props.counts[k] || 0)),
				)),
			);
		}

		function UpdateChecker() {
			const [state, setState] = React.useState({ phase: "loading", report: null, error: null });
			const [progress, setProgress] = React.useState(null);
			const [filter, setFilter] = React.useState("update");
			const [gfilter, setGfilter] = React.useState("update");
			const [query, setQuery] = React.useState("");
			const [clicked, setClicked] = React.useState({});
			const [updateMsg, setUpdateMsg] = React.useState(null);
			const [updProg, setUpdProg] = React.useState(null);
			const [collapsed, setCollapsed] = React.useState({ npm: false, github: false });

			const fetchReport = () => {
				if (local.fetching) return;
				local.fetching = true;
				call({ action: "report" }).then(
					(report) => {
						local.fetching = false;
						if (report && typeof report === "object") setState({ phase: "done", report: report, error: null });
						else setState({ phase: "done", report: null, error: "没有可用的检测结果，请点击重新检测" });
					},
					(err) => {
						local.fetching = false;
						setState({ phase: "done", report: null, error: String((err && err.message) || err) });
					},
				);
			};

			const refresh = (force) => {
				local.resultAt = 0;
				setState((prev) => ({ phase: "loading", report: prev.report, error: null }));
				setProgress({ active: true, phase: "init", current: 0, total: 1, message: "正在启动检查…" });
				call(force ? { action: "check", force: true } : { action: "check" }).then(
					() => {},
					(err) => setState({ phase: "done", report: null, error: String((err && err.message) || err) }),
				);
			};

			const clearClicked = (name) => setClicked((prev) => {
				if (!prev[name]) return prev;
				const next = Object.assign({}, prev);
				delete next[name];
				return next;
			});

			const runUpdate = (name) => {
				setClicked((prev) => Object.assign({}, prev, { [name]: true }));
				setUpdateMsg(null);
				call({ action: "update", name: name }).then(
					(res) => {
						if (!res || res.ok !== true) {
							clearClicked(name);
							setUpdateMsg({ ok: false, text: (res && res.message) || "无法开始更新" });
						}
					},
					(err) => {
						clearClicked(name);
						setUpdateMsg({ ok: false, text: "无法开始更新：" + String((err && err.message) || err) });
					},
				);
			};

			const cancelUpdate = () => {
				call({ action: "cancel" }).then(
					(res) => setUpdateMsg({ ok: false, text: (res && res.message) || "已请求停止更新" }),
					() => {},
				);
			};

			const toggle = (which) => setCollapsed((prev) => Object.assign({}, prev, { [which]: !prev[which] }));

			React.useEffect(() => {
				local.resultAt = 0;
				local.resultSeq = 0;
				local.fetching = false;
				refresh(false);
				const id = setInterval(() => {
					call({ action: "progress" }).then((p) => {
						if (!p || typeof p !== "object") return;
						setProgress(p);
						if (p.active) {
							setState((prev) => (prev.phase === "loading" ? prev : { phase: "loading", report: prev.report, error: null }));
							return;
						}
						if (p.resultAt > 0 && p.resultAt !== local.resultAt) {
							local.resultAt = p.resultAt;
							fetchReport();
						}
					}, () => {});
					call({ action: "update-progress" }).then((p) => {
						if (!p || typeof p !== "object") return;
						setUpdProg(p);
						const r = p.result;
						if (r && r.seq && r.seq !== local.resultSeq) {
							local.resultSeq = r.seq;
							clearClicked(r.name);
							setUpdateMsg({ ok: !!r.ok, text: r.message || (r.ok ? "更新完成" : "更新失败") });
							if (r.ok) local.resultAt = 0;
						}
					}, () => {});
				}, POLL_MS);
				return () => clearInterval(id);
			}, []);

			const busy = state.phase === "loading";
			const p = progress || {};
			const pTotal = p.total > 0 ? p.total : 1;
			const pCurrent = Math.min(p.current || 0, pTotal);
			const pPct = Math.round((pCurrent / pTotal) * 100);
			const pLabel = PHASE[p.phase] || "检查中";

			const progressBlock = el("div", { className: "uc-card uc-card-flat" },
				el("div", { className: "uc-card-body" },
					el("div", { className: "uc-prog-head" },
						el("span", { className: "uc-spin" }),
						el("span", { className: "uc-prog-phase" }, pLabel),
						el("span", { className: "uc-prog-msg" }, p.message ? String(p.message) : ""),
						el("span", { className: "uc-prog-n" }, pCurrent + " / " + pTotal),
					),
					el("div", { className: "uc-prog" },
						el("div", { className: "uc-prog-bar", style: { width: pPct + "%" } }),
					),
				),
			);

			if (busy && !state.report) {
				return el("div", { className: "uc-root" },
					el("div", { className: "uc-head" },
						el("div", { className: "uc-head-l" },
							el("div", { className: "uc-title" }, "更新检测"),
							el("div", { className: "uc-sub" }, "正在检查 DSH / @deepseek-ai npm 包与 GitHub 源包…"),
						),
						el("button", { className: "uc-btn", disabled: true }, "检查中…"),
					),
					progressBlock,
					el("div", { className: "uc-note" }, "检查在后台运行，可以离开本页面，回来后仍会显示结果。"),
				);
			}

			const errMsg = state.error || (state.report && state.report.ok === false ? state.report.error : null);
			if (errMsg) {
				return el("div", { className: "uc-root" },
					el("div", { className: "uc-head" },
						el("div", { className: "uc-head-l" }, el("div", { className: "uc-title" }, "更新检测")),
					),
					el("div", { className: "uc-err-card" },
						el("div", { className: "uc-err-title" }, "检测失败"),
						el("div", { className: "uc-err-body" }, String(errMsg)),
						el("button", { className: "uc-btn uc-btn-primary", onClick: () => refresh(true) }, "重试"),
					),
				);
			}

			const report = state.report || {};
			const s = report.summary || {};
			const pkgs = report.packages || [];
			const gpkgs = report.github || [];
			const gs = report.githubSummary || { total: gpkgs.length, updatable: 0, upToDate: 0, failed: 0 };

			const statusOf = (x) => {
				if (x.error) return "failed";
				if (x.hasUpdate) return "update";
				if (x.local === x.latest) return "latest";
				return "preview";
			};
			const gStatusOf = (x) => (x.error ? "failed" : (x.hasUpdate ? "update" : "latest"));

			const counts = { all: pkgs.length, update: s.updatable || 0, latest: s.upToDate || 0, preview: s.preview || 0, failed: s.failed || 0 };
			const gCounts = { all: gpkgs.length, update: gs.updatable || 0, latest: gs.upToDate || 0, failed: gs.failed || 0 };
			const updAll = counts.update + gCounts.update;
			const latestAll = counts.latest + gCounts.latest;
			const failedAll = counts.failed + gCounts.failed;

			const applyGlobal = (k) => {
				const gk = k === "preview" ? "all" : k;
				if (filter === k && gfilter === gk) {
					setFilter("all");
					setGfilter("all");
					return;
				}
				setFilter(k);
				setGfilter(gk);
			};

			const tiles = [
				{ key: "update", n: updAll, tone: "upd" },
				{ key: "latest", n: latestAll, tone: "ok" },
				{ key: "preview", n: counts.preview, tone: "pre" },
				{ key: "failed", n: failedAll, tone: "err" },
			];
			const stats = el("div", { className: "uc-stats" },
				...tiles.map((t) => el("button", {
					key: t.key,
					className: "uc-stat uc-stat-" + t.tone + (filter === t.key ? " uc-stat-on" : ""),
					onClick: () => applyGlobal(t.key),
					title: "只看" + STATUS[t.key].label,
				},
					el("div", { className: "uc-stat-n" }, String(t.n)),
					el("div", { className: "uc-stat-l" }, STATUS[t.key].label),
				)),
			);

			const order = { update: 0, failed: 1, preview: 2, latest: 3 };
			const sorted = pkgs.filter((x) => {
				if (filter !== "all" && statusOf(x) !== filter) return false;
				if (query && x.name.toLowerCase().indexOf(query.toLowerCase()) < 0) return false;
				return true;
			}).sort((a, b) => {
				const d = order[statusOf(a)] - order[statusOf(b)];
				return d !== 0 ? d : a.name.localeCompare(b.name);
			});

			const npmRows = sorted.map((x, i) => el("tr", { key: "n" + i },
				el("td", { className: "uc-name" }, x.name),
				el("td", { className: "uc-ver" },
					el("span", null, val(x.local)),
					x.hasUpdate ? el("span", { className: "uc-arrow" }, "→") : null,
					x.hasUpdate ? el("span", { className: "uc-ver-new" }, String(x.maxPublished || "")) : null,
				),
				el("td", { className: "uc-ver" }, val(x.latest)),
				el("td", { className: "uc-ver" }, val(x.next)),
				el("td", { className: "uc-cell-r" }, el(Badge, { status: statusOf(x), title: x.error ? String(x.error) : "" })),
			));

			const npmTable = el("div", { className: "uc-tw" },
				el("table", { className: "uc-table" },
					el("thead", null,
						el("tr", null,
							el("th", null, "包名"),
							el("th", null, "本机版本"),
							el("th", null, "latest"),
							el("th", null, "next"),
							el("th", { className: "uc-cell-r" }, "状态"),
						),
					),
					el("tbody", null, ...npmRows),
				),
			);

			const busyName = updProg && updProg.active ? updProg.name : null;
			const lastResult = updProg && updProg.result ? updProg.result : null;
			const uStateOf = (name) => {
				if (busyName === name) return "updating";
				if (clicked[name]) return "updating";
				if (lastResult && lastResult.name === name) {
					if (lastResult.cancelled) return "idle";
					return lastResult.ok ? "done" : "error";
				}
				return "idle";
			};

			const gShown = gpkgs.filter((x) => (gfilter === "all" ? true : gStatusOf(x) === gfilter));
			const gRows = gShown.map((x, i) => {
				const ustate = uStateOf(x.name);
				let actionEl;
				if (x.kind === "github-dep" && (x.hasUpdate || ustate !== "idle")) {
					if (ustate === "updating") {
						const sec = updProg && updProg.active && updProg.name === x.name ? Math.max(1, Math.round((updProg.elapsedMs || 0) / 1000)) : 0;
						const cancelling = !!(updProg && updProg.cancelling && updProg.name === x.name);
						actionEl = el("span", { className: "uc-acts" },
							el("span", { className: "uc-spin uc-spin-sm" }),
							el("span", { className: "uc-dim" }, sec ? sec + "s" : ""),
							el("button", { className: "uc-btn uc-btn-sm", onClick: cancelUpdate, disabled: cancelling }, cancelling ? "停止中" : "停止"),
						);
					} else if (ustate === "done") {
						actionEl = el("span", { className: "uc-done" }, "✓ 已更新");
					} else if (ustate === "error") {
						actionEl = el("button", { className: "uc-btn uc-btn-sm uc-btn-warn", onClick: () => runUpdate(x.name), title: (lastResult && lastResult.message) || "" }, "重试");
					} else {
						actionEl = el("button", { className: "uc-btn uc-btn-sm uc-btn-primary", onClick: () => runUpdate(x.name), disabled: !!busyName }, "更新");
					}
				} else {
					actionEl = dash();
				}
				return el("tr", { key: "g" + i },
					el("td", { className: "uc-name" },
						x.name,
						x.kind === "link-git" ? el("span", { className: "uc-tag", title: "本地 link 安装，需手动 git pull" }, "link") : null,
					),
					el("td", { className: "uc-repo" }, val(x.repo)),
					el("td", { className: "uc-ver" },
						x.installedCommit ? el("span", { className: "uc-code", title: String(x.installedCommit) }, shortSha(x.installedCommit)) : dash(),
						x.hasUpdate && x.latestCommit ? el("span", { className: "uc-arrow" }, "→") : null,
						x.hasUpdate && x.latestCommit ? el("span", { className: "uc-code uc-ver-new", title: String(x.latestCommit) }, shortSha(x.latestCommit)) : null,
						x.via === "api" ? el("span", { className: "uc-tag", title: "经 GitHub API 获取（github.com 被阻断时自动回退）" }, "API") : null,
					),
					el("td", null, el(Badge, { status: gStatusOf(x), title: x.error ? String(x.error) : "" })),
					el("td", { className: "uc-cell-r" }, actionEl),
				);
			});

			const gTable = el("div", { className: "uc-tw" },
				el("table", { className: "uc-table" },
					el("thead", null,
						el("tr", null,
							el("th", null, "包名"),
							el("th", null, "仓库"),
							el("th", null, "commit"),
							el("th", null, "状态"),
							el("th", { className: "uc-cell-r" }, "操作"),
						),
					),
					el("tbody", null, ...gRows),
				),
			);

			let banner = null;
			if (updProg && updProg.active) {
				banner = el("div", { className: "uc-banner uc-banner-info" },
					el("span", { className: "uc-spin" }),
					el("span", { className: "uc-banner-t" }, "正在更新 " + String(updProg.name || "")),
					el("span", { className: "uc-banner-d" },
						Math.max(1, Math.round((updProg.elapsedMs || 0) / 1000)) + "s" + (updProg.line ? " · " + String(updProg.line) : "") + " · 后台运行，可离开本页面",
					),
					el("button", { className: "uc-btn uc-btn-sm", onClick: cancelUpdate, disabled: !!updProg.cancelling }, updProg.cancelling ? "停止中…" : "停止"),
				);
			} else if (updateMsg) {
				banner = el("div", { className: "uc-banner " + (updateMsg.ok ? "uc-banner-ok" : "uc-banner-err") },
					el("span", { className: "uc-banner-t" }, updateMsg.ok ? "✓ 完成" : "✕ 失败"),
					el("span", { className: "uc-banner-d", title: String(updateMsg.text) }, String(updateMsg.text)),
					el("button", { className: "uc-x", onClick: () => setUpdateMsg(null), title: "关闭" }, "×"),
				);
			}

			return el("div", { className: "uc-root" },
				el("div", { className: "uc-head" },
					el("div", { className: "uc-head-l" },
						el("div", { className: "uc-title" }, "更新检测"),
						el("div", { className: "uc-sub" },
							"DSH " + String(report.dshRelease || "未知"),
							report.checkedAt ? el("span", { className: "uc-dot" }, "·") : null,
							report.checkedAt ? el("span", null, "检查于 " + fmtTime(report.checkedAt)) : null,
							el("span", { className: "uc-dot" }, "·"),
							el("span", null, "共 " + (pkgs.length + gpkgs.length) + " 项"),
						),
					),
					el("button", { className: "uc-btn uc-btn-primary", onClick: () => refresh(true), disabled: busy }, busy ? "检查中…" : "重新检测"),
				),
				busy ? progressBlock : null,
				banner,
				stats,
				el("div", { className: "uc-meta" },
					el("span", { className: "uc-meta-k" }, "Profile"),
					el("span", { className: "uc-meta-v", title: String(report.profilePath || "") }, String(report.profilePath || "未找到")),
				),
				el("section", { className: "uc-card" },
					el("div", { className: "uc-card-head" },
						el("div", { className: "uc-card-title" },
							el("span", null, "npm 包"),
							el("span", { className: "uc-chipn" }, String(pkgs.length)),
						),
						el("div", { className: "uc-card-tools" },
							!collapsed.npm ? el("input", {
								className: "uc-search",
								type: "text",
								placeholder: "搜索包名…",
								value: query,
								onChange: (e) => setQuery(e.target.value),
							}) : null,
							el("button", { className: "uc-btn uc-btn-sm", onClick: () => toggle("npm") }, collapsed.npm ? "展开" : "折叠"),
						),
					),
					!collapsed.npm ? el("div", { className: "uc-card-body" },
						el(Seg, { keys: ["update", "latest", "preview", "failed", "all"], counts: counts, value: filter, onChange: setFilter }),
						sorted.length > 0 ? npmTable : el("div", { className: "uc-empty" }, "没有符合条件的包"),
						el("div", { className: "uc-foot" }, "显示 " + sorted.length + " / " + pkgs.length),
					) : null,
				),
				el("section", { className: "uc-card" },
					el("div", { className: "uc-card-head" },
						el("div", { className: "uc-card-title" },
							el("span", null, "GitHub 源包"),
							el("span", { className: "uc-chipn" }, String(gpkgs.length)),
						),
						el("div", { className: "uc-card-tools" },
							el("button", { className: "uc-btn uc-btn-sm", onClick: () => toggle("github") }, collapsed.github ? "展开" : "折叠"),
						),
					),
					!collapsed.github ? el("div", { className: "uc-card-body" },
						el(Seg, { keys: ["update", "latest", "failed", "all"], counts: gCounts, value: gfilter, onChange: setGfilter }),
						gRows.length > 0 ? gTable : el("div", { className: "uc-empty" }, "没有符合条件的 GitHub 源包"),
						el("div", { className: "uc-foot" }, "显示 " + gShown.length + " / " + gpkgs.length + " · 更新使用 pnpm update，需能访问 github.com"),
					) : null,
				),
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "update-checker", order: 45, label: "更新检测" },
				() => el(UpdateChecker),
			));
		}

		exports.name = NAME;
		exports.apply = apply;
		return module.exports;
	}
});
