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
});

export type GetImageInfoInput = z.infer<typeof InputSchema>;

export const getImageInfoTool = {
	name: "get_image_info",
	description: `Get metadata about an image file: dimensions, format, color space, channels, has alpha, file size, DPI.

Zero API cost — uses sharp locally. Use this before deciding how to process an image.`,
	inputSchema: InputSchema,

	async execute(input: GetImageInfoInput) {
		const absPath = resolveUserPath(input.file_path);
		const [metadata, stats] = await Promise.all([
			sharp(absPath).metadata(),
			fs.stat(absPath),
		]);

		const info = {
			path: input.file_path,
			width: metadata.width,
			height: metadata.height,
			format: metadata.format,
			channels: metadata.channels,
			hasAlpha: metadata.hasAlpha ?? false,
			colorSpace: metadata.space,
			density: metadata.density,
			isProgressive: metadata.isProgressive ?? false,
			pages: metadata.pages,
			fileSizeBytes: stats.size,
			fileSizeKB: +(stats.size / 1024).toFixed(1),
		};

		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(info, null, 2),
				},
			],
		};
	},
};
