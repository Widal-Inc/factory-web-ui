import { availableParallelism } from "node:os";

export {};

// Native TypeScript uses Go's GC. Trade RAM for CPU: no proportional collection, only a
// memory limit (a check peaks near 1.7 GiB, so it rarely collects; 12 runs measured 14% less
// CPU than GOGC=400). Bound its scheduler width on large hosts. Caller settings stay in force.
const env = {
  ...process.env,
  GOGC: process.env["GOGC"] ?? "off",
  GOMEMLIMIT: process.env["GOMEMLIMIT"] ?? "8GiB",
  GOMAXPROCS: process.env["GOMAXPROCS"] ?? String(Math.min(32, availableParallelism())),
};

for (const args of [[], ["-p", "tsconfig.tools.json"]]) {
  const child = Bun.spawn([process.execPath, "--bun", "tsc", "--noEmit", ...args], {
    env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
