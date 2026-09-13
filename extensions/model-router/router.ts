/**
 * The Model router module: owns the Recovery decision logic.
 *
 * Given a Quota halt (the active model's provider reported a terminal usage
 * limit error and pi's retries gave up), the router runs the configured
 * Recovery strategies in Precedence order - `switch` to a Fallback model,
 * `wait` for the quota windows to reset - until the session runs again or
 * the chain is exhausted. The session resumes through one synthetic user
 * message (the Recovery message), because pi has no re-run-the-failed-turn
 * API (ADR 0006).
 *
 * This module is the single seam the tests exercise. Everything observable
 * is injected: the Quota read (from the Quota source module, #28), the
 * clock, the timer, the model registry lookup, and an action sink. No pi
 * internals are named here.
 *
 * Bound: at most three full strategy cycles per failed prompt, then one
 * error notification and a clean stop. A pending Recovery (strategies left,
 * original model, fallback in use, cycle count) is reported through the
 * persist action so the extension can store it as a session entry and
 * re-arm it after a restart (see rearm()).
 */
import type { QuotaRead } from "../quota/source";

export type StrategyName = "switch" | "wait";

export interface ModelRef {
	provider: string;
	id: string;
}

export const modelKey = (model: ModelRef): string => `${model.provider}/${model.id}`;

export const sameModel = (a: ModelRef | null | undefined, b: ModelRef): boolean =>
	!!a && a.provider === b.provider && a.id === b.id;

export interface RouterConfig {
	precedence: readonly StrategyName[];
	fallbacks: readonly ModelRef[];
	maxWaitMinutes: number;
}

export interface ModelLookup {
	found: boolean;
	hasAuth: boolean;
}

/** A pending Recovery exactly as persisted in the session entry. */
export interface PendingRecovery {
	v: 1;
	phase: "waiting" | "on-fallback";
	original: ModelRef;
	chainPos: number;
	fallbackInUse: ModelRef | null;
	cycles: number;
	/** Present while waiting: the Binding reset the timer is armed for. */
	resetAtMs?: number;
}

export interface RouterActions {
	/** Switch the session to a model. Resolves false when pi refuses (no auth). */
	setModel(model: ModelRef): Promise<boolean>;
	/** Send the one synthetic user message that resumes the halted turn. */
	sendUserMessage(text: string): Promise<void>;
	/** One of the four recovery-transition notifications. */
	notify(message: string, level: "info" | "error"): void;
	/** Persist (or clear) the Pending recovery in the session. */
	persistPending(data: PendingRecovery | null): void;
}

export interface TimerHandle {
	cancel(): void;
}

export interface RouterDeps {
	config: RouterConfig;
	/** The provider id the Quota source covers; wait and switch-back only apply to it. */
	quotaProviderId: string;
	/** One read of the plan's quota windows. Never throws (Quota source contract). */
	readQuota: () => Promise<QuotaRead>;
	/** Model registry lookup for a fallback entry. */
	findModel: (model: ModelRef) => ModelLookup;
	now: () => number;
	/** Arm a timer. The wiring owns the real timer; tests own a fake one. */
	scheduleTimer: (delayMs: number, onFire: () => void) => TimerHandle;
	actions: RouterActions;
}

/** At most this many full strategy cycles per failed prompt, then a clean stop. */
export const MAX_RECOVERY_CYCLES = 3;
/** Margin after the Binding reset before the confirming read. */
export const WAIT_MARGIN_MS = 60_000;
/** A switch-back confirmation read happens at most this often while idle. */
export const SWITCH_BACK_CHECK_INTERVAL_MS = 60_000;

/** The one fixed message that resumes the halted turn (ADR 0006). */
export const RECOVERY_MESSAGE =
	"The previous turn ended with a provider usage-limit error and was cut off. " +
	"Resume the task exactly where it left off; do not repeat work that already completed.";

interface RouterState {
	original: ModelRef;
	/** The model whose quota halted and is still active; the recovery operates on it. */
	current: ModelRef;
	/** Index into config.fallbacks of the next entry the switch strategy may try. */
	chainPos: number;
	/** The fallback the router set, or null while on the original model. */
	fallbackInUse: ModelRef | null;
	/** Strategy cycles started for this failed prompt. */
	cycles: number;
	phase: "recovering" | "waiting" | "on-fallback";
	/** The Binding reset a pending wait is armed for. */
	waitingResetAtMs: number | null;
}

export interface ModelRouter {
	/** A Quota halt on the given (active) model starts or continues a Recovery. */
	onQuotaHalt(current: ModelRef): Promise<void>;
	/** User input while a wait is pending cancels the wait. Synchronous. */
	onUserInput(): void;
	/** Any model_select event. Router-caused selects are consumed; manual ones cancel the pending recovery. Synchronous. */
	onModelSelect(current: ModelRef): void;
	/** The agent is idle: check the pending switch-back. */
	onIdle(current: ModelRef): Promise<void>;
	/** Re-arm a persisted Pending recovery (session start with reason resume/reload). */
	rearm(saved: PendingRecovery): Promise<void>;
	/** Cancel timers and drop in-memory state. The persisted entry stays for re-arming. */
	shutdown(): void;
}

export function createModelRouter(deps: RouterDeps): ModelRouter {
	const { config, actions } = deps;
	let state: RouterState | null = null;
	let timer: TimerHandle | null = null;
	let generation = 0;
	let expectingRouterSelect = false;
	let lastSwitchBackCheck = 0;

	// All async entry points serialize through this chain, so state mutations
	// never interleave mid-step. Synchronous cancellations (user input, manual
	// model change) bump `generation` instead, which aborts stale continuations.
	let queue: Promise<void> = Promise.resolve();
	function enqueue(work: () => Promise<void>): Promise<void> {
		const run = queue.then(work, work);
		queue = run.catch(() => undefined);
		return run;
	}

	function clearTimer(): void {
		if (timer) {
			timer.cancel();
			timer = null;
		}
	}

	function persist(phase: "waiting" | "on-fallback"): void {
		if (!state) return;
		actions.persistPending({
			v: 1,
			phase,
			original: state.original,
			chainPos: state.chainPos,
			fallbackInUse: state.fallbackInUse,
			cycles: state.cycles,
			...(phase === "waiting" && state.waitingResetAtMs !== null ? { resetAtMs: state.waitingResetAtMs } : {}),
		});
	}

	function clearAll(): void {
		clearTimer();
		state = null;
		actions.persistPending(null);
	}

	function giveUp(): void {
		clearTimer();
		state = null;
		actions.persistPending(null);
		actions.notify(
			`model-router: quota recovery gave up after ${MAX_RECOVERY_CYCLES} attempts; re-run the prompt once the quota resets`,
			"error",
		);
	}


	// ------------------------------------------------------------------
	// Strategies
	// ------------------------------------------------------------------

	async function trySwitch(gen: number): Promise<"switched" | "exhausted"> {
		const stateNow = state;
		if (!stateNow) return "exhausted";
		const candidates = config.fallbacks.slice(stateNow.chainPos);
		if (candidates.length === 0) return "exhausted";
		const skipped: string[] = [];
		for (let i = 0; i < candidates.length; i += 1) {
			const entry = candidates[i];
			if (sameModel(entry, stateNow.current)) {
				skipped.push(`${modelKey(entry)} (current model)`);
				continue;
			}
			const lookup = deps.findModel(entry);
			if (!lookup.found) {
				skipped.push(`${modelKey(entry)} (not found)`);
				continue;
			}
			if (!lookup.hasAuth) {
				skipped.push(`${modelKey(entry)} (no auth configured)`);
				continue;
			}
			expectingRouterSelect = true;
			let ok = false;
			try {
				ok = await actions.setModel(entry);
			} finally {
				expectingRouterSelect = false;
			}
			if (gen !== generation || !state) return "exhausted";
			if (!ok) {
				skipped.push(`${modelKey(entry)} (model set failed)`);
				continue;
			}
			const active = state;
			active.chainPos = stateNow.chainPos + i + 1;
			active.fallbackInUse = { provider: entry.provider, id: entry.id };
			active.current = { provider: entry.provider, id: entry.id };
			active.phase = "on-fallback";
			actions.notify(`model-router: usage limit on ${modelKey(active.original)}; switched to ${modelKey(entry)}`, "info");
			persist("on-fallback");
			await actions.sendUserMessage(RECOVERY_MESSAGE);
			if (gen !== generation) return "exhausted";
			return "switched";
		}
		if (skipped.length > 0) {
			actions.notify(`model-router: no usable fallback (${skipped.join("; ")})`, "info");
		}
		return "exhausted";
	}

	async function tryWait(gen: number): Promise<"waited" | "not-viable"> {
		const stateNow = state;
		if (!stateNow || stateNow.current.provider !== deps.quotaProviderId) return "not-viable";
		const read = await deps.readQuota();
		if (gen !== generation || !state) return "not-viable";
		if (!read.ok) return "not-viable";
		const exhausted = read.snapshot.windows.filter((window) => window.usedPercent >= 100);
		if (exhausted.length === 0) return "not-viable";
		const resetAtMs = Math.max(...exhausted.map((window) => window.resetsAtMs));
		const nowMs = deps.now();
		const maxWaitMs = config.maxWaitMinutes * 60_000;
		// A reset that already passed is not worth waiting for: after the timer's
		// confirming read finds the quota still exhausted, waiting again for the
		// same (now-past) reset would only loop. The next cycle switches or stops.
		if (resetAtMs <= nowMs) return "not-viable";
		if (resetAtMs > nowMs + maxWaitMs) return "not-viable";
		const delayMs = resetAtMs + WAIT_MARGIN_MS - nowMs;
		state.phase = "waiting";
		state.waitingResetAtMs = resetAtMs;
		timer = deps.scheduleTimer(delayMs, () => void onWaitTimerFires());
		actions.notify(
			`model-router: usage limit on ${modelKey(state.current)}; waiting for quota reset in ${formatDuration(resetAtMs - deps.now())} (resets at ${formatClock(resetAtMs)})`,
			"info",
		);
		persist("waiting");
		return "waited";
	}

	// ------------------------------------------------------------------
	// Cycle
	// ------------------------------------------------------------------

	async function runCycle(): Promise<void> {
		const gen = generation;
		const stateNow = state;
		if (!stateNow) return;
		if (stateNow.cycles >= MAX_RECOVERY_CYCLES) {
			giveUp();
			return;
		}
		stateNow.cycles += 1;
		let acted = false;
		for (const strategy of config.precedence) {
			if (gen !== generation || !state) return;
			if (strategy === "switch") {
				if ((await trySwitch(gen)) === "switched") {
					acted = true;
					break;
				}
			} else if ((await tryWait(gen)) === "waited") {
				acted = true;
				break;
			}
			if (gen !== generation || !state) return;
		}
		if (gen !== generation || !state) return;
		// A cycle that took no action would repeat identically: stop cleanly
		// instead of burning the remaining cycles.
		if (!acted) giveUp();
	}

	// ------------------------------------------------------------------
	// Events
	// ------------------------------------------------------------------

	function onQuotaHalt(current: ModelRef): Promise<void> {
		return enqueue(async () => {
			clearTimer();
			const onFallback =
				state !== null && state.fallbackInUse !== null && sameModel(state.fallbackInUse, current);
			if (onFallback && state && state.fallbackInUse) {
				// A fallback that fails with its own usage limit advances the
				// chain: next fallback, then wait, then a clean stop. Locals keep
				// the non-null narrowing inside the callback below.
				const active = state;
				const failedFallback = state.fallbackInUse; // narrowed non-null by the guard
				const index = config.fallbacks.findIndex((entry) => sameModel(entry, failedFallback));
				active.chainPos = Math.max(active.chainPos, index >= 0 ? index + 1 : config.fallbacks.length);
				active.current = current;
				active.phase = "recovering";
				active.waitingResetAtMs = null;
			} else {
				// A fresh failing prompt: a new recovery with a full budget.
				state = {
					original: current,
					current,
					chainPos: 0,
					fallbackInUse: null,
					cycles: 0,
					phase: "recovering",
					waitingResetAtMs: null,
				};
			}
			await runCycle();
		});
	}

	function onUserInput(): void {
		if (!state) return;
		if (state.phase !== "waiting") return; // typing never cancels the switch-back
		generation += 1;
		clearAll();
		// The user re-engaged: a Quota halt from their prompt starts a fresh cycle.
	}

	function onModelSelect(current: ModelRef): void {
		if (expectingRouterSelect) {
			// Our own setModel: the state update happened in trySwitch/switchBack.
			expectingRouterSelect = false;
			return;
		}
		if (!state) return;
		// A manual model change cancels the pending wait and the pending switch-back.
		generation += 1;
		clearAll();
		void current;
	}

	async function onIdle(current: ModelRef): Promise<void> {
		return enqueue(async () => {
			if (!state || state.phase !== "on-fallback" || !sameModel(state.fallbackInUse, current)) return;
			if (state.original.provider !== deps.quotaProviderId) return;
			const nowMs = deps.now();
			if (nowMs - lastSwitchBackCheck < SWITCH_BACK_CHECK_INTERVAL_MS) return;
			lastSwitchBackCheck = nowMs;
			await switchBackIfRecovered();
		});
	}

	async function onWaitTimerFires(): Promise<void> {
		await enqueue(async () => {
			if (!state || state.phase !== "waiting") return;
			const gen = generation;
			timer = null;
			state.phase = "recovering";
			state.waitingResetAtMs = null;
			const read = await deps.readQuota();
			if (gen !== generation || !state) return;
			const recovered = read.ok && read.snapshot.windows.every((window) => window.usedPercent < 100);
			if (recovered) {
				// One confirming read, then resume. The Recovery message is the
				// only visible trace; there is no separate "resumed" notification.
				const wasOnFallback = state.fallbackInUse !== null && !sameModel(state.fallbackInUse, state.original);
				if (wasOnFallback) {
					// The halted turn was on the fallback: restore the original,
					// then resume the task on it.
					await switchBackTo(state.original, true);
					return;
				}
				state = null;
				actions.persistPending(null);
				await actions.sendUserMessage(RECOVERY_MESSAGE);
				return;
			}
			// Still exhausted after the reset: another cycle, up to the bound.
			await runCycle();
		});
	}

	async function rearm(saved: PendingRecovery): Promise<void> {
		return enqueue(async () => {
			state = {
				original: saved.original,
				current: saved.fallbackInUse ?? saved.original,
				chainPos: saved.chainPos,
				fallbackInUse: saved.fallbackInUse,
				cycles: saved.cycles,
				phase: saved.phase,
				waitingResetAtMs: saved.phase === "waiting" ? (saved.resetAtMs ?? null) : null,
			};
			if (saved.phase === "waiting" && state.waitingResetAtMs === null) {
				// A waiting entry without a reset is corrupt: abandon it.
				state = null;
				actions.persistPending(null);
				return;
			}
			if (saved.phase === "on-fallback") {
				// Restore the pending switch-back and check now: if the quota is
				// already recovered, restore the original model immediately; if not,
				// the next idle re-checks.
				await switchBackIfRecovered();
				return;
			}
			// Phase waiting: time passed while pi was down, so confirm first.
			const gen = generation;
			const read = await deps.readQuota();
			if (gen !== generation || !state || state.phase !== "waiting") return;
			const recovered = read.ok && read.snapshot.windows.every((window) => window.usedPercent < 100);
			if (recovered) {
				// The quota reset while pi was down: resume the halted turn, the same
				// way the timer's confirming read does. On a fallback, restore the
				// original first; on the original, just resume.
				if (state.fallbackInUse !== null && !sameModel(state.fallbackInUse, state.original)) {
					await switchBackTo(state.original, true);
					return;
				}
				state = null;
				actions.persistPending(null);
				await actions.sendUserMessage(RECOVERY_MESSAGE);
				return;
			}
			const resetAtMs = state.waitingResetAtMs;
			if (resetAtMs === null) return; // defensive: the corrupt case above returned
			if (resetAtMs <= deps.now()) {
				// The waited-for reset has already passed: continue the recovery
				// (switch to the next fallback, or a clean stop) instead of
				// re-arming a timer that would fire immediately.
				state.phase = "recovering";
				state.waitingResetAtMs = null;
				await runCycle();
				return;
			}
			// The reset is still ahead: re-arm the timer (it confirms on fire).
			const delayMs = resetAtMs + WAIT_MARGIN_MS - deps.now();
			timer = deps.scheduleTimer(delayMs, () => void onWaitTimerFires());
		});
	}

	function shutdown(): void {
		generation += 1;
		clearTimer();
		state = null;
	}

	// ------------------------------------------------------------------
	// Switch-back
	// ------------------------------------------------------------------

	async function switchBackIfRecovered(): Promise<void> {
		const stateNow = state;
		if (!stateNow || stateNow.phase !== "on-fallback") return;
		const read = await deps.readQuota();
		if (!state || state.phase !== "on-fallback") return;
		if (!read.ok) return; // stay on the fallback; the next idle re-checks
		if (read.snapshot.windows.some((window) => window.usedPercent >= 100)) return;
		// No Recovery message: the turn that ended was not cut off.
		await switchBackTo(state.original, false);
	}

	async function switchBackTo(original: ModelRef, resume: boolean): Promise<void> {
		const stateNow = state;
		if (!stateNow) return;
		expectingRouterSelect = true;
		let ok = false;
		try {
			ok = await actions.setModel(original);
		} finally {
			expectingRouterSelect = false;
		}
		if (!state || state.original.provider !== original.provider || state.original.id !== original.id) return;
		if (!ok) return;
		state = null;
		actions.persistPending(null);
		actions.notify(`model-router: quota recovered; switched back to ${modelKey(original)}`, "info");
		if (resume) await actions.sendUserMessage(RECOVERY_MESSAGE);
	}

	return {
		onQuotaHalt,
		onUserInput,
		onModelSelect,
		onIdle,
		rearm,
		shutdown,
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours <= 0) return `${rest}m`;
	if (rest === 0) return `${hours}h`;
	return `${hours}h ${rest}m`;
}

function formatClock(epochMs: number): string {
	const date = new Date(epochMs);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
