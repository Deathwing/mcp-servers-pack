import OpenAI, { toFile } from "openai";
import type { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { localEdit, isLocalConfigured } from "./localClient.js";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();

function resolveUserPath(userPath: string): string {
	if (path.isAbsolute(userPath)) return path.normalize(userPath);
	return path.resolve(WORKSPACE_ROOT, userPath);
}

const InputSchema = z.object({
	file_path: z
		.string()
		.describe(
			"Path to the source texture image. Absolute or relative to WORKSPACE_ROOT.",
		),
	provider: z
		.enum(["openai", "gemini", "local"])
		.default("openai")
		.describe("Which AI provider to use for edge inpainting. 'local' sends to your local SD server."),
	model: z
		.string()
		.optional()
		.describe(
			"Override the model. Defaults: openai='gpt-image-1', gemini='imagen-3.0-capability-001'.",
		),
	save_to: z
		.string()
		.describe("Path to save the tileable texture. Absolute or relative to WORKSPACE_ROOT."),
});

export type CreateTileableInput = z.infer<typeof InputSchema>;

export const createTileableTool = {
	name: "create_tileable",
	description: `Make a texture seamlessly tileable using AI inpainting.

Strategy: takes the source texture, creates a 2×2 tiled version with the center seams exposed, uses AI to inpaint the seam region, then extracts the center tile back out. The result tiles seamlessly in all directions.

Best for: game textures, background patterns, material surfaces that need to repeat without visible seams.`,
	inputSchema: InputSchema,

	async execute(
		input: CreateTileableInput,
		openai?: OpenAI,
		gemini?: GoogleGenAI,
	) {
		const absPath = resolveUserPath(input.file_path);
		const absSavePath = resolveUserPath(input.save_to);

		// Load source and get dimensions
		const srcMeta = await sharp(absPath).metadata();
		const w = srcMeta.width ?? 512;
		const h = srcMeta.height ?? 512;

		// Create a 2×2 tiled image (seams are now in the center)
		const srcBuffer = await sharp(absPath).png().toBuffer();
		const tiledBuffer = await sharp({
			create: {
				width: w * 2,
				height: h * 2,
				channels: 4,
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			},
		})
			.composite([
				{ input: srcBuffer, left: 0, top: 0 },
				{ input: srcBuffer, left: w, top: 0 },
				{ input: srcBuffer, left: 0, top: h },
				{ input: srcBuffer, left: w, top: h },
			])
			.png()
			.toBuffer();

		// Extract the center region (which contains the seam cross)
		const halfW = Math.floor(w / 2);
		const halfH = Math.floor(h / 2);
		const seamRegion = await sharp(tiledBuffer)
			.extract({ left: halfW, top: halfH, width: w, height: h })
			.png()
			.toBuffer();

		// Use AI to fix the seam cross in the center region
		const prompt =
			"Fix the visible seams and discontinuities in this texture so it becomes seamless. " +
			"Blend the edges naturally while preserving the overall texture pattern, colors, and style. " +
			"Do not add new elements — only smooth the transitions.";

		let fixedBase64: string;

		if (input.provider === "local") {
			if (!isLocalConfigured()) {
				throw new Error(
					"LOCAL_SD_URL not configured. Set it to your local SD server address.",
				);
			}

			// Write seam region to a temp file for the local client
			const tmpSeam = path.join(
				path.dirname(absSavePath),
				`_seam_tmp_${Date.now()}.png`,
			);
			await fs.writeFile(tmpSeam, seamRegion);

			try {
				const result = await localEdit({
					source_path: tmpSeam,
					prompt,
					strength: 0.5,
					model: input.model,
				});
				fixedBase64 = result.base64;
			} finally {
				await fs.unlink(tmpSeam).catch(() => {});
			}
		} else if (input.provider === "gemini") {
			if (!gemini) throw new Error("GEMINI_API_KEY not configured");

			const model = input.model ?? "gemini-3-pro-image-preview";

			const response = await gemini.models.generateContent({
				model,
				contents: [
					{
						role: "user",
						parts: [
							{
								inlineData: {
									mimeType: "image/png",
									data: seamRegion.toString("base64"),
								},
							},
							{ text: prompt },
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
			if (!imagePart?.inlineData?.data)
				throw new Error("No image data returned from Gemini API");
			fixedBase64 = imagePart.inlineData.data;
		} else {
			if (!openai) throw new Error("OPENAI_API_KEY not configured");

			const model = input.model ?? "gpt-image-1.5";
			const imageFile = await toFile(seamRegion, "seam-region.png", {
				type: "image/png",
			});

			const response = await openai.images.edit({
				model,
				image: imageFile,
				prompt,
				n: 1,
				size: "1024x1024",
				quality: "high",
			});

			const imageData = response.data?.[0];
			if (!imageData?.b64_json)
				throw new Error("No image data returned from OpenAI API");
			fixedBase64 = imageData.b64_json;
		}

		// Resize fixed region to match original tile dimensions and extract center
		const fixedBuffer = await sharp(Buffer.from(fixedBase64, "base64"))
			.resize(w, h, { fit: "fill" })
			.png()
			.toBuffer();

		// Reconstruct: overlay the fixed center onto the 2×2 grid
		const reconstructedBuffer = await sharp(tiledBuffer)
			.composite([{ input: fixedBuffer, left: halfW, top: halfH }])
			.png()
			.toBuffer();

		// Extract the final tile from the center
		await fs.mkdir(path.dirname(absSavePath), { recursive: true });
		await sharp(reconstructedBuffer)
			.extract({ left: halfW, top: halfH, width: w, height: h })
			.toFile(absSavePath);

		return {
			content: [
				{
					type: "text" as const,
					text: [
						`Tileable texture created: ${input.file_path} → ${input.save_to}`,
						`  Size: ${w}×${h}`,
						`  Provider: ${input.provider}`,
						"  Method: 2×2 tile → center seam inpaint → re-extract",
					].join("\n"),
				},
			],
		};
	},
};
