import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, relative, resolve, sep } from "path";
import type { GeneratedFile } from "./types";

export function toJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function assertSafeRelativePath(path: string): void {
	if (!path || path.startsWith("/") || path.includes("\0")) {
		throw new Error(`Unsafe generated path: ${path}`);
	}

	const parts = path.split(/[\\/]+/);
	if (parts.includes("..") || parts.includes("")) {
		throw new Error(`Unsafe generated path: ${path}`);
	}
}

export function resolveGeneratedPath(root: string, filePath: string): string {
	assertSafeRelativePath(filePath);
	const absoluteRoot = resolve(root);
	const absolutePath = resolve(absoluteRoot, filePath);
	const relation = relative(absoluteRoot, absolutePath);

	if (relation.startsWith("..") || relation === ".." || relation.includes(`..${sep}`)) {
		throw new Error(`Generated path escapes project root: ${filePath}`);
	}

	return absolutePath;
}

export async function writeGeneratedFiles(
	root: string,
	files: GeneratedFile[],
): Promise<void> {
	if (existsSync(root)) {
		throw new Error(`Directory already exists: ${root}`);
	}

	await mkdir(root, { recursive: true });

	for (const file of files) {
		const target = resolveGeneratedPath(root, file.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.contents);
	}
}

export function listGeneratedFiles(files: GeneratedFile[]): string[] {
	return files.map((file) => file.path).sort((a, b) => a.localeCompare(b));
}
