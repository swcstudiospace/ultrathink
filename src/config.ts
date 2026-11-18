// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeAuthMode } from "./claude/complete.ts";
import type { PstackStage } from "./cursor/pstack.ts";
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "./gateway/types.ts";
import { DEFAULT_HINDSIGHT_CONFIG, type HindsightConfig } from "./hindsight/types.ts";
import { DEFAULT_RAGFLOW_CONFIG, type RagflowConfig } from "./ragflow/types.ts";
import { DEFAULT_DECISIONS_CONFIG, type DecisionsConfig } from "./decisions/types.ts";
import { DEFAULT_GROK_CONFIG, type GrokConfig } from "./grok/types.ts";
import { DEFAULT_HITL_CONFIG, type HitlConfig } from "./hitl/types.ts";
import { DEFAULT_SHIP_CONFIG, type ShipConfig } from "./ship/types.ts";
import { DEFAULT_MUSE_CONFIG, type MuseConfig } from "./muse/types.ts";
import {
	defaultRecallSettings,
	parseRecallSettings,
	type RecallSettings,
} from "./recall/config.ts";
import { DEFAULT_TEACH_CONFIG, type TeachConfig } from "./teach/types.ts";
import { MAX_NODES, MIN_NODES, type ThinkConfig } from "./think/types.ts";
import type { HostId } from "./host/types.ts";
import { type LegacyRoute, ROUTE_DEFAULT_MODELS } from "./route-defaults.ts";
import { readJson } from "./shared.ts";
import { asRecord } from "./config/fields.ts";
import { defaultTotModels, mergeModels, providerDictionary } from "./config/models.ts";
import { mergeClaude } from "./config/claude.ts";
import { mergeGrok } from "./config/grok.ts";
import { mergeMuse } from "./config/muse.ts";
import { mergeUplift } from "./config/uplift.ts";
import { mergeThink } from "./config/think.ts";
import { mergeHitl, tightenHitl } from "./config/hitl.ts";
import { mergeLinear, mergeNotion, mergeTrack, tightenTrack } from "./config/tracking.ts";
import { mergeShip, tightenShip } from "./config/ship.ts";
import { mergeDecisions } from "./config/decisions.ts";
import { mergeGateway, mergeHindsight, mergeRagflow, mergeSubstrate } from "./config/services.ts";
import { mergeTeach } from "./config/teach.ts";
import { mergePstack } from "./config/pstack.ts";
import { mergeState, mergeSwarm, mergeUi } from "./config/runtime.ts";

export interface ClaudeConfig {
	/** `claude` binary used for headless completions. A project file cannot set this. */
	bin: string;
	/**
	 * How the headless `claude -p` child authenticates. `plan` (default) strips API-key and cloud-provider env so the
	 * signed-in Claude plan login is used; `api-key` passes the environment through unchanged. A project file cannot set this.
	 */
	auth: ClaudeAuthMode;
	/**
	 * When a Claude call fails (plan limit, auth, outage), fail over to the Grok route. Off by default because prompt
	 * text then leaves Anthropic for xAI. A project file cannot set this.
	 */
	fallbackToGrok: boolean;
	/** Model alias/name for the uplift and thinking calls; empty inherits the user default. */
	model: string;
	/** Allow extended thinking in child calls (slower). */
	thinking: boolean;
	/** `--setting-sources` for child calls; empty loads none (fastest, no nested hooks). A project file cannot set this. */
	settingSources: string;
	/** Per-call timeout for one headless completion. 0 = no timer; capped at `MAX_TIMER_MS`. */
	callTimeoutMs: number;
	/** Whole-hook budget in ms. 0 = run until the host hook timeout; capped at `MAX_TIMER_MS`. */
	budgetMs: number;
	/** Parallel node-detail fills per dependency level. */
	concurrency: number;
	/** Print a one-line summary to the user after each uplift. */
	echo: boolean;
}

const DEFAULT_CLAUDE_CONFIG: ClaudeConfig = {
	bin: "claude",
	auth: "plan",
	fallbackToGrok: false,
	model: ROUTE_DEFAULT_MODELS.claude,
	thinking: false,
	settingSources: "",
	callTimeoutMs: 300_000,
	budgetMs: 900_000,
	concurrency: 3,
	echo: true,
};

export interface NotionConfig {
	/** Data source URL for the "Agent Task Graph" database (`collection://<id>`); "" = Notion tracking not configured. */
	dataSourceUrl: string;
}

const DEFAULT_NOTION_CONFIG: NotionConfig = {
	dataSourceUrl: "",
};

export interface LinearConfig {
	/** Linear team name that Issues/Sub-Issues are created under; "" = Linear tracking not configured. */
	team: string;
}

const DEFAULT_LINEAR_CONFIG: LinearConfig = {
	team: "",
};

export interface TrackConfig {
	/** Create Linear/Notion rows from the hook before the agent sees the prompt. */
	enabled: boolean;
	/** Whole tracker-creation budget in ms. 0 = no limit: no timer is created and the run waits for every row. Capped at `MAX_TIMER_MS`. */
	budgetMs: number;
	/** Parallel tracker calls. */
	concurrency: number;
}

const DEFAULT_TRACK_CONFIG: TrackConfig = {
	enabled: true,
	budgetMs: 600_000,
	concurrency: 6,
};

export interface SubstrateConfig {
	/** Agent Substrate service base URL (`POST <url>/brief`); "" = never contacted. `SUBSTRATE_URL` overrides it. */
	url: string;
	/**
	 * Absent or `"direct"` uses `POST /brief` and `POST /events`. `"gateway"` calls the desk gateway
	 * and does not need `url`. A project file cannot set this.
	 */
	backend?: "direct" | "gateway";
}

const DEFAULT_SUBSTRATE_CONFIG: SubstrateConfig = {
	url: "",
};

export interface StateConfig {
	/** Days a session record is kept before the scheduled prune may remove it; 0 = keep forever. User files only. */
	retentionDays: number;
}

const DEFAULT_STATE_CONFIG: StateConfig = {
	retentionDays: 0,
};

/** Stages a user mapping may remap: every pstack stage except `orchestrate`, the router that carries all moments. */
export type PstackMappingStage = Exclude<PstackStage, "orchestrate">;

/**
 * Cursor pstack bridge (`src/cursor/pstack.ts`): `/gsd-*` slash commands detected in Cursor's beforeSubmitPrompt
 * hook. Opt-in and user-only — every key comes from user files; a project layer is ignored entirely.
 */
export interface PstackConfig {
	/** Whether the bridge injects pstack skill instructions; only a user file can turn this on. */
	enabled: boolean;
	/** Absolute Cursor directory to resolve pstack from; absent uses the hook's own resolution. */
	cursorDir?: string;
	/** Per-stage skill names replacing the default mapping; unknown stages and non-string entries are dropped. */
	mapping?: Partial<Record<PstackMappingStage, string[]>>;
	/** Character cap for the injected context block. */
	contextCapChars?: number;
}

const DEFAULT_PSTACK_CONFIG: PstackConfig = {
	enabled: false,
	contextCapChars: 2000,
};

/**
 * AgentSwarm auto-run (`src/swarm/teams.ts`): plain prompts that read as SDLC work spawn swarm lanes without the
 * explicit `/ultrathink-swarm` command. Opt-in and user-only — every key comes from user files; a project layer is
 * ignored entirely, so a cloned repository cannot turn auto-spawning on.
 */
export interface SwarmConfig {
	/** Whether SDLC-sounding prompts auto-spawn swarm lanes; only a user file can turn this on. */
	autoRun: boolean;
}

const DEFAULT_SWARM_CONFIG: SwarmConfig = {
	autoRun: false,
};

/**
 * Display settings (`ui.*`). User files only: a project layer cannot change how the host draws. `reducedMotion` turns
 * off the live graph's spinner, flash and pop; the final state renders the same.
 */
export interface UiConfig {
	/** Whether the live graph draws without motion. Default false. */
	reducedMotion: boolean;
}

const DEFAULT_UI_CONFIG: UiConfig = {
	reducedMotion: false,
};

/** A per-host planning model override; "" in a field means no override for it. */
export interface HostModelOverride {
	/** Exact credential-bearing provider id the planning target must belong to; "" = no provider constraint. */
	provider: string;
	/** Opaque model or host selector; "" = no model override. */
	model: string;
}

/**
 * Cheapest-model routing for the Tree-of-Thought PRD stage (`models.tot`). `model` is the user's explicit override ("" =
 * none). `candidates` maps a provider family to its ordered cheapest-first model ids and doubles as the allowlist; the
 * built-in lists come from `TOT_PRD_CANDIDATES`. `breakerThreshold` is the number of consecutive cheap-model failures
 * after which the whole stage runs on the selected model. GoT and CoT never read any of it.
 */
export interface TotModelsConfig {
	model: string;
	candidates: Record<string, readonly string[]>;
	breakerThreshold: number;
}

/**
 * The Tree-of-Thought PRD stage (`think.tot`): one PRD per CoT Sub Issue, written after the tracker rows exist and synced
 * into them. `enabled` left unset follows tracking (on when tracking produced rows, so off when tracking is off); an
 * explicit boolean wins. `concurrency` is the PRDs written at once (1-16); `maxPrdChars` and `maxPrdLines` bound one PRD.
 */
export interface TotConfig {
	enabled?: boolean;
	concurrency: number;
	maxPrdChars: number;
	maxPrdLines: number;
}

/** `think` with the Tree-of-Thought stage settings; `ThinkConfig` stays the GoT/CoT part every think stage reads. */
export type ThinkSettings = ThinkConfig & { tot: TotConfig };

/**
 * Planning model selection (`models` in any config layer). `hosts` targets an existing host; `providerDefaults` maps an
 * exact credential provider id to the selector native Omp planning uses when the live model is unusable. Neither can
 * define endpoints, headers or credentials, and no legacy CLI route consumes `providerDefaults` (its eligible set is empty).
 */
export interface ModelsConfig {
	hosts: Partial<Record<HostId, HostModelOverride>>;
	providerDefaults: Record<string, string>;
	tot: TotModelsConfig;
}

/** Where an effective legacy route model came from: the route-default map, a nonblank file-layer pin, or a file-layer blank. */
export type LegacyModelProvenance = "route-default" | "file-pin" | "explicit-blank";

export interface UltrathinkConfig {
	uplift: { enabled: boolean; skipTrivial: boolean; echo: boolean; maxChars: number };
	claude: ClaudeConfig;
	grok: GrokConfig;
	hitl: HitlConfig;
	think: ThinkSettings;
	notion: NotionConfig;
	linear: LinearConfig;
	track: TrackConfig;
	muse: MuseConfig;
	ship: ShipConfig;
	substrate: SubstrateConfig;
	/** Jev decision points (OpenRouter Decisions API). Opt-in; no URL key by design (D1). */
	decisions: DecisionsConfig;
	/** Hindsight memory server (Teachable Moments storage). Opt-in; a project file can only turn it off. */
	hindsight: HindsightConfig;
	/** RAGFlow document search (planner grounding). Opt-in; a project file can only turn it off. */
	ragflow: RagflowConfig;
	/** Desk gateway used when an integration's backend is `gateway`. A project file cannot set it. */
	gateway: GatewayConfig;
	/** Teachable Moments capture, recall and promotion. Opt-in; a project file can only lower it. */
	teach: TeachConfig;
	/** On-disk session state. Opt-in retention; a project file can never set it. */
	state: StateConfig;
	/** Cursor pstack bridge (opt-in; user files only — a project layer cannot enable or retarget it). */
	pstack: PstackConfig;
	/** AgentSwarm auto-run (opt-in; user files only — a project layer cannot enable it). */
	swarm: SwarmConfig;
	/** Display settings (`ui.*`). User files only; a project layer is ignored. */
	ui: UiConfig;
	/** Recall, knowledge-probe, skill-authoring and information-panel settings. User files only; a project layer is ignored. */
	recallSettings: RecallSettings;
	/** Planning model overrides and exact-provider default selectors; built-in `{ hosts: {}, providerDefaults: {} }`. */
	models: ModelsConfig;
	/**
	 * Provenance of the effective `claude.model`, `grok.model` and `muse.model`, recorded by the merge in memory only and never
	 * read from a config file. `grok` is never "explicit-blank": its non-empty merge ignores blanks.
	 */
	modelProvenance: Readonly<Record<LegacyRoute, LegacyModelProvenance>>;
}

/** Defaults for `think.fillRetries` (extra attempts per node fill) and `think.repair` (one repair pass). */
const THINK_RESILIENCE_DEFAULTS: Pick<ThinkConfig, "fillRetries" | "repair"> = {
	fillRetries: 2,
	repair: true,
};

/** Defaults for `think.tot`; the limits mirror the PRD template's own (150 lines, 6000 characters) and 4 PRDs at a time. */
const DEFAULT_TOT_CONFIG: TotConfig = { concurrency: 4, maxPrdChars: 6000, maxPrdLines: 150 };

export function defaultConfig(): UltrathinkConfig {
	return {
		uplift: {
			enabled: true,
			skipTrivial: true,
			echo: true,
			maxChars: 0,
		},
		think: {
			enabled: true,
			minNodes: MIN_NODES,
			maxNodes: MAX_NODES,
			engine: "auto",
			reasoningCeiling: "inherit",
			...THINK_RESILIENCE_DEFAULTS,
			tot: { ...DEFAULT_TOT_CONFIG },
		},
		claude: { ...DEFAULT_CLAUDE_CONFIG },
		grok: { ...DEFAULT_GROK_CONFIG, fallbackModels: [...DEFAULT_GROK_CONFIG.fallbackModels] },
		muse: { ...DEFAULT_MUSE_CONFIG },
		hitl: { ...DEFAULT_HITL_CONFIG },
		notion: { ...DEFAULT_NOTION_CONFIG },
		linear: { ...DEFAULT_LINEAR_CONFIG },
		track: { ...DEFAULT_TRACK_CONFIG },
		ship: {
			...DEFAULT_SHIP_CONFIG,
			skills: [...DEFAULT_SHIP_CONFIG.skills],
			owners: [...DEFAULT_SHIP_CONFIG.owners],
		},
		substrate: { ...DEFAULT_SUBSTRATE_CONFIG },
		decisions: { ...DEFAULT_DECISIONS_CONFIG, points: [...DEFAULT_DECISIONS_CONFIG.points] },
		hindsight: { ...DEFAULT_HINDSIGHT_CONFIG },
		ragflow: { ...DEFAULT_RAGFLOW_CONFIG, datasetIds: [...DEFAULT_RAGFLOW_CONFIG.datasetIds] },
		gateway: { ...DEFAULT_GATEWAY_CONFIG },
		teach: { ...DEFAULT_TEACH_CONFIG },
		state: { ...DEFAULT_STATE_CONFIG },
		pstack: { ...DEFAULT_PSTACK_CONFIG },
		swarm: { ...DEFAULT_SWARM_CONFIG },
		ui: { ...DEFAULT_UI_CONFIG },
		recallSettings: defaultRecallSettings(),
		models: { hosts: {}, providerDefaults: providerDictionary({}), tot: defaultTotModels() },
		modelProvenance: { claude: "route-default", grok: "route-default", muse: "route-default" },
	};
}

/** What a layer leaves on a legacy route model's provenance; a blank clears Claude and Muse, Grok's non-empty merge ignores it. */
function modelPin(
	section: Record<string, unknown> | undefined,
	lower: LegacyModelProvenance,
	blankClears: boolean,
): LegacyModelProvenance {
	const model = section?.model;
	if (typeof model !== "string") return lower;
	if (model.trim()) return "file-pin";
	return blankClears ? "explicit-blank" : lower;
}

/** Merges one config layer onto `base`; `project` marks a repository-controlled layer (consent may only tighten, K5). */
export function mergeConfig(
	file: Record<string, unknown> | undefined,
	base: UltrathinkConfig,
	options: { project?: boolean } = {},
): UltrathinkConfig {
	if (!file) return base;
	const claude = asRecord(file.claude);
	const grok = asRecord(file.grok);
	const muse = asRecord(file.muse);
	return {
		uplift: mergeUplift(asRecord(file.uplift), base.uplift, options.project === true),
		claude: mergeClaude(claude, base.claude, options.project === true),
		grok: mergeGrok(grok, base.grok, options.project === true),
		muse: mergeMuse(muse, base.muse, options.project === true),
		hitl:
			options.project === true
				? tightenHitl(asRecord(file.hitl), base.hitl)
				: mergeHitl(asRecord(file.hitl), base.hitl),
		think: options.project === true ? base.think : mergeThink(asRecord(file.think), base.think),
		// A repository file never chooses where tracker writes go (notion.dataSourceUrl, linear.team): your own config does.
		notion:
			options.project === true ? base.notion : mergeNotion(asRecord(file.notion), base.notion),
		linear:
			options.project === true ? base.linear : mergeLinear(asRecord(file.linear), base.linear),
		track:
			options.project === true
				? tightenTrack(asRecord(file.track), base.track)
				: mergeTrack(asRecord(file.track), base.track),
		ship:
			options.project === true
				? tightenShip(asRecord(file.ship), base.ship)
				: mergeShip(asRecord(file.ship), base.ship),
		substrate: mergeSubstrate(asRecord(file.substrate), base.substrate, options.project === true),
		decisions: mergeDecisions(asRecord(file.decisions), base.decisions, options.project === true),
		hindsight: mergeHindsight(asRecord(file.hindsight), base.hindsight, options.project === true),
		ragflow: mergeRagflow(asRecord(file.ragflow), base.ragflow, options.project === true),
		gateway: mergeGateway(asRecord(file.gateway), base.gateway, options.project === true),
		teach: mergeTeach(asRecord(file.teach), base.teach, options.project === true),
		state: mergeState(asRecord(file.state), base.state, options.project === true),
		pstack: mergePstack(asRecord(file.pstack), base.pstack, options.project === true),
		swarm: mergeSwarm(asRecord(file.swarm), base.swarm, options.project === true),
		ui: mergeUi(asRecord(file.ui), base.ui, options.project === true),
		recallSettings:
			options.project === true
				? base.recallSettings
				: parseRecallSettings(file, base.recallSettings),
		models: mergeModels(asRecord(file.models), base.models, options.project === true),
		modelProvenance: {
			claude: modelPin(claude, base.modelProvenance.claude, true),
			grok: modelPin(grok, base.modelProvenance.grok, false),
			muse: modelPin(muse, base.modelProvenance.muse, true),
		},
	};
}

/** Host-neutral user config: `${XDG_CONFIG_HOME || ~/.config}/ultrathink/config.json`. */
export function userConfigPath(env: Record<string, string | undefined> = process.env): string {
	return join(
		env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
		"ultrathink",
		"config.json",
	);
}

/** A config file: a plain path merges as a user layer; `{ path, project: true }` is a repository-controlled project layer. */
export type ConfigSource = string | { path: string; project: true };

/** Config files for ultrathink, lowest precedence first — later files win: user, then Claude user, then project. */
export function claudeConfigPaths(
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): ConfigSource[] {
	const home = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return [
		userConfigPath(env),
		join(home, "ultrathink.json"),
		{ path: join(cwd, ".claude", "ultrathink.json"), project: true },
	];
}

/** Loads config from `files` in order (later files win); defaults when none override. */
export function loadConfig(files: readonly ConfigSource[]): UltrathinkConfig {
	let config = defaultConfig();
	for (const file of files) {
		const project = typeof file !== "string";
		config = mergeConfig(asRecord(readJson(project ? file.path : file)), config, { project });
	}
	return config;
}
