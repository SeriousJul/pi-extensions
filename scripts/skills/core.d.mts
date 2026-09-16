// Type declarations for scripts/skills/core.mjs.

export interface SkillSource {
	repo: string;
	root: string;
	pin: string;
	upstreamRoot?: string;
}

export type SkillTree = Record<string, { files: Record<string, string> }>;

export interface MergeFileResult {
	clean: boolean;
	content: string;
}

export type MergeFile = (base: string | null, ours: string | null, theirs: string | null) => MergeFileResult;

export type SkillStatus = "clean" | "unchanged" | "conflict" | "orphan" | "offer";

export interface PlannedFile {
	path: string;
	action: "write" | "keep" | "conflict";
}

export interface PlannedSkill {
	name: string;
	status: SkillStatus;
	files: PlannedFile[];
	notes: string[];
}

export interface Plan {
	skills: PlannedSkill[];
	writes: Record<string, Record<string, string>>;
	offers: string[];
	orphans: string[];
	advancePin: boolean;
}

export interface PlanSourceInput {
	pin: string;
	fetched: string;
	localSkills: SkillTree;
	pinTree: SkillTree;
	fetchedTree: SkillTree;
	mergeFile: MergeFile;
}

export declare const MANIFEST_NAME: string;
export declare const CACHE_DIR_NAME: string;
export declare const GIT_TIMEOUT_MS: number;
export declare const MAX_BUFFER: number;

export declare function git(args: string[], options?: Record<string, unknown>): string | Buffer;

export declare function loadManifest(repoRoot: string): Record<string, SkillSource>;
export declare function saveManifest(repoRoot: string, manifest: Record<string, SkillSource>): void;

export declare function refreshCache(cacheDir: string, repo: string): { commit: string; branch: string };
export declare function ensureCommitCached(cacheDir: string, commit: string): void;

export declare function readUpstreamTree(cacheDir: string, commit: string, upstreamRoot: string): SkillTree;
export declare function scanLocalSkills(rootDir: string): SkillTree;

export declare function gitMergeFile(base: string | null, ours: string | null, theirs: string | null): MergeFileResult;
export declare function planSource(input: PlanSourceInput): Plan;
