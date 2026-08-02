import { prisma } from "@wheelsai/db";

import { buildProductionExecutorDeps } from "./scheduledTaskExecutorProduction.js";

// ============================================
// Types
// ============================================

export type AssertionType =
  | "exact"
  | "contains"
  | "regex"
  | "semantic"
  | "json_schema"
  | "function";

export type TestStatus = "passed" | "failed" | "skipped" | "error";
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface CreateTestSuiteInput {
  agentId: string;
  name: string;
  description?: string;
  timeout?: number;
  retries?: number;
  parallel?: boolean;
  tags?: string[];
}

export interface CreateTestCaseInput {
  name: string;
  description?: string;
  inputType: "message" | "conversation" | "api";
  input: any;
  assertionType: AssertionType;
  expected: any;
  tolerance?: number;
  priority?: number;
  tags?: string[];
  customScript?: string;
}

export interface AssertionResult {
  passed: boolean;
  details: string;
  score?: number;
}

// ============================================
// Test Suite CRUD
// ============================================

export async function createTestSuite(orgId: string, input: CreateTestSuiteInput) {
  return prisma.testSuite.create({
    data: {
      orgId,
      agentId: input.agentId,
      name: input.name,
      description: input.description,
      timeout: input.timeout ?? 30000,
      retries: input.retries ?? 0,
      parallel: input.parallel ?? false,
      tags: input.tags ?? [],
    },
  });
}

export async function getTestSuites(
  orgId: string,
  options: {
    agentId?: string;
    limit?: number;
    offset?: number;
  } = {}
) {
  const { agentId, limit = 20, offset = 0 } = options;

  const where: any = { orgId };
  if (agentId) where.agentId = agentId;

  const [suites, total] = await Promise.all([
    prisma.testSuite.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        _count: { select: { testCases: true, testRuns: true } },
      },
    }),
    prisma.testSuite.count({ where }),
  ]);

  return { suites, total };
}

export async function getTestSuite(orgId: string, suiteId: string) {
  return prisma.testSuite.findFirst({
    where: { id: suiteId, orgId },
    include: {
      testCases: {
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      },
      testRuns: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });
}

export async function updateTestSuite(
  orgId: string,
  suiteId: string,
  updates: Partial<CreateTestSuiteInput>
) {
  return prisma.testSuite.update({
    where: { id: suiteId },
    data: {
      name: updates.name,
      description: updates.description,
      timeout: updates.timeout,
      retries: updates.retries,
      parallel: updates.parallel,
      tags: updates.tags,
    },
  });
}

export async function deleteTestSuite(orgId: string, suiteId: string) {
  return prisma.testSuite.delete({
    where: { id: suiteId },
  });
}

// ============================================
// Test Case CRUD
// ============================================

export async function createTestCase(
  orgId: string,
  suiteId: string,
  input: CreateTestCaseInput
) {
  // Verify suite belongs to org
  const suite = await prisma.testSuite.findFirst({
    where: { id: suiteId, orgId },
  });

  if (!suite) {
    throw new Error("Test suite not found");
  }

  const testCase = await prisma.testCase.create({
    data: {
      suiteId,
      name: input.name,
      description: input.description,
      inputType: input.inputType,
      input: input.input,
      assertionType: input.assertionType,
      expected: input.expected,
      tolerance: input.tolerance,
      priority: input.priority ?? 0,
      tags: input.tags ?? [],
      customScript: input.customScript,
    },
  });

  // Update suite test count
  await prisma.testSuite.update({
    where: { id: suiteId },
    data: { totalTests: { increment: 1 } },
  });

  return testCase;
}

export async function getTestCases(orgId: string, suiteId: string) {
  // Verify suite belongs to org
  const suite = await prisma.testSuite.findFirst({
    where: { id: suiteId, orgId },
  });

  if (!suite) {
    throw new Error("Test suite not found");
  }

  return prisma.testCase.findMany({
    where: { suiteId },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
}

export async function updateTestCase(
  orgId: string,
  suiteId: string,
  testCaseId: string,
  updates: Partial<CreateTestCaseInput>
) {
  // Verify suite belongs to org
  const suite = await prisma.testSuite.findFirst({
    where: { id: suiteId, orgId },
  });

  if (!suite) {
    throw new Error("Test suite not found");
  }

  return prisma.testCase.update({
    where: { id: testCaseId },
    data: {
      name: updates.name,
      description: updates.description,
      inputType: updates.inputType,
      input: updates.input,
      assertionType: updates.assertionType,
      expected: updates.expected,
      tolerance: updates.tolerance,
      priority: updates.priority,
      tags: updates.tags,
      customScript: updates.customScript,
    },
  });
}

export async function deleteTestCase(orgId: string, suiteId: string, testCaseId: string) {
  // Verify suite belongs to org
  const suite = await prisma.testSuite.findFirst({
    where: { id: suiteId, orgId },
  });

  if (!suite) {
    throw new Error("Test suite not found");
  }

  await prisma.testCase.delete({
    where: { id: testCaseId },
  });

  // Update suite test count
  await prisma.testSuite.update({
    where: { id: suiteId },
    data: { totalTests: { decrement: 1 } },
  });
}

export async function toggleTestCase(
  orgId: string,
  suiteId: string,
  testCaseId: string,
  isEnabled: boolean
) {
  const suite = await prisma.testSuite.findFirst({
    where: { id: suiteId, orgId },
  });

  if (!suite) {
    throw new Error("Test suite not found");
  }

  return prisma.testCase.update({
    where: { id: testCaseId },
    data: { isEnabled },
  });
}

// ============================================
// Test Execution
// ============================================

export async function runTestSuite(
  orgId: string,
  suiteId: string,
  options: {
    deploymentId?: string;
    triggeredBy?: string;
    triggeredById?: string;
  } = {}
) {
  // Get suite with test cases
  const suite = await prisma.testSuite.findFirst({
    where: { id: suiteId, orgId, isEnabled: true },
    include: {
      testCases: {
        where: { isEnabled: true },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      },
    },
  });

  if (!suite) {
    throw new Error("Test suite not found");
  }

  if (suite.testCases.length === 0) {
    throw new Error("No test cases to run");
  }

  // Get agent version
  const agent = await prisma.agent.findUnique({
    where: { id: suite.agentId },
    select: { version: true },
  });

  // Create test run
  const testRun = await prisma.testRun.create({
    data: {
      suiteId,
      agentVersion: agent?.version,
      deploymentId: options.deploymentId,
      status: "pending",
      totalTests: suite.testCases.length,
      triggeredBy: options.triggeredBy ?? "manual",
      triggeredById: options.triggeredById,
    },
  });

  // Execute tests asynchronously
  executeTests(testRun.id, orgId, suite, options.deploymentId).catch((err) => {
    console.error("Test execution failed:", err);
  });

  return testRun;
}

async function executeTests(
  runId: string,
  orgId: string,
  suite: {
    id: string;
    agentId: string;
    timeout: number;
    retries: number;
    parallel: boolean;
    testCases: any[];
  },
  deploymentId?: string
) {
  // Mark as running
  await prisma.testRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date() },
  });

  const results: { status: TestStatus; durationMs: number }[] = [];
  const startTime = Date.now();

  try {
    // Get deployment endpoint if provided
    let endpoint: string | null = null;
    if (deploymentId) {
      const deployment = await prisma.agentDeployment.findUnique({
        where: { id: deploymentId },
        select: { endpoint: true },
      });
      endpoint = deployment?.endpoint || null;
    }

    // One invoker for the whole run: the deployed endpoint when the run
    // targets a deployment, otherwise the agent's own model.
    const invoke = (inputType: string, input: any, timeout: number) =>
      endpoint
        ? callAgentViaEndpoint(inputType, input, endpoint, timeout)
        : callAgentViaModel(suite.agentId, orgId, inputType, input);

    // Execute tests
    if (suite.parallel) {
      // Run in parallel
      const promises = suite.testCases.map((testCase) =>
        executeTestCase(runId, testCase, suite.timeout, suite.retries, invoke)
      );
      const parallelResults = await Promise.all(promises);
      results.push(...parallelResults);
    } else {
      // Run sequentially
      for (const testCase of suite.testCases) {
        const result = await executeTestCase(
          runId,
          testCase,
          suite.timeout,
          suite.retries,
          invoke
        );
        results.push(result);

        // Update progress
        const progress = Math.round(
          ((results.length / suite.testCases.length) * 100)
        );
        await prisma.testRun.update({
          where: { id: runId },
          data: { progress },
        });
      }
    }

    // Calculate summary
    const passed = results.filter((r) => r.status === "passed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const passRate = (passed / results.length) * 100;
    const totalDurationMs = Date.now() - startTime;

    // Update run
    await prisma.testRun.update({
      where: { id: runId },
      data: {
        status: "completed",
        progress: 100,
        passedTests: passed,
        failedTests: failed,
        skippedTests: skipped,
        passRate,
        totalDurationMs,
        completedAt: new Date(),
      },
    });

    // Update suite stats
    const status = failed === 0 ? "passed" : passed === 0 ? "failed" : "partial";
    await prisma.testSuite.update({
      where: { id: suite.id },
      data: {
        lastRunAt: new Date(),
        lastStatus: status,
        passRate,
      },
    });
  } catch (error: any) {
    await prisma.testRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

async function executeTestCase(
  runId: string,
  testCase: {
    id: string;
    name: string;
    inputType: string;
    input: any;
    assertionType: string;
    expected: any;
    tolerance: number | null;
    customScript: string | null;
  },
  timeout: number,
  maxRetries: number,
  invoke: (inputType: string, input: any, timeout: number) => Promise<any>
): Promise<{ status: TestStatus; durationMs: number }> {
  let attempt = 1;
  let lastError: string | null = null;

  while (attempt <= maxRetries + 1) {
    const startTime = Date.now();

    try {
      // Execute the test
      const actualOutput = await invoke(
        testCase.inputType,
        testCase.input,
        timeout
      );

      // Run assertion
      const assertionResult = await runAssertion(
        testCase.assertionType as AssertionType,
        actualOutput,
        testCase.expected,
        testCase.tolerance,
        testCase.customScript
      );

      const durationMs = Date.now() - startTime;
      const status: TestStatus = assertionResult.passed ? "passed" : "failed";

      // Save result
      await prisma.testResult.create({
        data: {
          runId,
          testCaseId: testCase.id,
          status,
          durationMs,
          actualOutput,
          assertionResult: assertionResult as any,
          attempt,
        },
      });

      return { status, durationMs };
    } catch (error: any) {
      lastError = error.message;
      attempt++;

      if (attempt > maxRetries + 1) {
        const durationMs = Date.now() - startTime;

        // Save error result
        await prisma.testResult.create({
          data: {
            runId,
            testCaseId: testCase.id,
            status: "error",
            durationMs,
            error: lastError,
            attempt: attempt - 1,
          },
        });

        return { status: "error", durationMs };
      }
    }
  }

  return { status: "error", durationMs: 0 };
}

/**
 * Invoke the agent under test (Wave 1 — this used to return a hardcoded
 * "This is a simulated response for testing purposes.", so every suite
 * graded a constant and the pass rates were fiction).
 *
 * Two real paths, in preference order:
 *   1. A deployment endpoint → proxy the OpenAI-compatible route at
 *      temperature 0 (deterministic, tests the deployed artifact).
 *   2. No deployment → invoke the agent's configured model through the
 *      SAME executor the scheduler and playground use. Suites are
 *      useful before a GPU deployment exists, and the path is shared,
 *      so "tested" and "run" mean the same thing.
 */
async function callAgentViaEndpoint(
  inputType: string,
  input: any,
  endpoint: string,
  timeout: number
): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: inputType === "message" ? [{ role: "user", content: input }] : input,
        temperature: 0, // Deterministic for testing
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Agent returned ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message || data;
  } catch (error: any) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function callAgentViaModel(
  agentId: string,
  orgId: string,
  inputType: string,
  input: any
): Promise<any> {
  const deps = buildProductionExecutorDeps();
  const agent = await deps.loadAgent(agentId, orgId);
  if (!agent) {
    throw new Error(`agent ${agentId} not found for test run`);
  }
  const prompt =
    inputType === "message"
      ? typeof input === "string"
        ? input
        : JSON.stringify(input)
      : // conversation input: use the last user turn as the prompt
        Array.isArray(input)
        ? String(
            [...input].reverse().find((m) => m?.role === "user")?.content ??
              JSON.stringify(input),
          )
        : JSON.stringify(input);

  const result = await deps.runAgentChat({ agent, prompt });
  return { role: "assistant", content: result.content };
}

export async function runAssertion(
  assertionType: AssertionType,
  actual: any,
  expected: any,
  tolerance: number | null,
  customScript: string | null
): Promise<AssertionResult> {
  const actualContent =
    typeof actual === "string" ? actual : actual?.content || JSON.stringify(actual);
  const expectedContent =
    typeof expected === "string" ? expected : expected?.content || JSON.stringify(expected);

  switch (assertionType) {
    case "exact":
      return {
        passed: actualContent === expectedContent,
        details:
          actualContent === expectedContent
            ? "Output matches exactly"
            : `Expected "${expectedContent}" but got "${actualContent}"`,
      };

    case "contains": {
      const contains = actualContent.toLowerCase().includes(expectedContent.toLowerCase());
      return {
        passed: contains,
        details: contains
          ? `Output contains "${expectedContent}"`
          : `Output does not contain "${expectedContent}"`,
      };
    }

    case "regex":
      try {
        const regex = new RegExp(expectedContent, "i");
        const matches = regex.test(actualContent);
        return {
          passed: matches,
          details: matches
            ? `Output matches pattern /${expectedContent}/`
            : `Output does not match pattern /${expectedContent}/`,
        };
      } catch {
        return {
          passed: false,
          details: `Invalid regex pattern: ${expectedContent}`,
        };
      }

    case "semantic": {
      // Honest labeling: this is Jaccard WORD OVERLAP, not embedding
      // similarity — calling it "semantic" in the result overclaimed.
      // True semantic scoring arrives with the embeddings build (RAG,
      // Wave 2); until then the details say what was actually measured.
      const words1 = new Set(actualContent.toLowerCase().split(/\s+/));
      const words2 = new Set(expectedContent.toLowerCase().split(/\s+/));
      const intersection = new Set([...words1].filter((x) => words2.has(x)));
      const union = new Set([...words1, ...words2]);
      const similarity = union.size === 0 ? 0 : intersection.size / union.size;
      const threshold = tolerance ?? 0.5;

      return {
        passed: similarity >= threshold,
        details: `Word-overlap similarity: ${(similarity * 100).toFixed(1)}% (threshold: ${threshold * 100}%; embedding-based semantic scoring not yet available)`,
        score: similarity,
      };
    }

    case "json_schema":
      try {
        const actualJson =
          typeof actual === "string" ? JSON.parse(actual) : actual;
        // Basic schema validation
        const hasRequiredFields = Object.keys(expected).every(
          (key) => key in actualJson
        );
        return {
          passed: hasRequiredFields,
          details: hasRequiredFields
            ? "Output matches schema"
            : "Output missing required fields",
        };
      } catch {
        return {
          passed: false,
          details: "Output is not valid JSON",
        };
      }

    case "function":
      // SECURITY: the previous implementation ran user-supplied script
      // via new Function() directly in the API process — arbitrary code
      // execution for any org user, with access to env, Prisma, and the
      // wallet keys. Custom assertions stay disabled until a real
      // isolate exists; failing closed with a clear reason beats an RCE
      // dressed up as a feature. (The old comment claimed "sandboxed in
      // production" — it never was.)
      void customScript;
      return {
        passed: false,
        details:
          "Custom function assertions are disabled: they require a sandboxed runtime that does not exist yet. Use exact, contains, regex, or json_schema.",
      };

    default:
      return {
        passed: false,
        details: `Unknown assertion type: ${assertionType}`,
      };
  }
}

// ============================================
// Test Run Management
// ============================================

export async function getTestRuns(
  orgId: string,
  suiteId: string,
  options: {
    limit?: number;
    offset?: number;
    status?: string;
  } = {}
) {
  const { limit = 20, offset = 0, status } = options;

  // Verify suite belongs to org
  const suite = await prisma.testSuite.findFirst({
    where: { id: suiteId, orgId },
  });

  if (!suite) {
    throw new Error("Test suite not found");
  }

  const where: any = { suiteId };
  if (status) where.status = status;

  const [runs, total] = await Promise.all([
    prisma.testRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.testRun.count({ where }),
  ]);

  return { runs, total };
}

export async function getTestRun(orgId: string, suiteId: string, runId: string) {
  // Verify suite belongs to org
  const suite = await prisma.testSuite.findFirst({
    where: { id: suiteId, orgId },
  });

  if (!suite) {
    throw new Error("Test suite not found");
  }

  return prisma.testRun.findFirst({
    where: { id: runId, suiteId },
    include: {
      results: {
        include: {
          testCase: {
            select: { name: true, description: true },
          },
        },
      },
    },
  });
}

export async function cancelTestRun(orgId: string, suiteId: string, runId: string) {
  // Verify suite belongs to org
  const suite = await prisma.testSuite.findFirst({
    where: { id: suiteId, orgId },
  });

  if (!suite) {
    throw new Error("Test suite not found");
  }

  return prisma.testRun.update({
    where: { id: runId },
    data: {
      status: "cancelled",
      completedAt: new Date(),
    },
  });
}

// ============================================
// Stats
// ============================================

export async function getTestStats(orgId: string, agentId?: string) {
  const where: any = { orgId };
  if (agentId) where.agentId = agentId;

  const suites = await prisma.testSuite.findMany({
    where,
    select: {
      id: true,
      name: true,
      totalTests: true,
      lastRunAt: true,
      lastStatus: true,
      passRate: true,
    },
  });

  const recentRuns = await prisma.testRun.findMany({
    where: { suite: { orgId, ...(agentId ? { agentId } : {}) } },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      suite: { select: { name: true } },
    },
  });

  const totalTests = suites.reduce((sum, s) => sum + s.totalTests, 0);
  const avgPassRate =
    suites.length > 0
      ? suites.reduce((sum, s) => sum + (s.passRate || 0), 0) / suites.length
      : 0;

  return {
    totalSuites: suites.length,
    totalTests,
    avgPassRate,
    recentRuns,
  };
}
