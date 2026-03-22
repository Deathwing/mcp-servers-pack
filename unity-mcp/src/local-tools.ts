import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UnityBridge } from "./unity-bridge.js";

type JsonObject = Record<string, unknown>;

interface ProjectContext {
	projectPath: string;
	manifestPath: string;
	packagesDir: string;
	legacyPluginDir: string;
	legacyPluginMetaPath: string;
	vscodeMcpPath: string;
}

interface PackageInfo {
	name: string;
	version: string | null;
	packageDir: string;
	manifestPath: string;
}

interface WorkspaceMcpStatus {
	exists: boolean;
	configured: boolean;
	parseError?: string;
}

interface LocalToolDefinition {
	tool: Tool;
	handler: (args: JsonObject) => Promise<unknown>;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(moduleDir, "..");
const unityPluginDir = path.join(serverRoot, "unity-plugin");
const unityPluginManifestPath = path.join(unityPluginDir, "package.json");
const GITHUB_PACKAGE_URL = "https://github.com/Deathwing/mcp-servers-pack.git?path=unity-mcp/unity-plugin";

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): JsonObject {
	return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonObject;
}

function writeJsonFile(filePath: string, value: JsonObject): void {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeForConfig(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

function getBooleanArg(args: JsonObject, key: string, defaultValue: boolean): boolean {
	const value = args[key];
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.toLowerCase() === "true") return true;
		if (value.toLowerCase() === "false") return false;
	}
	return defaultValue;
}

function getRequiredStringArg(args: JsonObject, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${key} is required`);
	}
	return value.trim();
}

function loadPackageInfo(): PackageInfo {
	if (!fs.existsSync(unityPluginManifestPath)) {
		throw new Error(`Unity package manifest not found at ${unityPluginManifestPath}`);
	}

	const manifest = readJsonFile(unityPluginManifestPath);
	const name = manifest.name;
	if (typeof name !== "string" || name.length === 0) {
		throw new Error(`Unity package name missing in ${unityPluginManifestPath}`);
	}

	return {
		name,
		version: typeof manifest.version === "string" ? manifest.version : null,
		packageDir: unityPluginDir,
		manifestPath: unityPluginManifestPath,
	};
}

function resolveProjectContext(projectPathInput: string): ProjectContext {
	const projectPath = path.resolve(projectPathInput);
	if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
		throw new Error(`Unity project directory not found: ${projectPath}`);
	}

	const assetsDir = path.join(projectPath, "Assets");
	const projectSettingsDir = path.join(projectPath, "ProjectSettings");
	const packagesDir = path.join(projectPath, "Packages");
	const manifestPath = path.join(packagesDir, "manifest.json");

	if (!fs.existsSync(assetsDir)) {
		throw new Error(`Not a Unity project: missing ${assetsDir}`);
	}
	if (!fs.existsSync(projectSettingsDir)) {
		throw new Error(`Not a Unity project: missing ${projectSettingsDir}`);
	}
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`Unity package manifest not found: ${manifestPath}`);
	}

	return {
		projectPath,
		manifestPath,
		packagesDir,
		legacyPluginDir: path.join(projectPath, "Assets", "Plugins", "UnityMCP"),
		legacyPluginMetaPath: path.join(projectPath, "Assets", "Plugins", "UnityMCP.meta"),
		vscodeMcpPath: path.join(projectPath, ".vscode", "mcp.json"),
	};
}

function computePackageReference(packagesDir: string, packageDir: string): string {
	let relativePath = path.relative(packagesDir, packageDir).split(path.sep).join("/");
	if (!relativePath.startsWith(".")) {
		relativePath = `./${relativePath}`;
	}
	return `file:${relativePath}`;
}

function createTimestamp(): string {
	const now = new Date();
	const pad = (value: number) => value.toString().padStart(2, "0");
	return [
		now.getFullYear(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
	].join("") + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function buildUnityServerConfig(): JsonObject {
	const normalizedRoot = normalizeForConfig(serverRoot);
	return {
		type: "stdio",
		command: "npx",
		args: [
			"--prefix",
			normalizedRoot,
			"tsx",
			`${normalizedRoot}/src/server.ts`,
		],
	};
}

function getWorkspaceMcpStatus(mcpPath: string): WorkspaceMcpStatus {
	if (!fs.existsSync(mcpPath)) {
		return { exists: false, configured: false };
	}

	try {
		const json = readJsonFile(mcpPath);
		const servers = isRecord(json.servers) ? json.servers : null;
		const unityServer = servers && isRecord(servers["unity-mcp"]) ? servers["unity-mcp"] : null;
		const args = unityServer && Array.isArray(unityServer.args) ? unityServer.args : [];
		const expectedServerPath = `${normalizeForConfig(serverRoot)}/src/server.ts`;
		const configured = args.some((arg) => arg === expectedServerPath);
		return { exists: true, configured };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { exists: true, configured: false, parseError: message };
	}
}

function updateWorkspaceMcpConfig(mcpPath: string): { updated: boolean; warning?: string } {
	let config: JsonObject = {};
	if (fs.existsSync(mcpPath)) {
		try {
			config = readJsonFile(mcpPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				updated: false,
				warning: `Skipped ${mcpPath}: existing file is not valid JSON (${message})`,
			};
		}
	}

	const servers = isRecord(config.servers) ? { ...config.servers } : {};
	servers["unity-mcp"] = buildUnityServerConfig();
	config.servers = servers;

	fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
	writeJsonFile(mcpPath, config);
	return { updated: true };
}

function backupLegacyPlugin(project: ProjectContext): string | null {
	if (!fs.existsSync(project.legacyPluginDir)) {
		return null;
	}

	const backupRoot = path.join(project.projectPath, ".unity-mcp-backups");
	fs.mkdirSync(backupRoot, { recursive: true });

	let backupDir = path.join(backupRoot, `UnityMCP-${createTimestamp()}`);
	let suffix = 1;
	while (fs.existsSync(backupDir)) {
		backupDir = `${backupDir}-${suffix}`;
		suffix += 1;
	}

	fs.renameSync(project.legacyPluginDir, backupDir);
	if (fs.existsSync(project.legacyPluginMetaPath)) {
		fs.renameSync(project.legacyPluginMetaPath, `${backupDir}.meta`);
	}

	return backupDir;
}

async function getStatus(args: JsonObject, bridge: UnityBridge): Promise<unknown> {
	const packageInfo = loadPackageInfo();
	const unityRunning = isUnityProcessRunning();
	const result: JsonObject = {
		bridgeConnected: bridge.isConnected,
		unityProcessRunning: unityRunning,
		serverRoot,
		unityPackageName: packageInfo.name,
		unityPackageVersion: packageInfo.version,
		unityPackagePath: packageInfo.packageDir,
	};

	// Always check Editor.log for compile errors — the bridge can be connected
	// from our plugin's assembly while other assemblies still have errors.
	const compileErrors = unityRunning ? getCompileErrors() : [];

	if (!unityRunning) {
		result.status = "Unity is not running. Use unity_open_project to launch it.";
	} else if (!bridge.isConnected) {
		if (compileErrors.length > 0) {
			result.compileErrors = compileErrors;
			result.status = "Unity is running but has compile errors — fix them and the bridge will auto-connect.";
		} else {
			result.status = "Unity is running but the bridge is not connected yet. Unity may still be loading or importing assets.";
		}
	} else if (compileErrors.length > 0) {
		result.compileErrors = compileErrors;
		result.status = "Unity bridge is connected, but there are compile errors in your project.";
	} else {
		result.status = "Unity bridge is connected and ready.";
	}

	const projectPath = typeof args.projectPath === "string" ? args.projectPath.trim() : "";
	if (projectPath.length === 0) {
		const detectedPath = detectProjectPathFromLog();
		if (detectedPath) result.detectedProjectPath = detectedPath;
		return result;
	}

	try {
		const project = resolveProjectContext(projectPath);
		const manifest = readJsonFile(project.manifestPath);
		const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {};
		const installedReference = typeof dependencies[packageInfo.name] === "string"
			? dependencies[packageInfo.name]
			: null;
		const expectedReference = computePackageReference(project.packagesDir, packageInfo.packageDir);
		const workspaceMcp = getWorkspaceMcpStatus(project.vscodeMcpPath);

		const packageInstalled = installedReference === expectedReference || installedReference === GITHUB_PACKAGE_URL;
		result.projectPath = project.projectPath;
		result.manifestPath = project.manifestPath;
		result.localPackageReference = expectedReference;
		result.githubPackageReference = GITHUB_PACKAGE_URL;
		result.installedPackageReference = installedReference;
		result.packageInstalled = packageInstalled;
		result.legacyPluginPresent = fs.existsSync(project.legacyPluginDir);
		result.workspaceMcpPath = project.vscodeMcpPath;
		result.workspaceMcpExists = workspaceMcp.exists;
		result.workspaceMcpConfigured = workspaceMcp.configured;
		if (workspaceMcp.parseError) {
			result.workspaceMcpWarning = workspaceMcp.parseError;
		}
		result.recommendedAction = packageInstalled
			? "Open Unity and wait for compilation, or call unity_install_package if you want to refresh the setup."
			: `Call unity_install_package with this projectPath. Use source=\"local\" (default) for a local file reference or source=\"github\" to install from GitHub.`;
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result.projectPath = path.resolve(projectPath);
		result.error = message;
		return result;
	}
}

// ─── Editor.log helpers ───────────────────────────────────────

const EDITOR_LOG_PATHS: Record<string, string> = {
	darwin: path.join(os.homedir(), "Library", "Logs", "Unity", "Editor.log"),
	win32: path.join(os.homedir(), "AppData", "Local", "Unity", "Editor", "Editor.log"),
	linux: path.join(os.homedir(), ".config", "unity3d", "Editor.log"),
};

function getEditorLogPath(): string {
	return EDITOR_LOG_PATHS[process.platform] ?? EDITOR_LOG_PATHS.linux;
}

function isUnityProcessRunning(): boolean {
	try {
		if (process.platform === "win32") {
			child_process.execFileSync("tasklist", ["/FI", "IMAGENAME eq Unity.exe", "/NH"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
			return true;
		}
		child_process.execFileSync("pgrep", ["-x", "Unity"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function getCompileErrors(): string[] {
	try {
		const logPath = getEditorLogPath();
		if (!fs.existsSync(logPath)) return [];
		const content = fs.readFileSync(logPath, "utf-8");
		const lines = content.split("\n");

		// Find the start of the most recent compilation run
		let lastCompileStart = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].includes("[ScriptCompilation] Requested script compilation") ||
				lines[i].includes("Starting: /") && lines[i].includes("ScriptCompilationBuildProgram")) {
				lastCompileStart = i;
				break;
			}
		}

		const searchLines = lastCompileStart >= 0 ? lines.slice(lastCompileStart) : lines.slice(-400);
		const errors: string[] = [];
		for (const line of searchLines) {
			if (/error CS\d+:|error:\s/i.test(line)) {
				errors.push(line.trim());
			}
		}
		return errors;
	} catch {
		return [];
	}
}

function detectProjectPathFromLog(): string | null {
	try {
		const logPath = getEditorLogPath();
		if (!fs.existsSync(logPath)) return null;
		const content = fs.readFileSync(logPath, "utf-8");
		const match = content.match(/^\[Project\]\s+(.+)$/m) ?? content.match(/Project path:\s*(.+)/m);
		return match?.[1]?.trim() ?? null;
	} catch {
		return null;
	}
}

// ─── Unity Editor launcher ────────────────────────────────────

async function openProject(args: JsonObject): Promise<unknown> {
	const projectPath = typeof args.projectPath === "string" && args.projectPath.trim()
		? path.resolve(args.projectPath.trim())
		: detectProjectPathFromLog();

	if (!projectPath) {
		throw new Error("No projectPath provided and could not detect one from Editor.log.");
	}
	if (!fs.existsSync(projectPath)) {
		throw new Error(`Project path does not exist: ${projectPath}`);
	}
	if (isUnityProcessRunning()) {
		return {
			projectPath,
			launched: false,
			message: "Unity is already running. Use unity_get_status to check the connection state.",
		};
	}

	if (process.platform === "darwin") {
		child_process.spawn(
			"open",
			["-a", "Unity", "--args", "-projectPath", projectPath],
			{ detached: true, stdio: "ignore" },
		).unref();
	} else if (process.platform === "win32") {
		// Spawn Unity.exe from PATH (Unity install dir should be on PATH, or use full path)
		child_process.spawn(
			"Unity.exe",
			["-projectPath", projectPath],
			{ detached: true, stdio: "ignore" },
		).unref();
	} else {
		child_process.spawn(
			"unity",
			["-projectPath", projectPath],
			{ detached: true, stdio: "ignore" },
		).unref();
	}

	return {
		projectPath,
		launched: true,
		message: "Unity launch requested. It takes a while to start and import assets. The MCP bridge will auto-connect once Unity is ready. Use unity_get_status to check progress.",
	};
}

async function installPackage(args: JsonObject): Promise<unknown> {
	const packageInfo = loadPackageInfo();
	const project = resolveProjectContext(getRequiredStringArg(args, "projectPath"));
	const configureWorkspaceMcp = getBooleanArg(args, "configureWorkspaceMcp", true);
	const backupExistingPlugin = getBooleanArg(args, "backupLegacyPlugin", true);
	const useGithub = typeof args.source === "string" && args.source === "github";
	const warnings: string[] = [];

	const manifest = readJsonFile(project.manifestPath);
	const dependencies = isRecord(manifest.dependencies) ? { ...manifest.dependencies } : {};
	const packageReference = useGithub
		? GITHUB_PACKAGE_URL
		: computePackageReference(project.packagesDir, packageInfo.packageDir);
	const previousReference = typeof dependencies[packageInfo.name] === "string"
		? dependencies[packageInfo.name]
		: null;

	dependencies[packageInfo.name] = packageReference;
	manifest.dependencies = dependencies;
	writeJsonFile(project.manifestPath, manifest);

	let backupDir: string | null = null;
	if (fs.existsSync(project.legacyPluginDir)) {
		if (backupExistingPlugin) {
			backupDir = backupLegacyPlugin(project);
		} else {
			warnings.push("Legacy Assets/Plugins/UnityMCP directory was left in place");
		}
	}

	let workspaceMcpUpdated = false;
	if (configureWorkspaceMcp) {
		const workspaceResult = updateWorkspaceMcpConfig(project.vscodeMcpPath);
		workspaceMcpUpdated = workspaceResult.updated;
		if (workspaceResult.warning) {
			warnings.push(workspaceResult.warning);
		}
	}

	return {
		projectPath: project.projectPath,
		manifestPath: project.manifestPath,
		packageName: packageInfo.name,
		previousPackageReference: previousReference,
		installedPackageReference: packageReference,
		legacyPluginBackupDir: backupDir,
		workspaceMcpPath: project.vscodeMcpPath,
		workspaceMcpUpdated,
		warnings,
		nextStep: "Open the Unity project and wait for package import and script compilation.",
	};
}

export function createLocalToolRegistry(bridge: UnityBridge): {
	tools: Tool[];
	hasTool: (name: string) => boolean;
	callTool: (name: string, args: JsonObject) => Promise<unknown>;
	names: Set<string>;
} {
	const definitions: LocalToolDefinition[] = [
		{
			tool: {
				name: "unity_get_status",
				description: "Report Unity bridge connectivity and, optionally, whether a Unity project already references the local unity-mcp package.",
				inputSchema: {
					type: "object",
					properties: {
						projectPath: {
							type: "string",
							description: "Optional absolute or relative path to a Unity project to inspect.",
						},
					},
				},
			},
			handler: (args) => getStatus(args, bridge),
		},
		{
			tool: {
				name: "unity_open_project",
				description: "Open a Unity project in Unity Hub. Launches Unity Hub with the specified project path.",
				inputSchema: {
					type: "object",
					properties: {
						projectPath: {
							type: "string",
							description: "Absolute or relative path to the Unity project to open.",
						},
					},
					required: ["projectPath"],
				},
			},
			handler: openProject,
		},
		{
			tool: {
				name: "unity_install_package",
				description: "Add the unity-mcp package to a Unity project's Packages/manifest.json and optionally configure .vscode/mcp.json. Use source=\"local\" (default) to reference the local clone, or source=\"github\" to install directly from GitHub.",
				inputSchema: {
					type: "object",
					properties: {
						projectPath: {
							type: "string",
							description: "Path to the Unity project to install the package into.",
						},
						source: {
							type: "string",
							enum: ["local", "github"],
							description: "\"local\" (default) installs via a relative file: path to this repo clone. \"github\" installs from https://github.com/Deathwing/mcp-servers-pack.git?path=unity-mcp/unity-plugin — useful when sharing the project with others who don't have this repo cloned.",
						},
						configureWorkspaceMcp: {
							type: "boolean",
							description: "When true, merge unity-mcp into the project's .vscode/mcp.json. Defaults to true.",
						},
						backupLegacyPlugin: {
							type: "boolean",
							description: "When true, move any existing Assets/Plugins/UnityMCP directory into .unity-mcp-backups. Defaults to true.",
						},
					},
					required: ["projectPath"],
				},
			},
			handler: installPackage,
		},
	];

	const handlers = new Map(definitions.map((definition) => [definition.tool.name, definition.handler]));
	const names = new Set(definitions.map((definition) => definition.tool.name));

	return {
		tools: definitions.map((definition) => definition.tool),
		hasTool: (name) => handlers.has(name),
		callTool: async (name, args) => {
			const handler = handlers.get(name);
			if (!handler) {
				throw new Error(`Unknown local tool: ${name}`);
			}
			return handler(args);
		},
		names,
	};
}