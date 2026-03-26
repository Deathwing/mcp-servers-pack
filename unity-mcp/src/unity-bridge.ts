/**
 * Unity TCP Bridge Client
 *
 * Manages a TCP connection to the Unity Editor bridge.
 * Uses newline-delimited JSON (NDJSON) framing.
 * Includes auto-reconnect with exponential backoff and heartbeat pings.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

/**
 * Derive the port-file path for a given Unity project directory.
 * Uses the same 8-char MD5 hash of the project path as the C# side.
 * Falls back to the generic "unity-mcp.port" when no project path is known.
 */
function portFilePath(projectPath?: string): string {
	if (projectPath) {
		const hash = crypto.createHash("md5").update(projectPath).digest("hex").slice(0, 8);
		return path.join(os.tmpdir(), `unity-mcp.${hash}.port`);
	}
	return path.join(os.tmpdir(), "unity-mcp.port");
}

/** Read the port Unity is listening on from the shared temp file, or return undefined. */
function readPortFile(projectPath?: string): number | undefined {
	try {
		const raw = fs.readFileSync(portFilePath(projectPath), "utf-8").trim();
		const n = Number(raw);
		if (Number.isInteger(n) && n > 0 && n < 65536) return n;
	} catch {
		// file absent — Unity not running or hasn't written it yet
	}
	return undefined;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

export interface UnityBridgeOptions {
	host?: string;
	port?: number;
	/**
	 * Absolute path to the Unity project root directory.
	 * When set, the bridge reads from the project-specific port file
	 * (unity-mcp.{hash}.port) so multiple Unity instances can run in parallel.
	 * Defaults to the UNITY_PROJECT_PATH environment variable.
	 */
	projectPath?: string;
	/** Request timeout in ms (default: 30s) */
	requestTimeout?: number;
	/** Heartbeat interval in ms (default: 10s) */
	heartbeatInterval?: number;
	/** Max reconnect delay in ms (default: 30s) */
	maxReconnectDelay?: number;
}

export class UnityBridge extends EventEmitter {
	private socket: net.Socket | null = null;
	private buffer = "";
	private pendingRequests = new Map<string, PendingRequest>();
	private nextId = 1;
	private reconnectDelay = 1000;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private connected = false;
	private destroyed = false;
	private activePort: number | null = null;

	private readonly host: string;
	private readonly port: number;
	private readonly projectPath: string | undefined;
	private readonly requestTimeout: number;
	private readonly heartbeatInterval: number;
	private readonly maxReconnectDelay: number;

	constructor(options: UnityBridgeOptions = {}) {
		super();
		this.host = options.host ?? "127.0.0.1";
		this.port = options.port ?? 52719;
		this.projectPath = options.projectPath ?? process.env.UNITY_PROJECT_PATH;
		this.requestTimeout = options.requestTimeout ?? 30_000;
		this.heartbeatInterval = options.heartbeatInterval ?? 10_000;
		this.maxReconnectDelay = options.maxReconnectDelay ?? 30_000;
	}

	get isConnected(): boolean {
		return this.connected;
	}

	/** The port the bridge is currently connected to, or null if not connected. */
	get connectedPort(): number | null {
		return this.activePort;
	}

	/** The Unity project path this bridge is scoped to, or undefined if not set. */
	get unityProjectPath(): string | undefined {
		return this.projectPath;
	}

	/** Connect to Unity. Returns when the first connection succeeds. */
	async connect(): Promise<void> {
		if (this.destroyed) throw new Error("Bridge has been destroyed");
		if (this.connected) return;

		return new Promise<void>((resolve, reject) => {
			const onFirstConnect = () => {
				this.removeListener("error", onFirstError);
				resolve();
			};
			const onFirstError = (err: Error) => {
				this.removeListener("connected", onFirstConnect);
				reject(err);
			};
			this.once("connected", onFirstConnect);
			this.once("error", onFirstError);
			this.attemptConnect();
		});
	}

	/** Start connection (or reconnection) without awaiting. */
	connectInBackground(): void {
		if (this.destroyed || this.connected || this.reconnectTimer) return;
		this.attemptConnect();
	}

	private attemptConnect(): void {
		if (this.destroyed) return;

		// Prefer the port Unity advertises via the temp file (handles port fallback).
		const discoveredPort = readPortFile(this.projectPath);
		const connectPort = discoveredPort ?? this.port;

		const socket = new net.Socket();
		socket.setEncoding("utf-8");
		socket.setKeepAlive(true, 5000);

		socket.on("connect", () => {
			this.socket = socket;
			this.connected = true;
			this.activePort = connectPort;
			this.reconnectDelay = 1000;
			this.buffer = "";
			this.startHeartbeat();
			this.emit("connected");
			this.log(`Connected to Unity on port ${connectPort}`);
		});

		socket.on("data", (data: string) => {
			this.buffer += data;
			this.processBuffer();
		});

		socket.on("close", () => {
			this.handleDisconnect("Socket closed");
		});

		socket.on("error", (err) => {
			if (!this.connected) {
				// Connection failed — schedule reconnect
				this.log(`Connection failed: ${err.message}`);
				this.scheduleReconnect();
			} else {
				this.handleDisconnect(`Socket error: ${err.message}`);
			}
		});

		socket.connect(connectPort, this.host);
	}

	private handleDisconnect(reason: string): void {
		if (!this.connected && !this.socket) return;
		this.log(`Disconnected: ${reason}`);
		this.connected = false;
		this.activePort = null;
		this.stopHeartbeat();
		this.socket?.destroy();
		this.socket = null;

		// Reject all pending requests
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(`Disconnected from Unity: ${reason}`));
		}
		this.pendingRequests.clear();

		this.emit("disconnected", reason);
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.destroyed || this.reconnectTimer) return;

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.attemptConnect();
		}, this.reconnectDelay);

		this.reconnectDelay = Math.min(
			this.reconnectDelay * 2,
			this.maxReconnectDelay,
		);
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (this.connected) {
				this.send({ type: "ping" }).catch(() => {
					/* heartbeat failure handled by disconnect */
				});
			}
		}, this.heartbeatInterval);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private processBuffer(): void {
		const lines = this.buffer.split("\n");
		// Keep the last (possibly incomplete) chunk
		this.buffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			try {
				const msg = JSON.parse(trimmed);
				this.handleMessage(msg);
			} catch {
				this.log(`Invalid JSON from Unity: ${trimmed.substring(0, 200)}`);
			}
		}
	}

	private handleMessage(msg: Record<string, unknown>): void {
		const id = msg.id as string | undefined;
		if (id && this.pendingRequests.has(id)) {
			const pending = this.pendingRequests.get(id)!;
			this.pendingRequests.delete(id);
			clearTimeout(pending.timeout);

			if (msg.error) {
				pending.reject(
					new Error(
						typeof msg.error === "string"
							? msg.error
							: JSON.stringify(msg.error),
					),
				);
			} else {
				pending.resolve(msg.result);
			}
		} else if (msg.type === "pong") {
			// Heartbeat response — nothing to do
		} else {
			// Broadcast unhandled messages
			this.emit("message", msg);
		}
	}

	/** Send a request and wait for the response. */
	async send(
		message: Record<string, unknown>,
		timeout?: number,
	): Promise<unknown> {
		if (!this.connected || !this.socket) {
			throw new Error(
				"Not connected to Unity. Is the Unity Editor running with UnityMCP?",
			);
		}

		const id = String(this.nextId++);
		const payload = JSON.stringify({ ...message, id }) + "\n";

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Request timed out after ${timeout ?? this.requestTimeout}ms`));
			}, timeout ?? this.requestTimeout);

			this.pendingRequests.set(id, { resolve, reject, timeout: timer });

			this.socket!.write(payload, "utf-8", (err) => {
				if (err) {
					this.pendingRequests.delete(id);
					clearTimeout(timer);
					reject(err);
				}
			});
		});
	}

	/** Convenience: call a Unity tool by name. */
	async callTool(
		tool: string,
		params: Record<string, unknown> = {},
	): Promise<unknown> {
		return this.send({ type: "tool_call", tool, params });
	}

	/** List available tools from Unity. */
	async listTools(): Promise<unknown> {
		return this.send({ type: "list_tools" });
	}

	destroy(): void {
		this.destroyed = true;
		this.stopHeartbeat();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Bridge destroyed"));
		}
		this.pendingRequests.clear();
		this.socket?.destroy();
		this.socket = null;
		this.connected = false;
	}

	private log(msg: string): void {
		process.stderr.write(`[unity-mcp] ${msg}\n`);
	}
}
