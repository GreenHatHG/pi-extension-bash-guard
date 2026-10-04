/**
 * Shared pi runtime mock: fakes extension registration, commands, message injection,
 * tool_result rewriting, session entry replay, and the status bar. Each test gets its own instance,
 * so nothing leaks between tests.
 */
export type Handler = (event: any, ctx: any) => Promise<any>;

export interface SessionEntry {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; content: any };
}

export function createMockRuntime() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sessionEntries: SessionEntry[] = [];
	const notifications: { msg: string; kind: string }[] = [];
	const statusBars = new Map<string, string | undefined>();
	const sentUserMessages: Array<{ content: string; options?: unknown }> = [];

	const ctx: any = {
		hasUI: true,
		cwd: "/project",
		isIdle: () => true,
		sessionManager: {
			getBranch: () => sessionEntries,
		},
		ui: {
			notify: (msg: string, kind = "info") => notifications.push({ msg, kind }),
			setStatus: (key: string, val: string | undefined) => statusBars.set(key, val),
			select: async () => undefined,
			editor: async () => undefined,
		},
	};

	const pi: any = {
		on: (name: string, handler: Handler) => {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name)!.push(handler);
		},
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendUserMessage: (content: any, options?: any) => {
			sentUserMessages.push({ content, options });
		},
		appendEntry: (customType: string, data: unknown) => {
			const entry: SessionEntry = { type: "custom", id: `e${sessionEntries.length}`, customType, data };
			sessionEntries.push(entry);
		},
	};

	/** Fire an event (call all handlers in registration order); return the last handler's value. */
	const emit = async (name: string, event: any = {}) => {
		let last: any;
		for (const h of handlers.get(name) ?? []) last = await h(event, ctx);
		return last;
	};

	/** Run a registered command (mimics pi's command entry). */
	const runCommand = async (name: string, args = "") => {
		const cmd = commands.get(name);
		if (!cmd) throw new Error(`unknown command: ${name}`);
		await cmd.handler(args, ctx);
	};

	/** Mimic the start-of-agent-run message injection; returns the before_agent_start value. */
	const startAgent = async (prompt = "do the thing") => {
		return emit("before_agent_start", { prompt });
	};

	/** Mimic a bash tool result; returns the tool_result handler rewrite (undefined if none). */
	const runToolResult = async (opts: {
		toolName?: string;
		command?: string;
		text: string;
		isError?: boolean;
		details?: unknown;
	}) => {
		const event = {
			type: "tool_result",
			toolName: opts.toolName ?? "bash",
			toolCallId: "call-1",
			input: { command: opts.command ?? "some-command" },
			content: [{ type: "text", text: opts.text }],
			isError: opts.isError ?? false,
			details: opts.details,
		};
		return emit("tool_result", event);
	};

	/** Create a fresh plugin instance (default(pi) builds fresh state each call). */
	const newPlugin = async () => {
		const mod = await import("../../src/index.ts");
		mod.default(pi);
	};

	return {
		pi,
		ctx,
		emit,
		runCommand,
		startAgent,
		runToolResult,
		newPlugin,
		notifications,
		statusBars,
		sessionEntries,
		tools,
		commands,
		sentUserMessages,
	};
}

export type MockRuntime = ReturnType<typeof createMockRuntime>;
