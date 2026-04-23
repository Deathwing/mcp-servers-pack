import OpenAI from "openai";
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { localGenerate, isLocalConfigured } from "./localClient.js";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();

function resolveUserPath(userPath: string): string {
	if (path.isAbsolute(userPath)) return path.normalize(userPath);
	return path.resolve(WORKSPACE_ROOT, userPath);
}

/** Map OpenAI pixel sizes to Gemini aspect ratios */
function sizeToAspectRatio(
	size: string,
): string | undefined {
	switch (size) {
		case "1024x1024":
			return "1:1";
		case "1024x1536":
			return "3:4";
		case "1536x1024":
			return "4:3";
		default:
			return undefined; // let Gemini pick
	}
}

const InputSchema = z.object({
	prompt: z
		.string()
		.describe(
			"Description of the image to generate. Be specific about style, colors, transparency, and dimensions.",
		),
	provider: z
		.enum(["openai", "gemini", "local"])
		.default("openai")
		.describe(
			"Which AI provider to use. 'openai' uses gpt-image-2, 'gemini' uses Google Gemini Image, 'local' uses a locally running SD server (set LOCAL_SD_URL).",
		),
	model: z
		.string()
		.optional()
		.describe(
			"Override the model. Defaults: openai='gpt-image-2', gemini='gemini-3-pro-image-preview', local=server default.",
		),
	negative_prompt: z
		.string()
		.optional()
		.describe(
			"Negative prompt — things to avoid in the image (local provider only).",
		),
	steps: z
		.number()
		.int()
		.min(1)
		.max(150)
		.optional()
		.describe(
			"Number of sampling steps (local provider only, default: server decides).",
		),
	cfg_scale: z
		.number()
		.optional()
		.describe(
			"Classifier-free guidance scale (local provider only, default: server decides).",
		),
	seed: z
		.number()
		.int()
		.optional()
		.describe(
			"RNG seed for reproducible results (local provider only). Use -1 for random.",
		),
	size: z
		.enum(["1024x1024", "1024x1536", "1536x1024", "auto"])
		.default("auto")
		.describe(
			"Image dimensions (OpenAI). For Gemini, mapped to closest aspect ratio. Use 1024x1024 for square, 1024x1536 for portrait, 1536x1024 for landscape.",
		),
	aspect_ratio: z
		.enum(["1:1", "3:4", "4:3", "9:16", "16:9"])
		.optional()
		.describe(
			"Aspect ratio (Gemini only). Overrides size-to-ratio mapping when provider is 'gemini'.",
		),
	quality: z
		.enum(["low", "medium", "high"])
		.default("medium")
		.describe(
			"Generation quality (OpenAI only). Use 'low' for quick iterations, 'high' for final assets.",
		),
	background: z
		.enum(["transparent", "opaque", "auto"])
		.default("auto")
		.describe(
			"Background type (OpenAI only). Use 'transparent' for sprites/icons/UI elements.",
		),
	count: z
		.number()
		.int()
		.min(1)
		.max(10)
		.default(1)
		.describe(
			"Number of images to generate (1–10). OpenAI generates them in one API call; Gemini and local make sequential calls.",
		),
	save_to: z
		.string()
		.optional()
		.describe(
			"Optional path to save the image. Absolute or relative to WORKSPACE_ROOT. Directories are created automatically. When count > 1, files are saved as name_1.ext, name_2.ext, etc.",
		),
});

export type GenerateImageInput = z.infer<typeof InputSchema>;

export const generateImageTool = {
	name: "generate_image",
	description: `Generate one or more images using OpenAI gpt-image-2, Google Gemini Image, or a local Stable Diffusion server. Returns images as viewable content and optionally saves them to disk.

Set provider to "openai" (default), "gemini", or "local". Cloud providers require API keys. Local requires a running server at LOCAL_SD_URL (default: http://127.0.0.1:1234).

Use count (1–10) to generate multiple variations in one call. OpenAI generates all at once; Gemini and local make sequential calls.

The local provider works with stable-diffusion.cpp (sd-server), AUTOMATIC1111/Forge, or any OpenAI-compatible image API. Run models like FLUX, SDXL, SD3.5 on your own hardware — even quantized GGUF on CPU.

Best for: creating textures, UI elements, icons, sprites, illustrations, logos, backgrounds.

For transparent PNGs (sprites, icons, UI overlays), use OpenAI with background "transparent".`,
	inputSchema: InputSchema,

	async execute(
		input: GenerateImageInput,
		openai?: OpenAI,
		gemini?: GoogleGenAI,
	) {
		const count = input.count ?? 1;
		const images: { data: string; mimeType: string }[] = [];

		if (input.provider === "local") {
			if (!isLocalConfigured()) {
				throw new Error(
					"LOCAL_SD_URL not configured. Set it to your local SD server address (e.g. http://127.0.0.1:1234).",
				);
			}
			for (let i = 0; i < count; i++) {
				const result = await localGenerate({
					prompt: input.prompt,
					negative_prompt: input.negative_prompt,
					size: input.size !== "auto" ? input.size : undefined,
					steps: input.steps,
					cfg_scale: input.cfg_scale,
					seed: input.seed,
					model: input.model,
				});
				images.push({ data: result.base64, mimeType: "image/png" });
			}
		} else if (input.provider === "gemini") {
			if (!gemini) throw new Error("GEMINI_API_KEY not configured");
			const model = input.model ?? "gemini-3-pro-image-preview";
			for (let i = 0; i < count; i++) {
				const response = await gemini.models.generateContent({
					model,
					contents: [
						{
							role: "user",
							parts: [{ text: input.prompt }],
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
				images.push({
					data: imagePart.inlineData.data,
					mimeType: imagePart.inlineData.mimeType ?? "image/png",
				});
			}
		} else {
			if (!openai) throw new Error("OPENAI_API_KEY not configured");
			const model = input.model ?? "gpt-image-2";
			const response = await openai.images.generate({
				model,
				prompt: input.prompt,
				n: count,
				size: input.size,
				quality: input.quality,
				background: input.background,
				output_format: "png",
			});
			for (const imageData of response.data ?? []) {
				if (imageData.b64_json) {
					images.push({ data: imageData.b64_json, mimeType: "image/png" });
				}
			}
		}

		const contentBlocks: Array<
			| { type: "image"; data: string; mimeType: string }
			| { type: "text"; text: string }
		> = [];

		for (let i = 0; i < images.length; i++) {
			const { data, mimeType } = images[i];
			contentBlocks.push({ type: "image" as const, data, mimeType });

			const byteSize = Buffer.from(data, "base64").length;
			const label = images.length > 1 ? ` ${i + 1}/${images.length}` : "";

			if (input.save_to) {
				let absPath = resolveUserPath(input.save_to);
				if (images.length > 1) {
					const ext = path.extname(absPath);
					const base = ext ? absPath.slice(0, -ext.length) : absPath;
					absPath = `${base}_${i + 1}${ext}`;
				}
				await fs.mkdir(path.dirname(absPath), { recursive: true });
				await fs.writeFile(absPath, Buffer.from(data, "base64"));
				contentBlocks.push({
					type: "text" as const,
					text: `Image${label} saved to: ${absPath} (${byteSize} bytes, provider: ${input.provider})`,
				});
			} else {
				contentBlocks.push({
					type: "text" as const,
					text: `Image${label} generated (${byteSize} bytes, provider: ${input.provider}). Provide save_to to write it to disk.`,
				});
			}
		}

		return { content: contentBlocks };
	},
};
