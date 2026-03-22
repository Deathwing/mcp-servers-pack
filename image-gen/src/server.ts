#!/usr/bin/env node

/**
 * MCP Image Generation Server
 *
 * General-purpose image generation, editing, and conversion tools
 * powered by OpenAI's gpt-image-1 and Google's Imagen models.
 *
 * Transport: stdio (launched by VS Code via mcp.json)
 * Required env: At least one of OPENAI_API_KEY or GEMINI_API_KEY
 * Optional env: WORKSPACE_ROOT (defaults to cwd)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

import { generateImageTool } from "./tools/generateImage.js";
import { editImageTool } from "./tools/editImage.js";
import { imageToBase64Tool } from "./tools/imageToBase64.js";
import { getImageInfoTool } from "./tools/getImageInfo.js";
import { describeImageTool } from "./tools/describeImage.js";
import { compareImagesTool } from "./tools/compareImages.js";
import { resizeImageTool } from "./tools/resizeImage.js";
import { cropImageTool } from "./tools/cropImage.js";
import { removeBackgroundTool } from "./tools/removeBackground.js";
import { compositeImagesTool } from "./tools/compositeImages.js";
import { convertImageTool } from "./tools/convertImage.js";
import { createSpriteSheetTool } from "./tools/createSpriteSheet.js";
import { createTileableTool } from "./tools/createTileable.js";
import { setupStableDiffusionTool } from "./tools/setupStableDiffusion.js";

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LOCAL_SD_URL = process.env.LOCAL_SD_URL;

if (!OPENAI_API_KEY && !GEMINI_API_KEY && !LOCAL_SD_URL) {
	console.error(
		"[image-gen] ERROR: Set at least one of OPENAI_API_KEY, GEMINI_API_KEY, or LOCAL_SD_URL.\n" +
			"Set them in your shell profile or VS Code mcp.json inputs.",
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// AI clients
// ---------------------------------------------------------------------------

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : undefined;
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : undefined;

const availableProviders: string[] = [];
if (openai) availableProviders.push("openai");
if (gemini) availableProviders.push("gemini");
if (LOCAL_SD_URL) availableProviders.push(`local (${LOCAL_SD_URL})`);
console.error(`[image-gen] Providers: ${availableProviders.join(", ")}`);

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
	name: "image-gen",
	version: "4.0.0",
});

// -- generate_image --
server.tool(
	generateImageTool.name,
	generateImageTool.description,
	generateImageTool.inputSchema.shape,
	async (input) => {
		return generateImageTool.execute(input as any, openai, gemini);
	},
);

// -- edit_image --
server.tool(
	editImageTool.name,
	editImageTool.description,
	editImageTool.inputSchema.shape,
	async (input) => {
		return editImageTool.execute(input as any, openai, gemini);
	},
);

// -- image_to_base64 --
server.tool(
	imageToBase64Tool.name,
	imageToBase64Tool.description,
	imageToBase64Tool.inputSchema.shape,
	async (input) => {
		return imageToBase64Tool.execute(input as any);
	},
);

// -- get_image_info --
server.tool(
	getImageInfoTool.name,
	getImageInfoTool.description,
	getImageInfoTool.inputSchema.shape,
	async (input) => {
		return getImageInfoTool.execute(input as any);
	},
);

// -- describe_image --
server.tool(
	describeImageTool.name,
	describeImageTool.description,
	describeImageTool.inputSchema.shape,
	async (input) => {
		return describeImageTool.execute(input as any, openai, gemini);
	},
);

// -- compare_images --
server.tool(
	compareImagesTool.name,
	compareImagesTool.description,
	compareImagesTool.inputSchema.shape,
	async (input) => {
		return compareImagesTool.execute(input as any, openai, gemini);
	},
);

// -- resize_image --
server.tool(
	resizeImageTool.name,
	resizeImageTool.description,
	resizeImageTool.inputSchema.shape,
	async (input) => {
		return resizeImageTool.execute(input as any);
	},
);

// -- crop_image --
server.tool(
	cropImageTool.name,
	cropImageTool.description,
	cropImageTool.inputSchema.shape,
	async (input) => {
		return cropImageTool.execute(input as any);
	},
);

// -- remove_background --
server.tool(
	removeBackgroundTool.name,
	removeBackgroundTool.description,
	removeBackgroundTool.inputSchema.shape,
	async (input) => {
		return removeBackgroundTool.execute(input as any, openai, gemini);
	},
);

// -- composite_images --
server.tool(
	compositeImagesTool.name,
	compositeImagesTool.description,
	compositeImagesTool.inputSchema.shape,
	async (input) => {
		return compositeImagesTool.execute(input as any);
	},
);

// -- convert_image --
server.tool(
	convertImageTool.name,
	convertImageTool.description,
	convertImageTool.inputSchema.shape,
	async (input) => {
		return convertImageTool.execute(input as any);
	},
);

// -- create_sprite_sheet --
server.tool(
	createSpriteSheetTool.name,
	createSpriteSheetTool.description,
	createSpriteSheetTool.inputSchema.shape,
	async (input) => {
		return createSpriteSheetTool.execute(input as any);
	},
);

// -- create_tileable --
server.tool(
	createTileableTool.name,
	createTileableTool.description,
	createTileableTool.inputSchema.shape,
	async (input) => {
		return createTileableTool.execute(input as any, openai, gemini);
	},
);

// -- setup_stable_diffusion --
server.tool(
	setupStableDiffusionTool.name,
	setupStableDiffusionTool.description,
	setupStableDiffusionTool.inputSchema.shape,
	async (input) => {
		return setupStableDiffusionTool.execute(input as any);
	},
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("[image-gen] MCP server started (stdio transport)");
}

main().catch((err) => {
	console.error("[image-gen] Fatal error:", err);
	process.exit(1);
});
