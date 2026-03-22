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
	width: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Target width in pixels. Omit to auto-calculate from height + aspect ratio."),
	height: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Target height in pixels. Omit to auto-calculate from width + aspect ratio."),
	scale: z
		.number()
		.positive()
		.optional()
		.describe("Scale factor (e.g. 0.5 for half size, 2 for double). Overrides width/height."),
	fit: z
		.enum(["cover", "contain", "fill", "inside", "outside"])
		.default("inside")
		.describe(
			"How to fit: 'cover' (crop to fill), 'contain' (fit within, letterbox), 'fill' (stretch), 'inside' (fit within, no enlarge), 'outside' (cover, no shrink).",
		),
	save_to: z
		.string()
		.describe(
			"Path to save the resized image. Absolute or relative to WORKSPACE_ROOT.",
		),
});

export type ResizeImageInput = z.infer<typeof InputSchema>;

export const resizeImageTool = {
	name: "resize_image",
	description: `Resize an image to specific dimensions or by a scale factor. Uses sharp locally — zero API cost.

Provide width and/or height, or a scale factor. Preserves aspect ratio by default.`,
	inputSchema: InputSchema,

	async execute(input: ResizeImageInput) {
		const absPath = resolveUserPath(input.file_path);
		const absSavePath = resolveUserPath(input.save_to);

		const originalMeta = await sharp(absPath).metadata();

		let pipeline = sharp(absPath);

		if (input.scale) {
			const w = Math.round((originalMeta.width ?? 0) * input.scale);
			const h = Math.round((originalMeta.height ?? 0) * input.scale);
			pipeline = pipeline.resize(w, h, { fit: input.fit });
		} else if (input.width || input.height) {
			pipeline = pipeline.resize(input.width, input.height, {
				fit: input.fit,
			});
		} else {
			throw new Error(
				"Provide width/height or scale factor.",
			);
		}

		await fs.mkdir(path.dirname(absSavePath), { recursive: true });
		await pipeline.toFile(absSavePath);

		const newMeta = await sharp(absSavePath).metadata();

		return {
			content: [
				{
					type: "text" as const,
					text: [
						`Resized: ${input.file_path} → ${input.save_to}`,
						`  Original: ${originalMeta.width}×${originalMeta.height}`,
						`  New: ${newMeta.width}×${newMeta.height}`,
						`  Fit: ${input.fit}`,
						input.scale ? `  Scale: ${input.scale}×` : "",
					]
						.filter(Boolean)
						.join("\n"),
				},
			],
		};
	},
};
