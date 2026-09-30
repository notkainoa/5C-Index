import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	outDir: "dist",
	banner: { js: "#!/usr/bin/env node" },
	noExternal: ["5c-core"],
});
