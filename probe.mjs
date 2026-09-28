import { readFileSync } from "node:fs";
const { findOwnerInvocations: f } = await import(new URL(`file:///${process.argv[2]}`).href);
for (const c of readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean)) console.log(JSON.stringify(f(c)), c);
