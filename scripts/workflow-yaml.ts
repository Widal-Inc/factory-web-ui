// A workflow file as the workflow tests read it (scripts/*-workflow.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; "working-directory"?: string; env?: Record<string, string>; with?: Record<string, string> }
export interface Job { needs?: string | string[]; if?: string; env?: Record<string, string>; "runs-on"?: unknown; environment?: string | { name: string; url?: string }; permissions?: Record<string, string>; outputs?: Record<string, string>; "timeout-minutes"?: number; uses?: string; steps?: Step[] }
export interface Workflow { on: Record<string, unknown>; env?: Record<string, string>; permissions?: Record<string, string>; jobs: Record<string, Job> }

export const root = join(dirname(new URL(import.meta.url).pathname), "..");
export const parseWorkflow = (path: string): Workflow => Bun.YAML.parse(readFileSync(path, "utf8")) as Workflow;
