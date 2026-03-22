import OpenAI from "openai";
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();

function resolveUserPath(userPath: string): string {
	if (path.isAbsolute(userPath)) return path.normalize(userPath);
	return path.resolve(WORKSPACE_ROOT, userPath);
}

const InputSchema = z.object({
	file_path: z
		.string()
		.describe(
			"Path to the image file. Absolute or relative to WORKSPACE_ROOT.",
		),
	prompt: z
		.string()
		.default("Describe this image in detail.")
		.describe(
			"Question or instruction about the image. Default: general description.",
		),
	provider: z
		.enum(["openai", "gemini"])
		.default("openai")
		.describe(
			"Which AI provider to use. 'openai' uses GPT-4o, 'gemini' uses Gemini 2.0 Flash.",
		),
	model: z
		.string()
		.optional()
		.describe(
			"Override the vision model. Defaults: openai='gpt-4o', gemini='gemini-2.0-flash'.",
		),
	max_tokens: z
		.number()
		.int()
		.positive()
		.default(1024)
		.describe("Maximum tokens in the response."),
});

export type DescribeImageInput = z.infer<typeof InputSchema>;

export const describeImageTool = {
	name: "describe_image",
	description: `Describe or analyze an image using a vision model (GPT-4o or Gemini Flash).

Send an image from disk and ask any question about it. Use for: understanding screenshots, reading text in images, describing UI layouts, analyzing textures, inspecting game assets, debugging visual issues.

Set provider to "openai" (default, uses GPT-4o) or "gemini" (uses Gemini 2.0 Flash).`,
	inputSchema: InputSchema,

	async execute(
		input: DescribeImageInput,
		openai?: OpenAI,
		gemini?: GoogleGenAI,
	) {
		const absPath = resolveUserPath(input.file_path);
		const imageBuffer = await fs.readFile(absPath);

		// Determine mime type from actual format
		const metadata = await sharp(absPath).metadata();
		const mimeType =
			metadata.format === "png"
				? "image/png"
				: metadata.format === "webp"
					? "image/webp"
					: metadata.format === "gif"
						? "image/gif"
						: "image/jpeg";

		const base64 = imageBuffer.toString("base64");

		let description: string;

		if (input.provider === "gemini") {
			if (!gemini) throw new Error("GEMINI_API_KEY not configured");

			const model = input.model ?? "gemini-3-flash-preview";
			const response = await gemini.models.generateContent({
				model,
				contents: [
					{
						role: "user",
						parts: [
							{
								inlineData: {
									mimeType,
									data: base64,
								},
							},
							{ text: input.prompt },
						],
					},
				],
			});

			description = response.text ?? "No description returned.";
		} else {
			if (!openai) throw new Error("OPENAI_API_KEY not configured");

			const model = input.model ?? "gpt-5-mini-2025-08-07";
			const response = await openai.chat.completions.create({
				model,
				max_completion_tokens: input.max_tokens,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: {
									url: `data:${mimeType};base64,${base64}`,
									detail: "high",
								},
							},
							{ type: "text", text: input.prompt },
						],
					},
				],
			});

			description =
				response.choices[0]?.message?.content ??
				"No description returned.";
		}

		return {
			content: [
				{
					type: "text" as const,
					text: description,
				},
			],
		};
	},
};
