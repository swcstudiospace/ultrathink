// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { applyEdit, isEmptyConfig, type JsonValue, type KeyedEdit, revertEdit } from "./edits.ts";

function json(key: string[], value: JsonValue): KeyedEdit {
	return { kind: "json", file: "settings.json", key, value };
}

function block(id: string, body: string): KeyedEdit {
	return { kind: "block", file: "config.toml", id, body };
}

describe("json edits", () => {
	test("create the file, the parents and the key", () => {
		const { text, record } = applyEdit(undefined, json(["hooks", "ultrathink"], { command: "ut" }));
		expect(JSON.parse(text)).toEqual({ hooks: { ultrathink: { command: "ut" } } });
		expect(text).toStartWith('{\n  "hooks": {\n    "ultrathink": {');
		expect(text).toEndWith("}\n");
		expect(record).toEqual({
			kind: "json",
			file: "settings.json",
			key: ["hooks", "ultrathink"],
			value: { command: "ut" },
			existing: 0,
		});
	});

	test("keep every other key, in order, and the file's indentation and final newline", () => {
		const tabbed = '{\n\t"theme": "dark",\n\t"hooks": {\n\t\t"gsd": 1\n\t}\n}\n';
		const out = applyEdit(tabbed, json(["hooks", "ut"], 2)).text;
		expect(out).toBe('{\n\t"theme": "dark",\n\t"hooks": {\n\t\t"gsd": 1,\n\t\t"ut": 2\n\t}\n}\n');
		const four = '{\n    "a": 1\n}';
		expect(applyEdit(four, json(["b"], 2)).text).toBe('{\n    "a": 1,\n    "b": 2\n}');
	});

	test("an existing key is replaced and put back by the revert", () => {
		const original = '{\n  "a": {\n    "b": 1\n  }\n}\n';
		const { text, record } = applyEdit(original, json(["a", "b"], { x: [1, 2] }));
		expect(record).toMatchObject({ previous: 1, existing: 2 });
		expect(revertEdit(text, record)).toBe(original);
	});

	test("a null previous value is a value", () => {
		const { text, record } = applyEdit('{"a":null}', json(["a"], 1));
		expect(record).toMatchObject({ previous: null, existing: 1 });
		expect(JSON.parse(revertEdit(text, record) ?? "")).toEqual({ a: null });
	});

	test("the revert removes the created key and the parents that edit created, nothing else", () => {
		const original = '{\n  "theme": "dark",\n  "hooks": {\n    "gsd": 1\n  }\n}\n';
		const added = applyEdit(original, json(["hooks", "ut", "nested", "deep"], true));
		expect(revertEdit(added.text, added.record)).toBe(original);

		const fresh = applyEdit(original, json(["plugins", "ut"], 1));
		expect(revertEdit(fresh.text, fresh.record)).toBe(original);
	});

	test("the revert keeps a created parent that gained other content", () => {
		const { text, record } = applyEdit("{}\n", json(["hooks", "ut"], 1));
		const shared = text.replace('"ut": 1', '"ut": 1,\n    "other": 2');
		expect(JSON.parse(revertEdit(shared, record) ?? "")).toEqual({ hooks: { other: 2 } });
	});

	test("the revert gives up when the value was changed, the key is gone or the file is not JSON", () => {
		const { text, record } = applyEdit("{}\n", json(["a", "b"], 1));
		expect(revertEdit(text.replace(": 1", ": 2"), record)).toBeUndefined();
		expect(revertEdit('{"a":{}}', record)).toBeUndefined();
		expect(revertEdit('{"a":5}', record)).toBeUndefined();
		expect(revertEdit("not json", record)).toBeUndefined();
	});

	test("values are compared structurally on revert", () => {
		const { text, record } = applyEdit("{}", json(["a"], { x: [1, { y: null }], z: "s" }));
		const reordered = '{"a":{"z":"s","x":[1,{"y":null}]}}';
		expect(JSON.parse(revertEdit(reordered, record) ?? "")).toEqual({});
		expect(revertEdit(text.replace('"s"', '"t"'), record)).toBeUndefined();
	});

	test("reject files and keys they cannot edit safely", () => {
		expect(() => applyEdit("// c\n{}\n", json(["a"], 1))).toThrow(
			"settings.json is not plain JSON",
		);
		expect(() => applyEdit("[]", json(["a"], 1))).toThrow("does not hold a JSON object");
		expect(() => applyEdit('{"a":1}', json(["a", "b"], 1))).toThrow(
			"a.b runs through a non-object",
		);
		expect(() => applyEdit("{}", json([], 1))).toThrow("non-empty path");
		expect(() => applyEdit("{}", json(["__proto__", "x"], 1))).toThrow("without __proto__");
	});

	test("an empty file counts as an empty object", () => {
		expect(JSON.parse(applyEdit("  \n", json(["a"], 1)).text)).toEqual({ a: 1 });
	});
});

describe("block edits", () => {
	const begin = "# BEGIN ultrathink-managed:hooks";
	const end = "# END ultrathink-managed:hooks";

	test("append a marked block to a new or existing file", () => {
		expect(applyEdit(undefined, block("hooks", "a = 1\n\n")).text).toBe(
			`${begin}\na = 1\n${end}\n`,
		);
		expect(applyEdit("x = 1\n", block("hooks", "a = 1")).text).toBe(
			`x = 1\n${begin}\na = 1\n${end}\n`,
		);
		expect(applyEdit("x = 1", block("hooks", "a = 1")).text).toBe(
			`x = 1\n${begin}\na = 1\n${end}\n`,
		);
	});

	test("replace the body of a block that is already there", () => {
		const first = applyEdit("top = 1\n", block("hooks", "a = 1")).text;
		const withTail = `${first}bottom = 2\n`;
		const second = applyEdit(withTail, block("hooks", "a = 2\nb = 3"));
		expect(second.text).toBe(`top = 1\n${begin}\na = 2\nb = 3\n${end}\nbottom = 2\n`);
		expect(applyEdit(second.text, block("hooks", "a = 2\nb = 3")).text).toBe(second.text);
	});

	test("the revert removes the block and nothing else", () => {
		const original = "top = 1\nbottom = 2\n";
		const { text, record } = applyEdit(original, block("hooks", "a = 1"));
		expect(record).toEqual({ kind: "block", file: "config.toml", id: "hooks" });
		expect(revertEdit(text, record)).toBe(original);
		const middle = text.replace("top = 1\n", "top = 1\nextra = 0\n");
		expect(revertEdit(middle, record)).toBe("top = 1\nextra = 0\nbottom = 2\n");
	});

	test("blocks with different ids live side by side", () => {
		const one = applyEdit(undefined, block("one", "1")).text;
		const both = applyEdit(one, block("two", "2"));
		expect(revertEdit(both.text, both.record)).toBe(one);
	});

	test("lines ending in CRLF are matched", () => {
		const text = `${begin}\r\na = 1\r\n${end}\r\nrest\r\n`;
		expect(revertEdit(text, { kind: "block", file: "c", id: "hooks" })).toBe("rest\r\n");
	});

	test("the revert gives up when the block is gone or broken", () => {
		const record = { kind: "block", file: "config.toml", id: "hooks" } as const;
		expect(revertEdit("nothing here\n", record)).toBeUndefined();
		expect(revertEdit(`${begin}\na = 1\n`, record)).toBeUndefined();
	});

	test("reject ids that are not kebab-case and a block without an end", () => {
		expect(() => applyEdit("", block("Bad Id", "x"))).toThrow('"Bad Id" is not a kebab-case id');
		expect(() => applyEdit(`${begin}\nx\n`, block("hooks", "y"))).toThrow(
			'block "hooks" has no END marker',
		);
	});
});

describe("isEmptyConfig", () => {
	test("is true for blank text and an empty JSON object", () => {
		for (const text of ["", " \n", "{}", "{}\n"]) {
			expect(isEmptyConfig(text)).toBe(true);
		}
		for (const text of ["a = 1", '{"a":1}', "# comment"]) expect(isEmptyConfig(text)).toBe(false);
	});
});
