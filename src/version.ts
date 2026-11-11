// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: this file sits one level below it, in `src/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `git describe` of the checkout, or undefined when git fails or prints nothing. */
function gitDescribe(): string | undefined {
	try {
		const out = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

/** The release followed by a plus sign and the trimmed stamp; the release alone when the stamp is empty. */
export function stampedVersion(
	release: string,
	stamp: () => string | undefined = gitDescribe,
): string {
	const text = stamp()?.trim();
	return text ? `${release}+${text}` : release;
}
