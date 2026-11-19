import { readFileSync } from "node:fs";

/** Reads a JSON file and parses it. A file that is not valid JSON fails with its path in the message. */
export function parseJsonFile(source: string): unknown {
	const text = readFileSync(source, "utf8");
	try {
		return JSON.parse(text);
	} catch {
		throw new SyntaxError(`${source}: not valid JSON`);
	}
}
