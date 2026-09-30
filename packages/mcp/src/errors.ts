/**
 * Core error → MCP tool error.
 *
 * One mapping, shared by every tool. Codes and recovery hints are the same
 * vocabulary the CLI speaks, so an agent that learns one adapter reads the
 * other. Errors stay `isError: true` text (no structuredContent), which the
 * SDK exempts from output validation.
 */
export type ToolError = {
	isError: true;
	content: { type: "text"; text: string }[];
};

interface CoreError {
	code?: string;
	message: string;
	hint?: string;
	available?: string[];
	not_found?: string[];
}

/** Codes whose cause is transient: retry is a reasonable recovery. */
const RETRYABLE = new Set(["E_FETCH", "E_NO_CURRENT_TERM"]);

function recoveryOf(e: CoreError): string {
	switch (e.code) {
		case "E_TERM_NOT_FOUND":
		case "E_BAD_TERM":
			return e.available?.length
				? `Recovery: call list_terms and retry with one of ${e.available.join(", ")}, or pass allow_term_fallback: true to serve the newest.`
				: "Recovery: call list_terms and retry with an available term.";
		case "E_NO_CURRENT_TERM":
			return "Recovery: pass an explicit term; retry once the network is reachable.";
		case "E_NOT_FOUND":
			return "Recovery: search_classes to resolve the ID, then pass it verbatim. Loose or partial IDs are never guessed at.";
		case "E_BAD_FILTER":
		case "E_USAGE":
			return "Recovery: fix the named argument and retry; nothing was fetched.";
		default:
			return RETRYABLE.has(e.code ?? "")
				? "Recovery: retry once. If it fails again, report what you have and its timestamp."
				: "Recovery: report the failure; do not substitute another term's data.";
	}
}

export function toolError(err: unknown): ToolError {
	const e = (err ?? {}) as CoreError;
	const parts = [e.message ?? String(err)];
	if (e.not_found?.length) parts.push(`Unresolved: ${e.not_found.join(", ")}.`);
	if (e.hint && e.hint !== e.message) parts.push(e.hint);
	parts.push(recoveryOf(e));
	if (e.code) parts.push(`(code: ${e.code})`);
	return {
		isError: true,
		content: [{ type: "text", text: parts.join(" ") }],
	};
}
