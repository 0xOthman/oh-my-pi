import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const temp = TempDir.createSync("@pi-eval-tree-fork-");
let session: AgentSession | undefined;
let fork: AgentSession | undefined;
let auth: AuthStorage | undefined;

afterEach(async () => {
	await fork?.dispose();
	await session?.dispose();
	auth?.close();
	temp.removeSync();
});

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(model: Model, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		usage,
		timestamp: Date.now(),
	};
}

/** Session whose branch ran `eval`, answered, then moved on; returns the answer after the eval result. */
async function setup() {
	auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const settings = Settings.isolated();
	const manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
	const evalToolSession: ToolSession = {
		cwd: temp.path(),
		hasUI: false,
		settings,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => "eval-tree-fork-repro",
	};
	const open = (sessionManager: SessionManager) =>
		new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: sessionManager.buildSessionContext().messages,
				},
			}),
			sessionManager,
			settings,
			modelRegistry: registry,
			evalToolSession,
		});
	manager.appendMessage({ role: "user", content: "Remember ALPHA", timestamp: Date.now() });
	manager.appendMessage(assistant(model, [{ type: "text", text: "noted" }]));
	manager.appendMessage({ role: "user", content: "Run eval", timestamp: Date.now() });
	manager.appendMessage(
		assistant(model, [{ type: "toolCall", id: "eval-1", name: "eval", arguments: { code: "x = 41 + 1" } }]),
	);
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "eval-1",
		toolName: "eval",
		content: [{ type: "text", text: "42" }],
		isError: false,
		timestamp: Date.now(),
	});
	const jumpTarget = manager.appendMessage(assistant(model, [{ type: "text", text: "42" }]));
	manager.appendMessage({ role: "user", content: "Now BETA", timestamp: Date.now() });
	const latest = manager.appendMessage(assistant(model, [{ type: "text", text: "noted" }]));
	session = open(manager);
	return { model, manager, open, jumpTarget, latest };
}

const shape = (messages: AgentMessage[]) =>
	messages.map(message => ({
		role: message.role,
		content: "content" in message ? message.content : undefined,
	}));

it("keeps the tree-navigation eval context in the fork's provider prefix", async () => {
	const { model, manager, open, jumpTarget } = await setup();
	if (!session) throw new Error("Expected a session");

	await session.navigateTree(jumpTarget);
	for (const message of [
		{ role: "user", content: "Reply ok", timestamp: Date.now() } satisfies AgentMessage,
		assistant(model, [{ type: "text", text: "ok" }]),
	]) {
		manager.appendMessage(message);
		session.agent.appendMessage(message);
	}

	const file = session.sessionFile;
	if (!file) throw new Error("Expected a persisted session");
	await manager.flush();
	fork = open(await SessionManager.forkFrom(file, temp.path(), path.join(temp.path(), "forks")));
	expect(session.messages.some(m => m.role === "custom" && m.customType === "eval-state-context")).toBe(true);
	expect(shape(fork.messages)).toEqual(shape(session.messages));
});

it("reuses the persisted eval snapshot when navigating back to the same point", async () => {
	const { manager, jumpTarget, latest } = await setup();
	if (!session) throw new Error("Expected a session");

	await session.navigateTree(jumpTarget);
	const snapshotId = manager.getLeafId();
	if (snapshotId === null || snapshotId === jumpTarget) throw new Error("Expected a persisted eval snapshot");
	await session.navigateTree(latest);
	await session.navigateTree(jumpTarget);

	const snapshots = manager
		.getChildren(jumpTarget)
		.filter(entry => entry.type === "message" && entry.message.role === "custom");
	expect(snapshots.map(entry => entry.id)).toEqual([snapshotId]);
	expect(manager.getLeafId()).toBe(snapshotId);
	expect(shape(session.messages)).toEqual(shape(manager.buildSessionContext().messages));
});
