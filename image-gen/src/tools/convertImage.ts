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
			"Path to the source image. Absolute or relative to WORKSPACE_ROOT.",
		),
	format: z
		.enum(["png", "jpeg", "webp", "avif", "tiff"])
		.describe("Target format."),
	quality: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(85)
		.describe("Compression quality (1-100). Applies to jpeg, webp, avif."),
	save_to: z
		.string()
		.describe(
			"Path to save the converted image. Absolute or relative to WORKSPACE_ROOT.",
		),
});

export type ConvertImageInput = z.infer<typeof InputSchema>;

export const convertImageTool = {
	name: "convert_image",
	description: `Convert an image between formats (PNG, JPEG, WebP, AVIF, TIFF) with quality control. Uses sharp locally — zero API cost.

Use WebP/AVIF for smallest file sizes on web. Use PNG for transparency. Use JPEG for photos without alpha.`,
	inputSchema: InputSchema,

	async execute(input: ConvertImageInput) {
		const absPath = resolveUserPath(input.file_path);
		const absSavePath = resolveUserPath(input.save_to);

		const originalMeta = await sharp(absPath).metadata();
		const originalSize = (await fs.stat(absPath)).size;

		let pipeline = sharp(absPath);

		switch (input.format) {
			case "png":
				pipeline = pipeline.png();
				break;
			case "jpeg":
				pipeline = pipeline.jpeg({ quality: input.quality });
				break;
			case "webp":
				pipeline = pipeline.webp({ quality: input.quality });
				break;
			case "avif":
				pipeline = pipeline.avif({ quality: input.quality });
				break;
			case "tiff":
				pipeline = pipeline.tiff({ quality: input.quality });
				break;
		}

		await fs.mkdir(path.dirname(absSavePath), { recursive: true });
		await pipeline.toFile(absSavePath);

		const newSize = (await fs.stat(absSavePath)).size;
		const ratio = ((newSize / originalSize) * 100).toFixed(1);

		return {
			content: [
				{
					type: "text" as const,
					text: [
						`Converted: ${input.file_path} → ${input.save_to}`,
						`  Format: ${originalMeta.format} → ${input.format}`,
						`  Size: ${(originalSize / 1024).toFixed(1)} KB → ${(newSize / 1024).toFixed(1)} KB (${ratio}%)`,
						input.format !== "png"
							? `  Quality: ${input.quality}`
							: "",
					]
						.filter(Boolean)
						.join("\n"),
				},
			],
		};
	},
};
