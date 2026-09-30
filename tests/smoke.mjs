#!/usr/bin/env node
/**
 * Clean-install smoke test: proves the packages work when they are not this
 * checkout.
 *
 * - `npm pack` each adapter, then install the tarball into a throwaway prefix
 *   (this is the only way to catch packaging mistakes: missing `files`,
 *   `workspace:*` leaking into dependencies, an engine range nobody satisfies).
 * - Run the installed CLI `version` with the upstream pointed at a dead port:
 *   it must exit 0 offline.
 * - Start the installed MCP server over stdio and complete an
 *   initialize + tools/list handshake.
 *
 * Usage: pnpm smoke
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
function check(name, cond, detail = "") {
	if (cond) {
		console.log(`ok   ${name}`);
	} else {
		failed++;
		console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

async function pack(pkgDir) {
	const { stdout } = await exec("npm", ["pack", "--json"], { cwd: pkgDir });
	const info = JSON.parse(stdout);
	const entry = Array.isArray(info) ? info[0] : info;
	return {
		tarball: join(pkgDir, entry.filename),
		files: (entry.files ?? []).map((f) => f.path),
	};
}

async function install(tarball, prefix) {
	await exec(
		"npm",
		[
			"install",
			tarball,
			"--prefix",
			prefix,
			"--no-audit",
			"--no-fund",
			"--loglevel",
			"error",
		],
		{ timeout: 180000 },
	);
}

/** Minimal MCP stdio handshake against an installed server. */
function mcpHandshake(entry, cwd) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [entry], { cwd });
		let out = "";
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			try {
				child.kill();
			} catch {}
			resolve(out);
		};
		child.stdout.on("data", (d) => {
			out += d.toString();
			if (out.includes('"tools"')) {
				setTimeout(finish, 100);
			}
		});
		child.on("close", finish);
		setTimeout(finish, 20000);
		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "smoke", version: "0" },
				},
			})}\n`,
		);
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
		);
	});
}

const work = mkdtempSync(join(tmpdir(), "5c-smoke-"));
const tarballs = [];
try {
	// ---- CLI ----
	const cli = await pack(join(ROOT, "packages", "cli"));
	tarballs.push(cli.tarball);
	check(
		"cli tarball ships dist only",
		cli.files.some((f) => f.startsWith("dist/")) &&
			!cli.files.some((f) => f.startsWith("src/")),
		cli.files.slice(0, 6).join(","),
	);
	const cliPrefix = join(work, "cli");
	await install(cli.tarball, cliPrefix);
	const bin = join(cliPrefix, "node_modules", ".bin", "5c");
	const dataDir = join(work, "cache");
	const { stdout } = await exec(bin, ["version", "--json"], {
		env: {
			...process.env,
			FIVE_C_DATA_DIR: dataDir,
			// Dead port: version must not need the network.
			FIVE_C_API_BASE: "http://127.0.0.1:9",
		},
		timeout: 30000,
	});
	const version = JSON.parse(stdout);
	check(
		"installed CLI runs offline",
		version.ok === true &&
			version.command === "version" &&
			!!version.data.version,
		stdout.slice(0, 160),
	);

	// ---- MCP ----
	const mcp = await pack(join(ROOT, "packages", "mcp"));
	tarballs.push(mcp.tarball);
	check(
		"mcp tarball ships dist only",
		mcp.files.some((f) => f.startsWith("dist/")) &&
			!mcp.files.some((f) => f.startsWith("src/")),
		mcp.files.slice(0, 6).join(","),
	);
	const mcpPrefix = join(work, "mcp");
	await install(mcp.tarball, mcpPrefix);
	const server = join(mcpPrefix, "node_modules", "5c-mcp", "dist", "server.js");
	const handshake = await mcpHandshake(server, work);
	check(
		"installed MCP server answers tools/list",
		handshake.includes('"tools"') && handshake.includes("search_classes"),
		handshake.slice(0, 200),
	);
} finally {
	rmSync(work, { recursive: true, force: true });
	// npm pack leaves its artifacts in the package directories.
	for (const tarball of tarballs) rmSync(tarball, { force: true });
}

if (failed > 0) {
	console.log(`\nsmoke: ${failed} failure(s)`);
	process.exit(1);
}
console.log("\nsmoke: clean-install OK");
