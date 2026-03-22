/**
 * setup_stable_diffusion — Installs stable-diffusion.cpp and downloads a model.
 *
 * Steps:
 *   1. Checks prerequisites (git, cmake, make/ninja)
 *   2. Clones stable-diffusion.cpp into install_dir
 *   3. Builds sd-server binary
 *   4. Downloads a recommended GGUF model from Hugging Face
 *   5. Returns the command to start sd-server
 *
 * Idempotent: skips steps that are already complete.
 */

import { z } from "zod";
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

// ---------------------------------------------------------------------------
// Models catalog — curated GGUF models from Hugging Face
// ---------------------------------------------------------------------------

interface ModelEntry {
	id: string;
	label: string;
	url: string;
	filename: string;
	sizeHint: string;
	description: string;
}

const MODELS: ModelEntry[] = [
	{
		id: "sdxl-turbo-q8",
		label: "SDXL Turbo Q8",
		url: "https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors",
		filename: "sd_xl_turbo_1.0_fp16.safetensors",
		sizeHint: "~6.5 GB",
		description:
			"Stability AI SDXL Turbo — fast 1-4 step generation, good quality. FP16 safetensors.",
	},
	{
		id: "sd15-q8",
		label: "SD 1.5 Q8",
		url: "https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors",
		filename: "v1-5-pruned-emaonly.safetensors",
		sizeHint: "~4.3 GB",
		description:
			"Stable Diffusion 1.5 — lightweight, fast, huge ecosystem of LoRAs. Good for lower-end hardware.",
	},
];

const DEFAULT_MODEL = "sdxl-turbo-q8";
const DEFAULT_INSTALL_DIR = path.join(
	process.env.HOME ?? "/tmp",
	".local",
	"share",
	"stable-diffusion-cpp",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasCommand(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function run(
	cmd: string,
	cwd: string,
	env?: Record<string, string>,
): string {
	return execSync(cmd, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf-8",
		timeout: 1_800_000, // 30 min — C++ builds can be slow
		env: { ...process.env, ...env },
	}).trim();
}

/** Follow redirects and stream to disk. Returns final size in bytes. */
function downloadFile(
	url: string,
	destPath: string,
	onProgress?: (pct: number) => void,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const proto = url.startsWith("https") ? https : http;
		proto
			.get(url, { headers: { "User-Agent": "image-gen-mcp/4.0" } }, (res) => {
				// Follow redirects (HF sends 302)
				if (
					res.statusCode &&
					res.statusCode >= 300 &&
					res.statusCode < 400 &&
					res.headers.location
				) {
					downloadFile(res.headers.location, destPath, onProgress)
						.then(resolve)
						.catch(reject);
					res.resume();
					return;
				}

				if (res.statusCode !== 200) {
					res.resume();
					reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
					return;
				}

				const totalBytes = Number(res.headers["content-length"] ?? 0);
				let downloaded = 0;
				const file = fs.createWriteStream(destPath);

				res.on("data", (chunk: Buffer) => {
					downloaded += chunk.length;
					if (totalBytes > 0 && onProgress) {
						onProgress(Math.round((downloaded / totalBytes) * 100));
					}
				});

				res.pipe(file);
				file.on("finish", () => file.close(() => resolve(downloaded)));
				file.on("error", (err) => {
					fs.unlink(destPath, () => {}); // clean up partial
					reject(err);
				});
			})
			.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const InputSchema = z.object({
	install_dir: z
		.string()
		.optional()
		.describe(
			`Where to clone & build stable-diffusion.cpp. Default: ~/.local/share/stable-diffusion-cpp`,
		),
	model: z
		.enum(MODELS.map((m) => m.id) as [string, ...string[]])
		.optional()
		.describe(
			`Which model to download. Options: ${MODELS.map((m) => `"${m.id}" (${m.label}, ${m.sizeHint})`).join(", ")}. Default: ${DEFAULT_MODEL}`,
		),
	skip_model_download: z
		.boolean()
		.optional()
		.describe(
			"If true, skip model download (useful if you already have models). Default: false",
		),
	force_rebuild: z
		.boolean()
		.optional()
		.describe("Force re-clone and rebuild even if binary exists. Default: false"),
});

export type SetupStableDiffusionInput = z.infer<typeof InputSchema>;

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const setupStableDiffusionTool = {
	name: "setup_stable_diffusion",
	description: `Set up stable-diffusion.cpp for local image generation. Clones the repo, builds the sd-server binary, and downloads a GGUF model from Hugging Face.

After setup, start the server with the provided command and set LOCAL_SD_URL in your MCP config.

Prerequisites: git, cmake, and a C++ compiler (clang/gcc). On macOS these come with Xcode Command Line Tools.

Available models:
${MODELS.map((m) => `  • ${m.id}: ${m.description} (${m.sizeHint})`).join("\n")}`,

	inputSchema: InputSchema,

	async execute(input: SetupStableDiffusionInput) {
		const installDir = input.install_dir ?? DEFAULT_INSTALL_DIR;
		const modelId = input.model ?? DEFAULT_MODEL;
		const skipModel = input.skip_model_download ?? false;
		const forceRebuild = input.force_rebuild ?? false;

		const modelEntry = MODELS.find((m) => m.id === modelId);
		if (!modelEntry) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Unknown model "${modelId}". Available: ${MODELS.map((m) => m.id).join(", ")}`,
					},
				],
				isError: true,
			};
		}

		const log: string[] = [];
		const addLog = (msg: string) => {
			log.push(msg);
		};

		try {
			// ---------------------------------------------------------------
			// Step 1: Check prerequisites
			// ---------------------------------------------------------------
			addLog("## Step 1: Checking prerequisites\n");

			const prereqs = [
				{ cmd: "git", label: "Git" },
				{ cmd: "cmake", label: "CMake" },
			];

			// Check for make or ninja
			const hasMake = hasCommand("make");
			const hasNinja = hasCommand("ninja");
			const buildSystem = hasNinja ? "ninja" : hasMake ? "make" : null;

			for (const p of prereqs) {
				if (hasCommand(p.cmd)) {
					addLog(`✓ ${p.label} found`);
				} else {
					addLog(`✗ ${p.label} NOT found`);
					return {
						content: [
							{
								type: "text" as const,
								text: `${log.join("\n")}\n\nMissing prerequisite: ${p.label}. Install it first.\n\nmacOS: xcode-select --install\nUbuntu: sudo apt install git cmake build-essential\nWindows: install Git, CMake, and Visual Studio Build Tools`,
							},
						],
						isError: true,
					};
				}
			}

			if (!buildSystem) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${log.join("\n")}\n\nMissing build system: need either make or ninja.\n\nmacOS: xcode-select --install\nUbuntu: sudo apt install build-essential`,
						},
					],
					isError: true,
				};
			}
			addLog(`✓ Build system: ${buildSystem}`);

			// Check for C++ compiler
			const hasCpp = hasCommand("c++") || hasCommand("g++") || hasCommand("clang++");
			if (!hasCpp) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${log.join("\n")}\n\nMissing C++ compiler.\n\nmacOS: xcode-select --install\nUbuntu: sudo apt install build-essential`,
						},
					],
					isError: true,
				};
			}
			addLog("✓ C++ compiler found");

			// ---------------------------------------------------------------
			// Step 2: Clone stable-diffusion.cpp
			// ---------------------------------------------------------------
			addLog("\n## Step 2: Cloning stable-diffusion.cpp\n");

			const repoDir = path.join(installDir, "stable-diffusion.cpp");
			const binaryPath = path.join(repoDir, "build", "bin", "sd-server");
			const binaryExists = fs.existsSync(binaryPath);

			if (binaryExists && !forceRebuild) {
				addLog(`✓ Binary already exists: ${binaryPath} (skipping clone & build)`);
			} else {
				fs.mkdirSync(installDir, { recursive: true });

				if (fs.existsSync(repoDir) && !forceRebuild) {
					addLog(`✓ Repo already cloned: ${repoDir}`);
				} else {
					if (fs.existsSync(repoDir)) {
						addLog("Removing existing repo for rebuild...");
						fs.rmSync(repoDir, { recursive: true, force: true });
					}
					addLog("Cloning leejet/stable-diffusion.cpp ...");
					run(
						"git clone --recursive https://github.com/leejet/stable-diffusion.cpp.git",
						installDir,
					);
					addLog(`✓ Cloned to ${repoDir}`);
				}

				// -----------------------------------------------------------
				// Step 3: Build
				// -----------------------------------------------------------
				addLog("\n## Step 3: Building sd-server\n");

				const buildDir = path.join(repoDir, "build");
				fs.mkdirSync(buildDir, { recursive: true });

				// Detect platform-specific flags
				const platform = process.platform;
				const cmakeFlags: string[] = ["-DGGML_OPENMP=OFF"];
				if (platform === "darwin") {
					cmakeFlags.push("-DSD_METAL=ON");
					addLog("Detected macOS — enabling Metal acceleration");
				} else if (platform === "linux") {
					// Check for CUDA
					if (hasCommand("nvcc") || fs.existsSync("/usr/local/cuda")) {
						cmakeFlags.push("-DSD_CUBLAS=ON");
						addLog("Detected CUDA — enabling GPU acceleration");
					} else {
						addLog("No CUDA detected — building CPU-only");
					}
				}

				const generator = buildSystem === "ninja" ? "-G Ninja" : "";

				addLog(`Running cmake ${generator} ${cmakeFlags.join(" ")} ...`);
				run(
					`cmake .. ${generator} ${cmakeFlags.join(" ")}`,
					buildDir,
				);

				addLog("Building (this may take a few minutes) ...");
				run(
					`cmake --build . --config Release -j`,
					buildDir,
				);

				if (fs.existsSync(binaryPath)) {
					addLog(`✓ Built successfully: ${binaryPath}`);
				} else {
					// Some builds put it in a different location
					const altPath = path.join(buildDir, "sd-server");
					if (fs.existsSync(altPath)) {
						addLog(`✓ Built successfully: ${altPath}`);
					} else {
						addLog("✗ Build succeeded but sd-server binary not found.");
						addLog(`  Looked in: ${binaryPath} and ${altPath}`);
						addLog("  Check the build output for the actual binary location.");
					}
				}
			}

			// ---------------------------------------------------------------
			// Step 4: Download model
			// ---------------------------------------------------------------
			addLog("\n## Step 4: Model download\n");

			const modelsDir = path.join(installDir, "models");
			fs.mkdirSync(modelsDir, { recursive: true });
			const modelPath = path.join(modelsDir, modelEntry.filename);

			if (skipModel) {
				addLog("Skipped model download (skip_model_download=true)");
			} else if (fs.existsSync(modelPath)) {
				const size = fs.statSync(modelPath).size;
				addLog(
					`✓ Model already downloaded: ${modelPath} (${(size / 1024 / 1024 / 1024).toFixed(1)} GB)`,
				);
			} else {
				addLog(`Downloading ${modelEntry.label} (${modelEntry.sizeHint}) ...`);
				addLog(`  URL: ${modelEntry.url}`);
				addLog(`  Destination: ${modelPath}`);
				addLog("  (This will take a while for large models)");

				const bytes = await downloadFile(modelEntry.url, modelPath);
				addLog(
					`✓ Downloaded: ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
				);
			}

			// ---------------------------------------------------------------
			// Step 5: Generate start command
			// ---------------------------------------------------------------
			addLog("\n## Step 5: Ready!\n");

			const sdServerBin = fs.existsSync(binaryPath)
				? binaryPath
				: path.join(repoDir, "build", "sd-server");
			const actualModelPath = skipModel ? "<path-to-your-model>" : modelPath;

			const startCmd = `${sdServerBin} -m "${actualModelPath}" --listen-ip 127.0.0.1 --listen-port 1234`;

			addLog("Start the server with:\n");
			addLog(`  ${startCmd}\n`);
			addLog(
				"Then set LOCAL_SD_URL=http://127.0.0.1:1234 in your VS Code mcp.json:\n",
			);
			addLog('  "LOCAL_SD_URL": "http://127.0.0.1:1234"');

			addLog("\n## Summary\n");
			addLog(`Install directory: ${installDir}`);
			addLog(`Binary: ${sdServerBin}`);
			if (!skipModel) {
				addLog(`Model: ${modelPath}`);
			}
			addLog(`Server command: ${startCmd}`);

			return {
				content: [
					{
						type: "text" as const,
						text: log.join("\n"),
					},
				],
			};
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			addLog(`\n✗ Error: ${message}`);
			return {
				content: [
					{
						type: "text" as const,
						text: log.join("\n"),
					},
				],
				isError: true,
			};
		}
	},
};
