// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { ToolCaller } from "./create.ts";

export interface Call {
	name: string;
	args: Record<string, unknown>;
}

/** An error as the relay and the MCP client surface it: a message, optionally an HTTP status and a retry hint. */
export function failure(message: string, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(message), extra);
}

export interface LinearRow {
	id: string;
	identifier: string;
	url: string;
	title: string;
	description: string;
}

/**
 * A Linear that remembers what it was asked to create. `afterCreate` runs once the row exists, so an error it returns is a
 * lost reply: the tracker has the row, the caller never sees the answer.
 */
export function statefulLinear(
	opts: {
		afterCreate?: (args: Record<string, unknown>, attempt: number) => Error | undefined;
		listError?: Error;
	} = {},
): ToolCaller & { calls: Call[]; rows: LinearRow[] } {
	const calls: Call[] = [];
	const rows: LinearRow[] = [];
	const attempts = new Map<string, number>();
	return {
		calls,
		rows,
		async call(name, args) {
			calls.push({ name, args });
			if (name === "list_issues") {
				if (opts.listError) throw opts.listError;
				return { issues: rows.map((row) => ({ ...row })) };
			}
			if (typeof args.id === "string") {
				const row = rows.find((entry) => entry.identifier === args.id);
				return { issue: { id: row?.id, identifier: args.id, url: row?.url } };
			}
			const number = rows.length + 1;
			const identifier = `ENG-${number}`;
			const row: LinearRow = {
				id: `uuid-${number}`,
				identifier,
				url: `https://linear.app/org/issue/${identifier}/slug`,
				title: String(args.title),
				description: String(args.description),
			};
			rows.push(row);
			const attempt = (attempts.get(row.title) ?? 0) + 1;
			attempts.set(row.title, attempt);
			const error = opts.afterCreate?.(args, attempt);
			if (error) throw error;
			return { issue: { id: row.id, identifier, url: row.url } };
		},
	};
}

export interface NotionRow {
	url: string;
	Level: string;
	Item: string;
	Step?: number;
	/** The relation as it was sent: a JSON array of page urls. */
	"Parent Item"?: string;
	graphId: string;
}

const SCHEMA_PROPERTIES = [
	"Item",
	"Level",
	"Graph ID",
	"Parent Item",
	"Linear URL",
	"Issue ID",
	"Step",
	"Thought",
];

/**
 * A Notion that remembers the pages it was asked to create and answers the Graph ID query from them. `persist` keeps only
 * the first N pages of a call that then fails with `lose` (a lost reply is `lose` with the default `persist`); `refuse`
 * fails a create before it made anything.
 */
export function statefulNotion(
	opts: {
		lose?: (call: number) => Error | undefined;
		persist?: (call: number) => number | undefined;
		refuse?: (
			call: number,
			pages: Array<{ properties: Record<string, unknown> }>,
		) => Error | undefined;
		queryError?: Error;
	} = {},
): ToolCaller & { calls: Call[]; rows: NotionRow[] } {
	const calls: Call[] = [];
	const rows: NotionRow[] = [];
	let creates = 0;
	return {
		calls,
		rows,
		async call(name, args) {
			calls.push({ name, args });
			if (name === "notion-fetch") {
				const schema = Object.fromEntries(SCHEMA_PROPERTIES.map((p) => [p, { type: "text" }]));
				return `<data-source>${JSON.stringify({ schema })}</data-source>`;
			}
			if (name === "notion-query-data-sources") {
				if (opts.queryError) throw opts.queryError;
				const params = ((args.data as { params?: unknown[] } | undefined)?.params ??
					[]) as string[];
				return {
					results: rows.filter((row) => row.graphId === params[0]).map((row) => ({ ...row })),
				};
			}
			creates++;
			const pages = args.pages as Array<{ properties: Record<string, unknown> }>;
			const refused = opts.refuse?.(creates, pages);
			if (refused) throw refused;
			const keep = opts.persist?.(creates) ?? pages.length;
			const urls: string[] = [];
			for (const page of pages.slice(0, keep)) {
				const url = `https://www.notion.so/row-${rows.length + 1}`;
				const parent = page.properties["Parent Item"];
				rows.push({
					url,
					Level: String(page.properties.Level),
					Item: String(page.properties.Item),
					...(page.properties.Step === undefined ? {} : { Step: Number(page.properties.Step) }),
					...(parent === undefined ? {} : { "Parent Item": String(parent) }),
					graphId: String(page.properties["Graph ID"]),
				});
				urls.push(url);
			}
			const error = opts.lose?.(creates);
			if (error) throw error;
			return { pages: urls.map((url) => ({ url })) };
		},
	};
}
