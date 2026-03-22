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
	resize: z
		.object({
			width: z
				.number()
				.int()
				.positive()
				.describe("Target width in pixels."),
			height: z
				.number()
				.int()
				.positive()
				.describe("Target height in pixels."),
		})
		.optional()
		.describe(
			"Optional resize dimensions. Image is resized to fit within these bounds, preserving aspect ratio.",
		),
	format: z
		.enum(["png", "jpeg", "webp"])
		.default("png")
		.describe("Output format for the base64 data URI."),
});

export type ImageToBase64Input = z.infer<typeof InputSchema>;

const MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

export const imageToBase64Tool = {
	name: "image_to_base64",
	description: `Convert an image file to a base64 data URI string. Optionally resize the image first.

Returns a data URI like "data:image/png;base64,..." that can be embedded directly in HTML, CSS, or source code.`,
	inputSchema: InputSchema,

	async execute(input: ImageToBase64Input) {
		const absPath = resolveUserPath(input.file_path);

		let pipeline = sharp(absPath);

		if (input.resize) {
			pipeline = pipeline.resize(
				input.resize.width,
				input.resize.height,
				{
					fit: "inside",
					withoutEnlargement: false,
				},
			);
		}

		switch (input.format) {
			case "jpeg":
				pipeline = pipeline.jpeg({ quality: 90 });
				break;
			case "webp":
				pipeline = pipeline.webp({ quality: 90 });
				break;
			case "png":
			default:
				pipeline = pipeline.png();
				break;
		}

		const buffer = await pipeline.toBuffer();
		const base64 = buffer.toString("base64");
		const mimeType = MIME_TYPES[input.format] ?? "image/png";
		const dataUri = `data:${mimeType};base64,${base64}`;

		const metadata = await sharp(absPath).metadata();

		return {
			content: [
				{
					type: "text" as const,
					text: [
						`Converted: ${input.file_path}`,
						`  Original: ${metadata.width}×${metadata.height} ${metadata.format}`,
						input.resize
							? `  Resized to fit: ${input.resize.width}×${input.resize.height}`
							: "  No resize applied",
						`  Output format: ${input.format}`,
						`  Base64 size: ${(base64.length / 1024).toFixed(1)} KB`,
						`  Data URI length: ${dataUri.length} chars`,
						"",
						"Data URI:",
						dataUri,
					].join("\n"),
				},
			],
		};
	},
};
