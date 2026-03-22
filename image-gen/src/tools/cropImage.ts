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
	left: z.number().int().min(0).describe("Left edge of crop region in pixels."),
	top: z.number().int().min(0).describe("Top edge of crop region in pixels."),
	width: z
		.number()
		.int()
		.positive()
		.describe("Width of the crop region in pixels."),
	height: z
		.number()
		.int()
		.positive()
		.describe("Height of the crop region in pixels."),
	save_to: z
		.string()
		.describe(
			"Path to save the cropped image. Absolute or relative to WORKSPACE_ROOT.",
		),
});

export type CropImageInput = z.infer<typeof InputSchema>;

export const cropImageTool = {
	name: "crop_image",
	description: `Crop a rectangular region from an image. Uses sharp locally — zero API cost.

Specify the region with left, top, width, height in pixels. Use get_image_info first to know the image dimensions.`,
	inputSchema: InputSchema,

	async execute(input: CropImageInput) {
		const absPath = resolveUserPath(input.file_path);
		const absSavePath = resolveUserPath(input.save_to);

		const originalMeta = await sharp(absPath).metadata();

		await fs.mkdir(path.dirname(absSavePath), { recursive: true });
		await sharp(absPath)
			.extract({
				left: input.left,
				top: input.top,
				width: input.width,
				height: input.height,
			})
			.toFile(absSavePath);

		return {
			content: [
				{
					type: "text" as const,
					text: [
						`Cropped: ${input.file_path} → ${input.save_to}`,
						`  Original: ${originalMeta.width}×${originalMeta.height}`,
						`  Region: left=${input.left} top=${input.top} ${input.width}×${input.height}`,
					].join("\n"),
				},
			],
		};
	},
};
