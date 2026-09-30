export const FA2026: string;
export const SP2026: string;
export const UNPUBLISHED_TERM: string;
export const CURRENT_TERM: string;
export const TERM_LIST: { year: number; term: string }[];

export function fa2026Sections(): unknown[];
export function sp2026Sections(): unknown[];
export function fa2026History(): unknown[];

export interface FixtureServer {
	url: string;
	port: number;
	requests: { method?: string; path: string }[];
	close(): Promise<void>;
}

export function startFixtureServer(): Promise<FixtureServer>;
