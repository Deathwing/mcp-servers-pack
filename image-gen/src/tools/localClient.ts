/**
 * Local SD client — talks to any OpenAI-compatible image generation server.
 *
 * Works with:
 *   - stable-diffusion.cpp  (sd-server, default port 1234)
 *   - AUTOMATIC1111 / Forge  (with --api flag, port 7860 — needs sdwebui-openai extension)
 *   - Any other server exposing /v1/images/generations
 *
 * Env: LOCAL_SD_URL  (default: http://127.0.0.1:1234)
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function getLocalBaseUrl(): string {
	return (process.env.LOCAL_SD_URL ?? "http://127.0.0.1:1234").replace(
		/\/+$/,
		"",
	);
}

export function isLocalConfigured(): boolean {
	return !!process.env.LOCAL_SD_URL;
}

// ‑‑ Auto-start sd-server ‑‑

const DEFAULT_INSTALL_DIR = path.join(
	homedir(),
	".local",
	"share",
	"stable-diffusion-cpp",
);
const SD_SERVER_BIN = path.join(
	DEFAULT_INSTALL_DIR,
	"stable-diffusion.cpp",
	"build",
	"bin",
	"sd-server",
);
const MODELS_DIR = path.join(DEFAULT_INSTALL_DIR, "models");

let sdProcess: ChildProcess | null = null;
let startingPromise: Promise<void> | null = null;

/** Quick health check — resolves true if sd-server responds. */
async function isServerReachable(): Promise<boolean> {
	const base = getLocalBaseUrl();
	for (const endpoint of ["/health", "/"]) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 2000);
			const res = await fetch(`${base}${endpoint}`, {
				signal: controller.signal,
			});
			clearTimeout(timer);
			// Any HTTP response (even 404) means the server is up
			if (res.ok || res.status < 500) return true;
		} catch {
			// connection refused / timeout — try next endpoint
		}
	}
	return false;
}

/** Find the first model file (.safetensors, .gguf, .ckpt) in the models dir. */
function findDefaultModel(): string | null {
	if (!existsSync(MODELS_DIR)) return null;
	const exts = [".safetensors", ".gguf", ".ckpt"];
	try {
		const files = readdirSync(MODELS_DIR);
		const model = files.find((f) =>
			exts.some((ext) => f.toLowerCase().endsWith(ext)),
		);
		return model ? path.join(MODELS_DIR, model) : null;
	} catch {
		return null;
	}
}

/** Parse host and port from LOCAL_SD_URL. */
function parseUrlHostPort(): { host: string; port: string } {
	try {
		const u = new URL(getLocalBaseUrl());
		return { host: u.hostname || "127.0.0.1", port: u.port || "1234" };
	} catch {
		return { host: "127.0.0.1", port: "1234" };
	}
}

/**
 * Ensure the local SD server is running. If not reachable, attempt to
 * auto-start sd-server from the standard install location.
 * Deduplicates concurrent calls via a shared promise.
 */
async function ensureServerRunning(): Promise<void> {
	if (await isServerReachable()) return;

	// Already starting? Wait for that.
	if (startingPromise) return startingPromise;

	startingPromise = (async () => {
		try {
			// Check binary exists
			if (!existsSync(SD_SERVER_BIN)) {
				throw new Error(
					`sd-server not found at ${SD_SERVER_BIN}. Run the setup_stable_diffusion tool first.`,
				);
			}

			const modelPath = findDefaultModel();
			if (!modelPath) {
				throw new Error(
					`No model found in ${MODELS_DIR}. Run setup_stable_diffusion to download one.`,
				);
			}

			const { host, port } = parseUrlHostPort();

			console.error(
				`[image-gen] Auto-starting sd-server on ${host}:${port} with ${path.basename(modelPath)}...`,
			);

			const child = spawn(
				SD_SERVER_BIN,
				[
					"-m",
					modelPath,
					"--listen-ip",
					host,
					"--listen-port",
					port,
				],
				{
					stdio: ["ignore", "pipe", "pipe"],
					detached: true,
				},
			);

			child.unref();
			sdProcess = child;

			// Forward stderr for debugging (non-blocking)
			child.stderr?.on("data", (chunk: Buffer) => {
				console.error(`[sd-server] ${chunk.toString().trimEnd()}`);
			});

			child.on("error", (err) => {
				console.error(`[image-gen] sd-server spawn error: ${err.message}`);
				sdProcess = null;
			});

			child.on("exit", (code) => {
				console.error(`[image-gen] sd-server exited with code ${code}`);
				sdProcess = null;
			});

			// Poll until server is ready (up to 120s for model loading)
			const maxWait = 120_000;
			const pollInterval = 1000;
			const deadline = Date.now() + maxWait;

			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, pollInterval));
				if (await isServerReachable()) {
					console.error("[image-gen] sd-server is ready.");
					return;
				}
				// Check if process died
				if (child.exitCode !== null) {
					throw new Error(
						`sd-server failed to start (exit code ${child.exitCode})`,
					);
				}
			}

			throw new Error(
				`sd-server did not become ready within ${maxWait / 1000}s`,
			);
		} finally {
			startingPromise = null;
		}
	})();

	return startingPromise;
}

// ‑‑ Common helpers ‑‑

function parseSizeString(size: string): { width: number; height: number } {
	const m = size.match(/^(\d+)x(\d+)$/);
	if (m) return { width: Number(m[1]), height: Number(m[2]) };
	return { width: 512, height: 512 };
}

// ‑‑ Text-to-Image ‑‑

export interface LocalGenerateOptions {
	prompt: string;
	negative_prompt?: string;
	size?: string; // e.g. "512x512"
	steps?: number;
	cfg_scale?: number;
	seed?: number;
	model?: string;
	/** How many images to return (default 1) */
	n?: number;
}

export interface LocalGenerateResult {
	base64: string;
	/** bytes of the decoded image */
	byteSize: number;
}

/**
 * POST /v1/images/generations  (OpenAI-compatible)
 *
 * Falls back to the `/sdapi/v1/txt2img` A1111 format if the first call 404s,
 * so it also works with vanilla A1111/Forge backends.
 */
export async function localGenerate(
	opts: LocalGenerateOptions,
): Promise<LocalGenerateResult> {
	await ensureServerRunning();
	const base = getLocalBaseUrl();
	const { width, height } = parseSizeString(opts.size ?? "512x512");

	// --- Try OpenAI-compatible endpoint first (sd.cpp) ---
	const oaiBody = {
		prompt: opts.prompt,
		negative_prompt: opts.negative_prompt ?? "",
		n: opts.n ?? 1,
		size: `${width}x${height}`,
		response_format: "b64_json",
		...(opts.steps != null ? { steps: opts.steps } : {}),
		...(opts.cfg_scale != null ? { cfg_scale: opts.cfg_scale } : {}),
		...(opts.seed != null ? { seed: opts.seed } : {}),
		...(opts.model ? { model: opts.model } : {}),
	};

	let res = await fetch(`${base}/v1/images/generations`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(oaiBody),
	});

	if (res.ok) {
		const json = (await res.json()) as {
			data?: Array<{ b64_json?: string }>;
		};
		const b64 = json.data?.[0]?.b64_json;
		if (!b64) throw new Error("Local server returned no image data");
		return { base64: b64, byteSize: Buffer.from(b64, "base64").length };
	}

	// --- Fallback: A1111/Forge /sdapi/v1/txt2img ---
	if (res.status === 404) {
		const a1111Body = {
			prompt: opts.prompt,
			negative_prompt: opts.negative_prompt ?? "",
			width,
			height,
			steps: opts.steps ?? 20,
			cfg_scale: opts.cfg_scale ?? 7,
			...(opts.seed != null ? { seed: opts.seed } : { seed: -1 }),
		};

		res = await fetch(`${base}/sdapi/v1/txt2img`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(a1111Body),
		});

		if (res.ok) {
			const json = (await res.json()) as { images?: string[] };
			const b64 = json.images?.[0];
			if (!b64) throw new Error("A1111 server returned no image data");
			return {
				base64: b64,
				byteSize: Buffer.from(b64, "base64").length,
			};
		}
	}

	const errText = await res.text().catch(() => "");
	throw new Error(
		`Local server error (${res.status}): ${errText.slice(0, 500)}`,
	);
}

// ‑‑ Image-to-Image (edit) ‑‑

export interface LocalEditOptions {
	/** Absolute path to source image */
	source_path: string;
	prompt: string;
	negative_prompt?: string;
	size?: string;
	steps?: number;
	cfg_scale?: number;
	/** Denoising strength (0.0–1.0). Lower = closer to original. */
	strength?: number;
	seed?: number;
	model?: string;
}

/**
 * Send an img2img request to the local server.
 *
 * Tries OpenAI-compatible /v1/images/edits first (multipart form),
 * then falls back to A1111 /sdapi/v1/img2img.
 */
export async function localEdit(
	opts: LocalEditOptions,
): Promise<LocalGenerateResult> {
	await ensureServerRunning();
	const base = getLocalBaseUrl();
	const imageBuffer = await fs.readFile(opts.source_path);
	const { width, height } = parseSizeString(opts.size ?? "512x512");

	// --- OpenAI-compatible /v1/images/edits (multipart) ---
	const form = new FormData();
	const blob = new Blob([imageBuffer], { type: "image/png" });
	form.append("image", blob, path.basename(opts.source_path));
	form.append("prompt", opts.prompt);
	form.append("n", "1");
	form.append("size", `${width}x${height}`);
	form.append("response_format", "b64_json");

	let res = await fetch(`${base}/v1/images/edits`, {
		method: "POST",
		body: form,
	});

	if (res.ok) {
		const json = (await res.json()) as {
			data?: Array<{ b64_json?: string }>;
		};
		const b64 = json.data?.[0]?.b64_json;
		if (!b64)
			throw new Error("Local server returned no image data (edit)");
		return { base64: b64, byteSize: Buffer.from(b64, "base64").length };
	}

	// --- Fallback: A1111 /sdapi/v1/img2img ---
	if (res.status === 404) {
		const base64Input = imageBuffer.toString("base64");

		const a1111Body = {
			init_images: [base64Input],
			prompt: opts.prompt,
			negative_prompt: opts.negative_prompt ?? "",
			width,
			height,
			steps: opts.steps ?? 20,
			cfg_scale: opts.cfg_scale ?? 7,
			denoising_strength: opts.strength ?? 0.75,
			...(opts.seed != null ? { seed: opts.seed } : { seed: -1 }),
		};

		res = await fetch(`${base}/sdapi/v1/img2img`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(a1111Body),
		});

		if (res.ok) {
			const json = (await res.json()) as { images?: string[] };
			const b64 = json.images?.[0];
			if (!b64)
				throw new Error("A1111 server returned no image data (img2img)");
			return {
				base64: b64,
				byteSize: Buffer.from(b64, "base64").length,
			};
		}
	}

	const errText = await res.text().catch(() => "");
	throw new Error(
		`Local server error (${res.status}): ${errText.slice(0, 500)}`,
	);
}
