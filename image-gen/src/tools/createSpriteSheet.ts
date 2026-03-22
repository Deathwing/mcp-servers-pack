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
	images: z
		.array(z.string())
		.min(1)
		.describe(
			"Array of image paths to pack into the sprite sheet. Absolute or relative to WORKSPACE_ROOT.",
		),
	columns: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Number of columns in the grid. Defaults to ceil(sqrt(count)) for a roughly square layout.",
		),
	cell_width: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Force each cell to this width. Images are resized to fit. If omitted, uses the largest image width.",
		),
	cell_height: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Force each cell to this height. Images are resized to fit. If omitted, uses the largest image height.",
		),
	padding: z
		.number()
		.int()
		.min(0)
		.default(0)
		.describe("Padding in pixels between cells."),
	save_to: z
		.string()
		.describe("Path to save the sprite sheet PNG."),
	atlas_to: z
		.string()
		.optional()
		.describe(
			"Optional path to save the JSON atlas (frame positions and sizes). Required for game engine import.",
		),
});

export type CreateSpriteSheetInput = z.infer<typeof InputSchema>;

interface AtlasFrame {
	filename: string;
	frame: { x: number; y: number; w: number; h: number };
	sourceSize: { w: number; h: number };
}

export const createSpriteSheetTool = {
	name: "create_sprite_sheet",
	description: `Pack multiple images into a grid sprite sheet with an optional JSON atlas. Uses sharp locally — zero API cost.

Outputs a single PNG image and optionally a JSON atlas with frame coordinates. The atlas format is compatible with common game engines and frameworks.

Best for: packing animation frames, icon sets, UI element collections, texture atlases.`,
	inputSchema: InputSchema,

	async execute(input: CreateSpriteSheetInput) {
		const imagePaths = input.images.map((p) => resolveUserPath(p));

		// Load all image metadata
		const metas = await Promise.all(
			imagePaths.map(async (absPath) => {
				const m = await sharp(absPath).metadata();
				return { absPath, width: m.width ?? 0, height: m.height ?? 0 };
			}),
		);

		const cellW =
			input.cell_width ?? Math.max(...metas.map((m) => m.width));
		const cellH =
			input.cell_height ?? Math.max(...metas.map((m) => m.height));
		const cols =
			input.columns ?? Math.ceil(Math.sqrt(metas.length));
		const rows = Math.ceil(metas.length / cols);
		const pad = input.padding;

		const sheetW = cols * cellW + (cols - 1) * pad;
		const sheetH = rows * cellH + (rows - 1) * pad;

		// Build composite operations
		const compositeOps: sharp.OverlayOptions[] = [];
		const frames: AtlasFrame[] = [];

		for (let i = 0; i < metas.length; i++) {
			const col = i % cols;
			const row = Math.floor(i / cols);
			const x = col * (cellW + pad);
			const y = row * (cellH + pad);

			const cellBuffer = await sharp(metas[i].absPath)
				.resize(cellW, cellH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
				.png()
				.toBuffer();

			compositeOps.push({ input: cellBuffer, left: x, top: y });

			frames.push({
				filename: path.basename(input.images[i]),
				frame: { x, y, w: cellW, h: cellH },
				sourceSize: { w: metas[i].width, h: metas[i].height },
			});
		}

		const absSavePath = resolveUserPath(input.save_to);
		await fs.mkdir(path.dirname(absSavePath), { recursive: true });

		// Create transparent canvas and composite all cells
		await sharp({
			create: {
				width: sheetW,
				height: sheetH,
				channels: 4,
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			},
		})
			.composite(compositeOps)
			.png()
			.toFile(absSavePath);

		const texts = [
			`Sprite sheet: ${input.images.length} images → ${input.save_to}`,
			`  Grid: ${cols}×${rows}, cell: ${cellW}×${cellH}, padding: ${pad}`,
			`  Sheet: ${sheetW}×${sheetH}`,
		];

		if (input.atlas_to) {
			const absAtlasPath = resolveUserPath(input.atlas_to);
			await fs.mkdir(path.dirname(absAtlasPath), { recursive: true });

			const atlas = {
				meta: {
					image: path.basename(input.save_to),
					size: { w: sheetW, h: sheetH },
					scale: 1,
				},
				frames,
			};
			await fs.writeFile(absAtlasPath, JSON.stringify(atlas, null, 2));
			texts.push(`  Atlas: ${input.atlas_to}`);
		}

		return {
			content: [{ type: "text" as const, text: texts.join("\n") }],
		};
	},
};
