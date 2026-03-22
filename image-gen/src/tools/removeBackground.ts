import OpenAI from "openai";
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();

function resolveUserPath(userPath: string): string {
	if (path.isAbsolute(userPath)) return path.normalize(userPath);
	return path.resolve(WORKSPACE_ROOT, userPath);
}

const InputSchema = z.object({
	file_path: z
		.string()
		.describe(
			"Path to the source image. Absolute or relative to WORKSPACE_ROOT.",
		),
	prompt: z
		.string()
		.default(
			"Remove the background completely and keep only the main subject with a transparent background.",
		)
		.describe(
			"Instruction for background removal. Customize to preserve specific elements.",
		),
	provider: z
		.enum(["openai", "gemini", "local"])
		.default("openai")
		.describe("Which AI provider to use. 'local' sends to your local SD server."),
	model: z
		.string()
		.optional()
		.describe(
			"Override the model. Defaults: openai='gpt-image-1', gemini='imagen-3.0-capability-001'.",
		),
	save_to: z
		.string()
		.describe(
			"Path to save the result (should be .png for transparency). Absolute or relative to WORKSPACE_ROOT.",
		),
});

export type RemoveBackgroundInput = z.infer<typeof InputSchema>;

export const removeBackgroundTool = {
	name: "remove_background",
	description: `Remove the background from an image using AI, producing a transparent PNG.

Uses the image editing API (OpenAI gpt-image-1, Gemini Imagen, or local SD server) with a background removal prompt. Best for: extracting characters, objects, icons from photos or screenshots.`,
	inputSchema: InputSchema,

	async execute(
		input: RemoveBackgroundInput,
		openai?: OpenAI,
		gemini?: GoogleGenAI,
	) {
		// Delegate to the edit flow with the removal prompt
		const { editImageTool } = await import("./editImage.js");

		const result = await editImageTool.execute(
			{
				source_path: input.file_path,
				prompt: input.prompt,
				provider: input.provider,
				model: input.model,
				size: "auto",
				quality: "high",
				save_to: input.save_to,
			},
			openai,
			gemini,
		);

		// Replace the status text to reflect this is background removal
		const content = result.content.map((block) => {
			if (block.type === "text") {
				return {
					...block,
					text: block.text
						.replace("Edited image saved to", "Background removed, saved to")
						.replace("Image edited", "Background removed"),
				};
			}
			return block;
		});

		return { content };
	},
};
