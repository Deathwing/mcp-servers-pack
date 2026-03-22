#!/usr/bin/env node
/**
 * Unity MCP Server — Dynamic Proxy + Local Project Tools
 *
 * A thin MCP server that dynamically discovers tools from the Unity Editor
 * via C# reflection, while also exposing a small set of local bootstrap tools
 * for package installation and status checks before Unity is connected.
 *
 * Architecture:
 *   VS Code ──stdio──> This Server ──TCP:52719──> Unity Editor
 *
 * On tools/list: fetches metadata from Unity (_get_tools_metadata), caches it,
 * prefixes tool names with "unity_", and returns the MCP-compatible schema.
 *
 * On tools/call: strips "unity_" prefix and forwards to Unity.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	type Resource,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createLocalToolRegistry } from "./local-tools.js";
import { UnityBridge } from "./unity-bridge.js";

const PORT = Number(process.env.UNITY_MCP_PORT) || 52719;
const HOST = process.env.UNITY_MCP_HOST || "127.0.0.1";
const TOOL_PREFIX = "unity_";

const bridge = new UnityBridge({ host: HOST, port: PORT });
const localTools = createLocalToolRegistry(bridge);

const server = new Server(
	{ name: "unity-mcp", version: "1.0.0" },
	{ capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
);

// ─── Tool Metadata Cache ──────────────────────────────────────

let cachedTools: Tool[] | null = null;

async function fetchToolsFromUnity(): Promise<Tool[]> {
	if (cachedTools) return cachedTools;

	if (!bridge.isConnected) return [];

	try {
		const result = (await bridge.send({
			type: "_get_tools_metadata",
		})) as { tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> };

		if (!result?.tools || !Array.isArray(result.tools)) {
			log("Invalid metadata response from Unity");
			return [];
		}

		cachedTools = result.tools
			.map((t) => ({
				name: `${TOOL_PREFIX}${t.name}`,
				description: t.description,
				inputSchema: t.inputSchema as Tool["inputSchema"],
			}))
			.filter((tool) => !localTools.names.has(tool.name));

		log(`Discovered ${cachedTools.length} tools from Unity`);
		return cachedTools;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`Failed to fetch tools metadata: ${msg}`);
		return [];
	}
}

function invalidateCache(): void {
	cachedTools = null;
}

// ─── Request Handlers ─────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
	const tools = [...localTools.tools, ...(await fetchToolsFromUnity())];
	return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;
	const normalizedArgs = (args as Record<string, unknown>) ?? {};

	if (localTools.hasTool(name)) {
		try {
			const result = await localTools.callTool(name, normalizedArgs);
			const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
			return { content: [{ type: "text", text }] };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `unity-mcp error: ${msg}` }],
				isError: true,
			};
		}
	}

	if (!name.startsWith(TOOL_PREFIX)) {
		return {
			content: [{ type: "text", text: `Unknown tool: ${name}` }],
			isError: true,
		};
	}

	const unityTool = name.slice(TOOL_PREFIX.length);

	try {
		const result = await bridge.callTool(unityTool, normalizedArgs);

		// Return image content for camera_capture results
		if (
			result &&
			typeof result === "object" &&
			"image" in result &&
			"format" in result &&
			"encoding" in result
		) {
			const r = result as Record<string, unknown>;
			return {
				content: [
					{
						type: "image" as const,
						data: r.image as string,
						mimeType: `image/${r.format}` as const,
					},
					{
						type: "text" as const,
						text: `Screenshot captured: ${r.width}x${r.height} ${r.format}`,
					},
				],
			};
		}

		const text =
			typeof result === "string" ? result : JSON.stringify(result, null, 2);
		return { content: [{ type: "text", text }] };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: `Unity error: ${msg}` }],
			isError: true,
		};
	}
});

// ─── Resource Handlers ────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
	if (!bridge.isConnected) return { resources: [] };

	try {
		const result = (await bridge.send({
			type: "list_resources",
		})) as { resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> };

		if (!result?.resources || !Array.isArray(result.resources)) {
			return { resources: [] };
		}

		return { resources: result.resources as Resource[] };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`Failed to list resources: ${msg}`);
		return { resources: [] };
	}
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	const { uri } = request.params;

	try {
		const result = (await bridge.send({
			type: "read_resource",
			uri,
		})) as { uri: string; mimeType: string; text: string };

		return {
			contents: [
				{
					uri: result.uri,
					mimeType: result.mimeType,
					text: result.text,
				},
			],
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read resource ${uri}: ${msg}`);
	}
});

// ─── Start ────────────────────────────────────────────────────

function log(msg: string): void {
	process.stderr.write(`[unity-mcp] ${msg}\n`);
}

async function main(): Promise<void> {
	bridge.connectInBackground();

	bridge.on("connected", () => {
		log("Connected to Unity Editor");
		invalidateCache();
		server.sendToolListChanged().catch(() => {});
	});

	bridge.on("disconnected", (reason: string) => {
		log(`Disconnected from Unity: ${reason}. Reconnecting...`);
		invalidateCache();
		server.sendToolListChanged().catch(() => {});
	});

	bridge.on("message", (msg: Record<string, unknown>) => {
		if (msg.type === "tools_changed") {
			log("Unity tools changed (assembly reload). Refreshing...");
			invalidateCache();
			server.sendToolListChanged().catch(() => {});
		}
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	log(`MCP server started (Unity bridge: ${HOST}:${PORT})`);
}

main().catch((err) => {
	log(`Fatal error: ${err}`);
	process.exit(1);
});
