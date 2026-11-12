import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionSnapshot, WorktreeListing, WorktreeOpened } from "../../shared/protocol.ts";
import { ApiError, routeMissing } from "./api.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { publishBranches } from "./paneBranch.ts";
import { usePageVisible } from "./visibility.ts";
import { inventoryReads, WorkspaceBranchCache, worktreeRepositories, worktreeWorkspaceSignature, type WorkspaceBranch } from "./worktreeBranches.ts";

const BRANCH_POLL_MS = 30_000;
const NONE: ReadonlySet<string> = new Set();

/** Use the existing worktree API; pane status updates never trigger a git inventory poll. */
/** `roster`: this reader is the PC's roster, whose branches the panes' composers name too (lib/paneBranch.ts). */
/** `unmarked`: git workspaces herdr has not marked as a repository's (no `worktree`), read one by one. */
/** `onNotCheckout`: herdr answered that an unmarked workspace is no git checkout, so whoever chose it can stop asking (#2726). */
export function useWorktreeBranches(snapshot: SessionSnapshot | null, online: boolean, roster = false, unmarked: ReadonlySet<string> = NONE, onNotCheckout?: (workspaceId: string) => void): {
  branches: ReadonlyMap<string, WorkspaceBranch>;
  rememberOpened(opened: WorktreeOpened): void;
} {
  const machineId = useMachineId();
  const { listWorktrees, readWorktreeInventory } = useMachineApi();
  const visible = usePageVisible();
  // `oneByOne`: the PC's bridge is from before GET /api/worktree/inventory, so each workspace is asked alone (#2661).
  // `turn`: each poll starts the inventory one workspace further on, so a herdr too slow to answer them all
  // within the PC's budget (server/workspace-routes.ts) still reaches every workspace in turn
  const owner = useMemo(() => ({ cache: new WorkspaceBranchCache(), pending: null as Promise<void> | null, oneByOne: false, turn: 0 }), [machineId]);
  const [, publish] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const workspaces = snapshot?.workspaces ?? [];
  const signature = worktreeWorkspaceSignature(workspaces);
  const unmarkedKey = [...unmarked].sort().join("\n");

  useEffect(() => {
    owner.cache.reconcile(workspaces);
    const repositories = worktreeRepositories(workspaces);
    const unmarkedIds = unmarkedKey === "" ? [] : unmarkedKey.split("\n");
    if (!online || !visible || (repositories.length === 0 && unmarkedIds.length === 0)) {
      owner.cache.invalidate();
      // a PC comes back from an update offline first: its new bridge may answer the inventory
      if (!online) owner.oneByOne = false;
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      // A create or structural change may restart this effect while its previous RPC awaits.
      // Wait for that same-PC cycle to finish before opening another inventory connection.
      if (owner.pending) await owner.pending;
      if (stopped) return;
      const generation = owner.cache.generation;
      const cycle = (async () => {
        let changed = false;
        // every workspace of the PC in one request (a few for very many), answered as each list would have been
        const answered = new Map<string, WorktreeListing | ApiError>();
        // a read that failed: the workspaces it left unanswered keep their last known branch until the next poll
        let unanswered = false;
        const asked = [...repositories.map((repository) => repository.workspaceId), ...unmarkedIds];
        const start = owner.turn++ % asked.length;
        for (const read of owner.oneByOne ? [] : inventoryReads([...asked.slice(start), ...asked.slice(0, start)])) {
          if (stopped || generation !== owner.cache.generation) return;
          try {
            const inventory = await readWorktreeInventory(read);
            for (const entry of inventory.entries) {
              answered.set(entry.workspace_id, "listing" in entry ? entry.listing
                : new ApiError("worktree/list", entry.error.status, entry.error.message, entry.error.code));
            }
          } catch (error) {
            // an answer the PC gave before it went offline says nothing of the bridge it comes back with
            if (routeMissing(error)) { if (!stopped) owner.oneByOne = true; break; }
            unanswered = true;
            break;
          }
        }
        const listingOf = async (workspaceId: string): Promise<WorktreeListing | null> => {
          const answer = answered.get(workspaceId);
          if (answer instanceof ApiError) throw answer;
          return answer ?? (unanswered ? null : await listWorktrees(workspaceId));
        };
        for (const repository of repositories) {
          if (stopped || generation !== owner.cache.generation) break;
          try {
            const listing = await listingOf(repository.workspaceId);
            if (listing && !stopped) changed = owner.cache.applyListing(repository.repoKey, listing, generation) || changed;
          } catch {
            // Retain a last known branch only while its exact checkout still exists.
          }
        }
        for (const workspaceId of unmarkedIds) {
          if (stopped || generation !== owner.cache.generation) break;
          try {
            const listing = await listingOf(workspaceId);
            if (listing && !stopped) changed = owner.cache.applyUnmarked(workspaceId, listing, generation) || changed;
          } catch (error) {
            // a refusal (4xx) says it is no checkout now; a failure to ask keeps the last known branch
            if (!stopped && error instanceof ApiError && error.status < 500) {
              changed = owner.cache.forgetUnmarked(workspaceId, generation) || changed;
              // only this cycle's git refusal says so: herdr's dropped connections are 404s too (server/http.ts)
              if (generation === owner.cache.generation && error.code === "not_git_worktree") onNotCheckout?.(workspaceId);
            }
          }
        }
        if (!stopped && changed) publish((value) => value + 1);
      })();
      owner.pending = cycle;
      await cycle;
      if (owner.pending === cycle) owner.pending = null;
      if (!stopped) timer = setTimeout(() => void poll(), BRANCH_POLL_MS);
    }

    void poll();
    return () => {
      stopped = true;
      owner.cache.invalidate();
      clearTimeout(timer);
    };
  }, [owner, listWorktrees, readWorktreeInventory, signature, unmarkedKey, online, visible, refresh, onNotCheckout]);

  const rememberOpened = useCallback((opened: WorktreeOpened): void => {
    owner.cache.rememberOpened(opened);
    setRefresh((value) => value + 1);
  }, [owner]);

  const branches = owner.cache.branchesFor(workspaces, unmarked);
  useEffect(() => { if (roster) publishBranches(machineId, branches); });
  useEffect(() => roster ? () => publishBranches(machineId, null) : undefined, [roster, machineId]);

  return { branches, rememberOpened };
}
