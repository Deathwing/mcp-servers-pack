import OpenAI, { toFile } from "openai";
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { localEdit, isLocalConfigured } from "./localClient.js";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();

function resolveUserPath(userPath: string): string {
	if (path.isAbsolute(userPath)) return path.normalize(userPath);
	return path.resolve(WORKSPACE_ROOT, userPath);
}

const InputSchema = z.object({
	source_path: z
		.string()
		.describe(
			"Path to the source image to edit. Absolute or relative to WORKSPACE_ROOT.",
		),
	prompt: z
		.string()
		.describe("Description of the changes to make to the image."),
	provider: z
		.enum(["openai", "gemini", "local"])
		.default("openai")
		.describe(
			"Which AI provider to use. 'openai' uses gpt-image-1, 'gemini' uses Google Imagen, 'local' uses a locally running SD server (set LOCAL_SD_URL).",
		),
	model: z
		.string()
		.optional()
		.describe(
			"Override the model. Defaults: openai='gpt-image-1', gemini='imagen-3.0-capability-001', local=server default.",
		),
	negative_prompt: z
		.string()
		.optional()
		.describe(
			"Negative prompt — things to avoid (local provider only).",
		),
	strength: z
		.number()
		.min(0)
		.max(1)
		.optional()
		.describe(
			"Denoising strength 0.0–1.0 (local provider only). Lower = closer to original image. Default: 0.75.",
		),
	steps: z
		.number()
		.int()
		.min(1)
		.max(150)
		.optional()
		.describe(
			"Number of sampling steps (local provider only).",
		),
	cfg_scale: z
		.number()
		.optional()
		.describe(
			"Classifier-free guidance scale (local provider only).",
		),
	seed: z
		.number()
		.int()
		.optional()
		.describe(
			"RNG seed for reproducible results (local provider only).",
		),
	size: z
		.enum(["1024x1024", "1024x1536", "1536x1024", "auto"])
		.default("auto")
		.describe("Output image dimensions (OpenAI only)."),
	quality: z
		.enum(["low", "medium", "high"])
		.default("medium")
		.describe("Generation quality (OpenAI only)."),
	save_to: z
		.string()
		.optional()
		.describe(
			"Optional path to save the edited image. Absolute or relative to WORKSPACE_ROOT.",
		),
});

export type EditImageInput = z.infer<typeof InputSchema>;

export const editImageTool = {
	name: "edit_image",
	description: `Edit an existing image using OpenAI gpt-image-1, Google Imagen, or a local Stable Diffusion server. Reads a source image from disk, applies the described changes, and returns the result.

Set provider to "openai" (default), "gemini", or "local". Cloud providers require API keys. Local requires a running server at LOCAL_SD_URL.

The local provider sends the image as an img2img request to the local server with configurable denoising strength.

Best for: modifying existing images — recoloring, adding effects, changing style, compositing.`,
	inputSchema: InputSchema,

	async execute(
		input: EditImageInput,
		openai?: OpenAI,
		gemini?: GoogleGenAI,
	) {
		const absSourcePath = resolveUserPath(input.source_path);
		let base64: string;
		let outputMimeType = "image/png";

		if (input.provider === "local") {
			if (!isLocalConfigured()) {
				throw new Error(
					"LOCAL_SD_URL not configured. Set it to your local SD server address (e.g. http://127.0.0.1:1234).",
				);
			}

			const result = await localEdit({
				source_path: absSourcePath,
				prompt: input.prompt,
				negative_prompt: input.negative_prompt,
				size: input.size !== "auto" ? input.size : undefined,
				steps: input.steps,
				cfg_scale: input.cfg_scale,
				strength: input.strength,
				seed: input.seed,
				model: input.model,
			});
			base64 = result.base64;
		} else if (input.provider === "gemini") {
			if (!gemini) throw new Error("GEMINI_API_KEY not configured");

			const model = input.model ?? "gemini-3-pro-image-preview";
			const imageBuffer = await fs.readFile(absSourcePath);
			const base64Input = imageBuffer.toString("base64");
			const mimeType = absSourcePath.toLowerCase().endsWith(".png")
				? "image/png"
				: "image/jpeg";

			const response = await gemini.models.generateContent({
				model,
				contents: [
					{
						role: "user",
						parts: [
							{
								inlineData: {
									mimeType,
									data: base64Input,
								},
							},
							{ text: input.prompt },
						],
					},
				],
				config: {
					responseModalities: ["IMAGE", "TEXT"],
				},
			});

			const imagePart = response.candidates?.[0]?.content?.parts?.find(
				(p: { inlineData?: { mimeType?: string } }) =>
					p.inlineData?.mimeType?.startsWith("image/"),
			);
			if (!imagePart?.inlineData?.data) {
				throw new Error("No image data returned from Gemini API");
			}
			base64 = imagePart.inlineData.data;
			outputMimeType = imagePart.inlineData.mimeType ?? "image/png";
		} else {
			if (!openai) throw new Error("OPENAI_API_KEY not configured");

			const model = input.model ?? "gpt-image-1.5";
			const imageBuffer = await fs.readFile(absSourcePath);
			const imageFile = await toFile(
				imageBuffer,
				path.basename(absSourcePath),
				{ type: "image/png" },
			);

			const response = await openai.images.edit({
				model,
				image: imageFile,
				prompt: input.prompt,
				n: 1,
				size: input.size,
				quality: input.quality,
			});

			const imageData = response.data?.[0];
			if (!imageData?.b64_json) {
				throw new Error("No image data returned from OpenAI API");
			}
			base64 = imageData.b64_json;
		}

		const contentBlocks: Array<
			| { type: "image"; data: string; mimeType: string }
			| { type: "text"; text: string }
		> = [
			{
				type: "image" as const,
				data: base64,
				mimeType: outputMimeType,
			},
		];

		const byteSize = Buffer.from(base64, "base64").length;

		if (input.save_to) {
			const absSavePath = resolveUserPath(input.save_to);
			await fs.mkdir(path.dirname(absSavePath), { recursive: true });
			await fs.writeFile(absSavePath, Buffer.from(base64, "base64"));

			contentBlocks.push({
				type: "text" as const,
				text: `Edited image saved to: ${input.save_to} (${byteSize} bytes, provider: ${input.provider})`,
			});
		} else {
			contentBlocks.push({
				type: "text" as const,
				text: `Image edited (${byteSize} bytes, provider: ${input.provider}). Provide save_to to write it to disk.`,
			});
		}

		return { content: contentBlocks };
	},
};
