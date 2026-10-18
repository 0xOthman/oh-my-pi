# Extension Examples

Example extensions for pi-coding-agent.

## Usage

```bash
# Load an extension with --extension flag
pi --extension examples/extensions/permission-gate.ts

# Or copy to extensions directory for auto-discovery
cp permission-gate.ts ~/.omp/agent/extensions/
```

## Examples

### Lifecycle & Safety

| Extension                | Description                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- |
| `permission-gate.ts`     | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, etc.) |
| `protected-paths.ts`     | Blocks writes to protected paths (.env, .git/, node_modules/)                |
| `confirm-destructive.ts` | Confirms before destructive session actions (clear, switch, branch)          |
| `dirty-repo-guard.ts`    | Prevents session changes with uncommitted git changes                        |

### Custom Tools

| Extension     | Description                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| `todo.ts`     | Todo list tool + `/todos` command with custom rendering and state persistence |
| `hello.ts`    | Minimal custom tool example                                                   |
| `question.ts` | Demonstrates `ctx.ui.select()` for asking the user questions                  |
| `subagent/`   | Delegate tasks to specialized subagents with isolated context windows         |

### Commands & UI

| Extension          | Description                                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| `plan-mode.ts`     | Claude Code-style plan mode for read-only exploration with `/plan` command     |
| `tools.ts`         | Interactive `/tools` command to enable/disable tools with session persistence  |
| `handoff.ts`       | Transfer context to a new focused session via `/handoff <goal>`                |
| `qna.ts`           | Extracts questions from last response into editor via `ctx.ui.setEditorText()` |
| `status-line.ts`   | Shows turn progress in footer via `ctx.ui.setStatus()` with themed colors      |
| `thinking-note.ts` | Adds display-only supplemental UI below assistant thinking blocks              |
| `snake.ts`         | Snake game with custom UI, keyboard handling, and session persistence          |
| `arabic-rtl.ts`    | Opt-in Windows Arabic shaping and bidirectional display for Composer output |

#### Arabic/RTL display on Windows

`arabic-rtl.ts` uses Windows `icu.dll` through Bun FFI to shape Arabic letters
and reorder mixed-direction text for terminals without native bidi rendering.
Load it explicitly:

```powershell
omp --extension ./packages/coding-agent/examples/extensions/arabic-rtl.ts
```

Alternatively, copy the file to `~/.omp/agent/extensions/` and restart omp.
Remove the file and restart to uninstall. Do not enable it in a terminal that
already performs bidirectional layout: text would be reordered twice.
It does nothing on non-Windows systems and requires Windows `icu.dll`.

The extension transforms Composer transcript/history, input, and resize output,
not stored messages or model input. All eight built-in input shapes transform
their text before adding padding, gutters, and borders. Every typed space stays
in the text, including spaces after the caret; completed editor rows are not
reordered a second time by the transcript pass. Custom extension-owned shapes
do not have this chrome-isolation guarantee.

Use omp's copy command for original logical text; terminal drag-selection
copies the displayed presentation glyphs. Arrow keys still navigate logical
text, not visual order. Existing word wrapping is unchanged; native Tern surfaces
and other fullscreen overlays retain their own renderers.
Rows that fail shaping, bidi ordering, or the terminal-width check are emitted
unchanged; failed rows are not cached, so later renders can recover.

Bidirectional ordering is row-local, after existing word wrapping. The frame
strings do not identify paragraph boundaries or soft-wrap continuations. A
continuation beginning with English can therefore choose a different base
direction from its original Arabic paragraph. Correct paragraph-level layout
requires an earlier paragraph-aware hook or wrap metadata; this example does
not infer paragraph direction from neighbouring rows.

The patch is process-wide: it affects every Composer and built-in shape,
including editor previews and other sessions in an SDK host. Do not use it where
sessions need independent display settings. `/reload` does not undo the patch or
replace an already installed copy; remove the file and fully restart omp to
uninstall it. It wraps internal Composer prototype methods and shared built-in
shape callbacks with no stability contract, so compatibility must be checked
after omp upgrades. This is an opt-in workaround, not general RTL support.

Run the example's regression coverage from the repository root:

```bash
bun test packages/coding-agent/test/arabic-rtl.test.ts
```

Native-library failure and opaque-terminal-command cases run on every platform.
Real ICU shaping and caret-layout cases require Windows; the Linux CI jobs do
not exercise those native cases.

### Git Integration

| Extension                | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `git-checkpoint.ts`      | Creates git stash checkpoints at each turn for code restoration on branch |
| `auto-commit-on-exit.ts` | Auto-commits on exit using last assistant message for commit message      |

### System Prompt & Compaction

| Extension              | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `pirate.ts`            | Demonstrates `systemPromptAppend` to dynamically modify system prompt |
| `custom-compaction.ts` | Custom compaction that summarizes entire conversation                 |

### External Dependencies

| Extension         | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `chalk-logger.ts` | Uses chalk from parent node_modules (demonstrates jiti module resolution) |
| `with-deps/`      | Extension with its own package.json and dependencies                      |
| `file-trigger.ts` | Watches a trigger file and injects contents into conversation             |

## Writing Extensions

See [docs/extensions.md](../../docs/extensions.md) for full documentation.

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const z = pi.zod;

	// Subscribe to lifecycle events
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
			const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
	});

	// Register custom tools
	pi.registerTool({
		name: "greet",
		label: "Greeting",
		description: "Generate a greeting",
		parameters: z.object({
			name: z.string().describe("Name to greet"),
		}),
		async execute(toolCallId, params, onUpdate, ctx, signal) {
			return {
				content: [{ type: "text", text: `Hello, ${params.name}!` }],
				details: {},
			};
		},
	});

	// Register commands
	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			ctx.ui.notify("Hello!", "info");
		},
	});
}
```

## Key Patterns

**Use `z.enum` for discriminated string tool args:**

```typescript
const z = pi.zod;

parameters: z.object({
	action: z.enum(["list", "add"]),
});
```

**State persistence via details:**

```typescript
// Store state in tool result details for proper branching support
return {
	content: [{ type: "text", text: "Done" }],
	details: { todos: [...todos], nextId }, // Persisted in session
};

// Reconstruct on session events
pi.on("session_start", async (_event, ctx) => {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.toolName === "my_tool") {
			const details = entry.message.details;
			// Reconstruct state from details
		}
	}
});
```
