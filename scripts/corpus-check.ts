// One-off: run checkPlanSet over every real PLAN.md under .planning/phases
// and print acceptance vs rejection, to confirm n3 labels.
import { checkPlanSet } from "./plan-check.ts";

const proc = Bun.spawnSync(["find", ".planning/phases", "-name", "*-PLAN.md"]);
const files = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean).sort();
for (const f of files) {
	const md = await Bun.file(f).text();
	const r = checkPlanSet(md);
	console.log(`${r.ok ? "PASS" : "FAIL"} ${f} ${r.ok ? "" : `( ${r.reason.slice(0, 60)} )`}`);
}
