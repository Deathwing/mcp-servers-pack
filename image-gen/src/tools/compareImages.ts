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

async function loadImageAsBase64(absPath: string) {
	const buffer = await fs.readFile(absPath);
	const metadata = await sharp(absPath).metadata();
	const mimeType =
		metadata.format === "png"
			? "image/png"
			: metadata.format === "webp"
				? "image/webp"
				: metadata.format === "gif"
					? "image/gif"
					: "image/jpeg";
	return { base64: buffer.toString("base64"), mimeType, metadata };
}

const InputSchema = z.object({
	image_a: z
		.string()
		.describe(
			"Path to the first image (before / reference). Absolute or relative to WORKSPACE_ROOT.",
		),
	image_b: z
		.string()
		.describe(
			"Path to the second image (after / candidate). Absolute or relative to WORKSPACE_ROOT.",
		),
	prompt: z
		.string()
		.default(
			"Compare these two images. Describe all differences you can see in layout, colors, text, elements, and overall appearance. Be specific and structured.",
		)
		.describe(
			"Custom comparison instructions. Default: comprehensive visual diff.",
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
});

export type CompareImagesInput = z.infer<typeof InputSchema>;

export const compareImagesTool = {
	name: "compare_images",
	description: `Compare two images using a vision model and get a structured diff of visual differences.

Sends both images to GPT-4o or Gemini Flash for analysis. Use for: visual regression testing, before/after comparisons, QA checks, verifying design implementation against reference.`,
	inputSchema: InputSchema,

	async execute(
		input: CompareImagesInput,
		openai?: OpenAI,
		gemini?: GoogleGenAI,
	) {
		const [imgA, imgB] = await Promise.all([
			loadImageAsBase64(resolveUserPath(input.image_a)),
			loadImageAsBase64(resolveUserPath(input.image_b)),
		]);

		let comparison: string;

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
									mimeType: imgA.mimeType,
									data: imgA.base64,
								},
							},
							{
								inlineData: {
									mimeType: imgB.mimeType,
									data: imgB.base64,
								},
							},
							{ text: input.prompt },
						],
					},
				],
			});

			comparison = response.text ?? "No comparison returned.";
		} else {
			if (!openai) throw new Error("OPENAI_API_KEY not configured");

			const model = input.model ?? "gpt-5-mini-2025-08-07";
			const response = await openai.chat.completions.create({
				model,
				max_completion_tokens: 2048,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: {
									url: `data:${imgA.mimeType};base64,${imgA.base64}`,
									detail: "high",
								},
							},
							{
								type: "image_url",
								image_url: {
									url: `data:${imgB.mimeType};base64,${imgB.base64}`,
									detail: "high",
								},
							},
							{ type: "text", text: input.prompt },
						],
					},
				],
			});

			comparison =
				response.choices[0]?.message?.content ??
				"No comparison returned.";
		}

		const header = [
			`Image A: ${input.image_a} (${imgA.metadata.width}×${imgA.metadata.height} ${imgA.metadata.format})`,
			`Image B: ${input.image_b} (${imgB.metadata.width}×${imgB.metadata.height} ${imgB.metadata.format})`,
			`Provider: ${input.provider}`,
			"",
		].join("\n");

		return {
			content: [
				{
					type: "text" as const,
					text: header + comparison,
				},
			],
		};
	},
};
