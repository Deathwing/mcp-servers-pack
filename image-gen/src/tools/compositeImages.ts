import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();

function resolveUserPath(userPath: string): string {
	if (path.isAbsolute(userPath)) return path.normalize(userPath);
	return path.resolve(WORKSPACE_ROOT, userPath);
}

const LayerSchema = z.object({
	file_path: z
		.string()
		.describe("Path to the layer image. Absolute or relative to WORKSPACE_ROOT."),
	left: z
		.number()
		.int()
		.default(0)
		.describe("X offset in pixels from the left edge of the canvas."),
	top: z
		.number()
		.int()
		.default(0)
		.describe("Y offset in pixels from the top edge of the canvas."),
	opacity: z
		.number()
		.min(0)
		.max(1)
		.default(1)
		.describe("Layer opacity (0 = transparent, 1 = fully opaque)."),
	blend: z
		.enum([
			"over",
			"add",
			"multiply",
			"screen",
			"overlay",
			"darken",
			"lighten",
			"hard-light",
			"soft-light",
			"difference",
			"exclusion",
		])
		.default("over")
		.describe("Blend mode for this layer."),
});

const InputSchema = z.object({
	base: z
		.string()
		.describe(
			"Path to the base/background image. Absolute or relative to WORKSPACE_ROOT.",
		),
	layers: z
		.array(LayerSchema)
		.min(1)
		.describe("Array of layers to composite on top of the base image, in order (bottom to top)."),
	save_to: z
		.string()
		.describe(
			"Path to save the composited image. Absolute or relative to WORKSPACE_ROOT.",
		),
});

export type CompositeImagesInput = z.infer<typeof InputSchema>;

export const compositeImagesTool = {
	name: "composite_images",
	description: `Composite (layer) multiple images together with positioning, opacity, and blend modes. Uses sharp locally — zero API cost.

Provide a base image and an array of layers. Each layer has position (left/top), opacity, and blend mode. Layers are applied bottom-to-top.

Best for: building UI mockups, overlaying sprites, combining foreground/background, creating thumbnails with badges.`,
	inputSchema: InputSchema,

	async execute(input: CompositeImagesInput) {
		const absBasePath = resolveUserPath(input.base);
		const absSavePath = resolveUserPath(input.save_to);

		const compositeOps: sharp.OverlayOptions[] = [];

		for (const layer of input.layers) {
			const absLayerPath = resolveUserPath(layer.file_path);
			let layerBuffer: Buffer;

			if (layer.opacity < 1) {
				// Apply opacity by manipulating alpha channel
				const raw = await sharp(absLayerPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
				const { data, info } = raw;
				for (let i = 3; i < data.length; i += 4) {
					data[i] = Math.round(data[i] * layer.opacity);
				}
				layerBuffer = await sharp(data, {
					raw: { width: info.width, height: info.height, channels: 4 },
				})
					.png()
					.toBuffer();
			} else {
				layerBuffer = await fs.readFile(absLayerPath);
			}

			compositeOps.push({
				input: layerBuffer,
				left: layer.left,
				top: layer.top,
				blend: layer.blend,
			});
		}

		await fs.mkdir(path.dirname(absSavePath), { recursive: true });
		await sharp(absBasePath).composite(compositeOps).toFile(absSavePath);

		const meta = await sharp(absSavePath).metadata();

		return {
			content: [
				{
					type: "text" as const,
					text: [
						`Composited: ${input.layers.length} layer(s) onto ${input.base} → ${input.save_to}`,
						`  Output: ${meta.width}×${meta.height} ${meta.format}`,
						...input.layers.map(
							(l, i) =>
								`  Layer ${i + 1}: ${l.file_path} at (${l.left},${l.top}) blend=${l.blend} opacity=${l.opacity}`,
						),
					].join("\n"),
				},
			],
		};
	},
};
