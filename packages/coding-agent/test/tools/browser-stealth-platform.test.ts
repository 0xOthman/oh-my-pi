import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	getSessionId: () => "browser-stealth-platform-test-owner",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"browser.tern": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-stealth-platform-test" };
let server: Bun.Server<undefined>;
let pageUrl = "";

interface ContextIdentity {
	userAgent: string;
	platform: string;
	uaPlatform: string;
}

interface NavigatorIdentity {
	page: ContextIdentity & { architecture: string; platformVersion: string };
	workers: Record<string, ContextIdentity>;
}

interface DeviceIdentity extends ContextIdentity {
	brands: Array<{ brand: string; version: string }>;
	mobile: boolean;
	architecture: string;
	platformVersion: string;
	requestUserAgent: string;
}

const REPORT =
	"({ userAgent: navigator.userAgent, platform: navigator.platform, uaPlatform: navigator.userAgentData.platform })";
const DEVICE_REPORT = `async () => {
	const hints = await navigator.userAgentData.getHighEntropyValues(["architecture", "platformVersion"]);
	return {
		...${REPORT},
		brands: navigator.userAgentData.brands,
		mobile: navigator.userAgentData.mobile,
		architecture: hints.architecture,
		platformVersion: hints.platformVersion,
		requestUserAgent: await (await fetch("/ua")).text(),
	};
}`;
const WORKER_SCRIPTS: Record<string, string> = {
	"/worker.js": `postMessage(${REPORT});`,
	"/nested.js": `const worker = new Worker(new URL("/worker.js", location.origin)); worker.onmessage = event => postMessage(event.data);`,
	"/shared.js": `onconnect = event => event.ports[0].postMessage(${REPORT});`,
	"/sw.js": `onmessage = event => event.source.postMessage(${REPORT});`,
	"/device-shared.js": `onconnect = async event => event.ports[0].postMessage(await (${DEVICE_REPORT})());`,
	"/device-sw.js": `onmessage = async event => event.source.postMessage(await (${DEVICE_REPORT})());`,
};

const IDENTITY_CODE = `return await tab.evaluate(async source => {
	const fromWorker = worker => {
		const { promise, resolve, reject } = Promise.withResolvers();
		worker.onmessage = event => resolve(event.data);
		worker.onerror = event => reject(new Error(event.message));
		return promise;
	};
	const fromPort = port => {
		const { promise, resolve } = Promise.withResolvers();
		port.onmessage = event => resolve(event.data);
		port.start();
		return promise;
	};
	const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
	const pending = {
		classicBlob: fromWorker(new Worker(blobUrl)),
		moduleBlob: fromWorker(new Worker(blobUrl, { type: "module" })),
		named: fromWorker(new Worker("/worker.js", { name: "named" })),
		nested: fromWorker(new Worker("/nested.js")),
		shared: fromPort(new SharedWorker("/shared.js", { name: "shared", type: "module" }).port),
	};
	await navigator.serviceWorker.register("/sw.js");
	const registration = await navigator.serviceWorker.ready;
	const service = Promise.withResolvers();
	navigator.serviceWorker.onmessage = event => service.resolve(event.data);
	registration.active.postMessage("report");
	pending.service = service.promise;
	const workers = {};
	for (const [kind, report] of Object.entries(pending)) workers[kind] = await report;
	const highEntropy = await navigator.userAgentData.getHighEntropyValues(["architecture", "platformVersion"]);
	return {
		page: {
			userAgent: navigator.userAgent,
			platform: navigator.platform,
			uaPlatform: navigator.userAgentData.platform,
			architecture: highEntropy.architecture,
			platformVersion: highEntropy.platformVersion,
		},
		workers,
	};
}, ${JSON.stringify(WORKER_SCRIPTS["/worker.js"])})`;

async function runInTab<T>(name: string, code: string): Promise<T> {
	const result = await prelude.invoke({ action: "run", name, code }, context);
	const details = result.details;
	if (typeof details !== "object" || details === null || !("value" in details)) {
		throw new Error(`tab ${name} returned no value`);
	}
	return details.value as T;
}

function identity(name: string): Promise<NavigatorIdentity> {
	return runInTab(name, IDENTITY_CODE);
}

function expectConsistentIdentity({ page, workers }: NavigatorIdentity): void {
	if (page.userAgent.includes("Windows")) {
		expect(page.platform).toBe("Win32");
		expect(page.uaPlatform).toBe("Windows");
		// Windows 11 reports 13.0.0 or later; Windows 10 never reports a bare "10.0".
		expect(Number.parseInt(page.platformVersion, 10)).toBeGreaterThanOrEqual(13);
		if (page.userAgent.includes("x64")) expect(page.architecture).toBe("x86");
	} else if (page.userAgent.includes("Macintosh")) {
		expect(page.platform).toBe("MacIntel");
	} else {
		expect(page.platform).toStartWith("Linux");
	}
	const expected = { userAgent: page.userAgent, platform: page.platform, uaPlatform: page.uaPlatform };
	expect(workers).toEqual({
		classicBlob: expected,
		moduleBlob: expected,
		named: expected,
		nested: expected,
		shared: expected,
		service: expected,
	});
}

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: request => {
			if (new URL(request.url).pathname === "/ua") return new Response(request.headers.get("user-agent"));
			const script = WORKER_SCRIPTS[new URL(request.url).pathname];
			if (script) return new Response(script, { headers: { "Content-Type": "text/javascript" } });
			return new Response("<!doctype html><title>platform fixture</title>", {
				headers: { "Content-Type": "text/html" },
			});
		},
	});
	pageUrl = `http://127.0.0.1:${server.port}/`;
});

afterAll(async () => {
	server?.stop(true);
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("headless stealth navigator identity", () => {
	// Fingerprinters flag a UA that claims Windows next to a Linux `navigator.platform`,
	// UA-CH platform, or arm architecture, in the page or any worker kind. Opening a
	// second tab re-applies the override to every existing target and closing it
	// detaches its sessions; either used to revert another tab's identity.
	it("keeps every tab and worker kind consistent with the UA as tabs open and close", async () => {
		await prelude.invoke({ action: "open", name: "platform-a", url: pageUrl }, context);
		try {
			await prelude.invoke({ action: "open", name: "platform-b", url: pageUrl }, context);
			try {
				expectConsistentIdentity(await identity("platform-a"));
				expectConsistentIdentity(await identity("platform-b"));
			} finally {
				await prelude.invoke({ action: "close", name: "platform-b" }, context);
			}
			expectConsistentIdentity(await identity("platform-a"));
		} finally {
			await prelude.invoke({ action: "close", name: "platform-a" }, context);
		}
	}, 60_000);

	// The worker patch only replaces the host or stealth identity: a tab emulating a
	// device must not get the desktop stealth UA back inside its workers.
	it("leaves a device-emulated tab's workers reporting the device identity", async () => {
		await prelude.invoke({ action: "open", name: "platform-device", url: pageUrl }, context);
		try {
			const { page, worker, shared, service } = await runInTab<{
				page: DeviceIdentity;
				worker: ContextIdentity;
				shared: DeviceIdentity;
				service: DeviceIdentity;
			}>(
				"platform-device",
				`await tab.emulate({ device: "iPhone 14" });
await tab.goto(${JSON.stringify(`${pageUrl}device/`)});
return await tab.evaluate(async () => {
	const workerReport = Promise.withResolvers();
	new Worker("/worker.js", { name: "device" }).onmessage = event => workerReport.resolve(event.data);
	const sharedReport = Promise.withResolvers();
	const port = new SharedWorker("/device-shared.js", { name: "device-shared" }).port;
	port.onmessage = event => sharedReport.resolve(event.data);
	port.start();
	await navigator.serviceWorker.register("/device-sw.js", { scope: "/device/" });
	const registration = await navigator.serviceWorker.ready;
	const serviceReport = Promise.withResolvers();
	navigator.serviceWorker.onmessage = event => serviceReport.resolve(event.data);
	registration.active.postMessage("report");
	const page = await (${DEVICE_REPORT})();
	return {
		page: { ...page, platform: navigator.platform },
		worker: await workerReport.promise,
		shared: await sharedReport.promise,
		service: await serviceReport.promise,
	};
});`,
			);
			expect(page.userAgent).toContain("iPhone");
			expect(worker).toEqual({
				userAgent: page.userAgent,
				platform: page.platform,
				uaPlatform: page.uaPlatform,
			});
			expect(shared).toEqual(page);
			expect(service).toEqual(page);
		} finally {
			await prelude.invoke({ action: "close", name: "platform-device" }, context);
		}
	}, 60_000);
});
