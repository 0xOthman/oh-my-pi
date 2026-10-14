import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { ensureTool } from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as piUtils from "@oh-my-pi/pi-utils";

afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32")("does not launch pip after an interrupted uv install", async () => {
	using temp = TempDir.createSync("@omp-tool-install-");
	const uv = temp.join("uv");
	const pip = temp.join("pip3");
	const ready = temp.join("uv-started");
	await Bun.write(uv, `#!/bin/sh\nprintf ready > ${JSON.stringify(ready)}\nexec sleep 10\n`);
	await Bun.write(pip, "#!/bin/sh\nexit 0\n");
	await fs.chmod(uv, 0o755);
	await fs.chmod(pip, 0o755);
	vi.spyOn(piUtils, "$which").mockImplementation(command => (command === "uv" ? uv : command === "pip3" ? pip : null));
	const spawnSpy = vi.spyOn(Bun, "spawn");

	const controller = new AbortController();
	const installing = ensureTool("trafilatura", { signal: controller.signal, silent: true });
	// Real subprocess startup cannot be driven by fake timers; wait for the uv fixture to signal readiness.
	const deadline = Date.now() + 2_000;
	while (!(await Bun.file(ready).exists()) && Date.now() < deadline) await Bun.sleep(10);
	expect(await Bun.file(ready).exists()).toBe(true);
	controller.abort(new Error("fetch deadline"));
	expect(await installing).toBeUndefined();
	expect(spawnSpy.mock.calls.some(([command]) => Array.isArray(command) && command[0] === pip)).toBe(false);
});
