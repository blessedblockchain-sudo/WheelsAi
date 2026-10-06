/**
 * Orchestration planning (W2) — turns a step list into an execution plan.
 *
 * Steps declare `dependsOn` (step NAMES), which makes a workflow a DAG
 * rather than a list. The plan is therefore a topological order grouped
 * into LEVELS: every step in a level has all its dependencies satisfied
 * by earlier levels, so a level can run concurrently while the order
 * between levels stays strict.
 *
 * `executionMode` chooses the concurrency policy over that same plan —
 * it never overrides dependencies, because a workflow that ran a step
 * before its input existed would produce confidently wrong output:
 *
 *   sequential / conditional / pipeline — one step at a time, in
 *     topological order. (`pipeline` additionally chains each step's
 *     output into the next when no explicit input mapping is given; that
 *     lives in the mapping layer.)
 *   parallel — each level runs concurrently, bounded by maxConcurrency.
 *
 * Cycles and unknown dependencies are HARD ERRORS at plan time, not
 * runtime surprises: a cycle would otherwise deadlock or silently drop
 * steps, and a typo'd dependency name would quietly reorder the workflow.
 */

export interface PlannableStep {
  id: string;
  name: string;
  stepOrder: number;
  dependsOn: string[];
}

export type ExecutionMode = "sequential" | "parallel" | "conditional" | "pipeline";

export interface OrchestrationPlan {
  /** Steps grouped by dependency level; each level may run together. */
  levels: PlannableStep[][];
  /** Max steps to run at once (1 for every non-parallel mode). */
  concurrency: number;
}

export class OrchestrationPlanError extends Error {}

export function planOrchestration(
  steps: PlannableStep[],
  mode: string,
  maxConcurrency: number,
): OrchestrationPlan {
  if (steps.length === 0) {
    throw new OrchestrationPlanError("orchestration has no steps");
  }

  const byName = new Map<string, PlannableStep>();
  for (const step of steps) {
    if (byName.has(step.name)) {
      throw new OrchestrationPlanError(`duplicate step name: ${step.name}`);
    }
    byName.set(step.name, step);
  }

  // A dependency naming a step that doesn't exist is a typo, and silently
  // ignoring it would run the step early against missing input.
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byName.has(dep)) {
        throw new OrchestrationPlanError(
          `step "${step.name}" depends on unknown step "${dep}"`,
        );
      }
      if (dep === step.name) {
        throw new OrchestrationPlanError(`step "${step.name}" depends on itself`);
      }
    }
  }

  // Kahn's algorithm, taking ready steps in stepOrder so a workflow with
  // no dependencies executes in the order the author wrote it.
  const remaining = new Map<string, Set<string>>();
  for (const step of steps) {
    remaining.set(step.name, new Set(step.dependsOn));
  }

  const levels: PlannableStep[][] = [];
  const done = new Set<string>();

  while (done.size < steps.length) {
    const ready = steps
      .filter((s) => !done.has(s.name) && remaining.get(s.name)!.size === 0)
      .sort((a, b) => a.stepOrder - b.stepOrder);

    if (ready.length === 0) {
      const stuck = steps
        .filter((s) => !done.has(s.name))
        .map((s) => s.name)
        .join(", ");
      throw new OrchestrationPlanError(
        `dependency cycle among steps: ${stuck}`,
      );
    }

    levels.push(ready);
    for (const step of ready) done.add(step.name);
    for (const set of remaining.values()) {
      for (const name of done) set.delete(name);
    }
  }

  const parallel = mode === "parallel";
  return {
    levels,
    concurrency: parallel ? Math.max(1, maxConcurrency) : 1,
  };
}

/** Flattened execution order — the sequence steps will be attempted in. */
export function planOrder(plan: OrchestrationPlan): PlannableStep[] {
  return plan.levels.flat();
}

/**
 * For each step, every step it transitively depends on. Assumes the
 * steps already planned (no cycles, no unknown dependencies).
 */
export function ancestorSets(steps: PlannableStep[]): Map<string, Set<string>> {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const ancestors = new Map<string, Set<string>>();

  const visit = (name: string): Set<string> => {
    const known = ancestors.get(name);
    if (known) return known;
    const set = new Set<string>();
    ancestors.set(name, set);
    for (const dep of byName.get(name)?.dependsOn ?? []) {
      set.add(dep);
      for (const inherited of visit(dep)) set.add(inherited);
    }
    return set;
  };

  for (const step of steps) visit(step.name);
  return ancestors;
}

export interface StepReferences {
  step: string;
  /** Names of the other steps this step reads output from. */
  references: string[];
}

export interface ReferenceViolation {
  step: string;
  reference: string;
  reason: "unknown_step" | "not_available";
  message: string;
}

/**
 * Checks that every step only reads output that is guaranteed to exist
 * when it runs.
 *
 * In `parallel` mode that means its transitive dependencies: steps in the
 * same level run together, and reading an unrelated earlier step would
 * work by accident of level layout and break when the graph is edited.
 * In the one-at-a-time modes it means any step earlier in the plan order.
 */
export function findReferenceViolations(
  steps: PlannableStep[],
  mode: string,
  plan: OrchestrationPlan,
  references: StepReferences[],
): ReferenceViolation[] {
  const known = new Set(steps.map((s) => s.name));
  const ancestors = ancestorSets(steps);
  const position = new Map(planOrder(plan).map((s, i) => [s.name, i]));
  const violations: ReferenceViolation[] = [];

  for (const { step, references: refs } of references) {
    for (const reference of refs) {
      if (!known.has(reference)) {
        violations.push({
          step,
          reference,
          reason: "unknown_step",
          message: `step "${step}" references unknown step "${reference}"`,
        });
        continue;
      }
      const available =
        mode === "parallel"
          ? ancestors.get(step)?.has(reference) === true
          : (position.get(reference) ?? Infinity) < (position.get(step) ?? -1);
      if (!available) {
        violations.push({
          step,
          reference,
          reason: "not_available",
          message:
            mode === "parallel"
              ? `step "${step}" reads the output of "${reference}" but does not depend on it; add it to dependsOn`
              : `step "${step}" reads the output of "${reference}", which runs after it`,
        });
      }
    }
  }
  return violations;
}
