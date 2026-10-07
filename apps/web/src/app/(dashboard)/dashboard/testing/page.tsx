"use client";

import { useState, useEffect } from "react";
import { Beaker, ListChecks } from "lucide-react";
import {
  testingApi,
  agentsApi,
  TestSuite,
  TestRun,
  TestCase,
  Agent,
  getErrorMessage,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

// Icons
function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m9 11 3 3L22 4" />
    </svg>
  );
}

function XCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

/** Mirrors the page layout: header, four stat cards, suite list. */
function TestingPageSkeleton() {
  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8" aria-busy="true">
      <div className="space-y-3">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border rounded-lg p-4 space-y-2">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>

      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-10 w-32" />
        </div>
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-5 w-48 max-w-full" />
                    <Skeleton className="h-5 w-14" />
                  </div>
                  <Skeleton className="h-4 w-2/3" />
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Skeleton className="h-9 w-16" />
                  <Skeleton className="h-9 w-16" />
                  <Skeleton className="h-9 w-10" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only">Loading test suites</span>
    </div>
  );
}

export default function TestingPage() {
  const confirmAction = useConfirm();
  const [suites, setSuites] = useState<TestSuite[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stats, setStats] = useState<{
    totalSuites: number;
    totalTests: number;
    avgPassRate: number;
    recentRuns: any[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedSuite, setSelectedSuite] = useState<TestSuite | null>(null);

  // Test-case authoring (Wave 1): the suite detail panel had no way to
  // create cases, so "Run" was permanently disabled on every suite.
  const [cases, setCases] = useState<TestCase[]>([]);
  const [loadingCases, setLoadingCases] = useState(false);
  const [casesError, setCasesError] = useState<unknown>(null);
  const [savingCase, setSavingCase] = useState(false);
  const [caseForm, setCaseForm] = useState({
    name: "",
    input: "",
    assertionType: "contains" as TestCase["assertionType"],
    expected: "",
  });

  // Form state
  const [form, setForm] = useState({
    agentId: "",
    name: "",
    description: "",
    timeout: 30000,
    retries: 0,
    parallel: false,
  });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setLoadError(null);
    try {
      const [suitesRes, agentsRes, statsRes] = await Promise.all([
        testingApi.getSuites(),
        agentsApi.list(),
        testingApi.getStats(),
      ]);
      setSuites(suitesRes.data.suites);
      setAgents(agentsRes.agents);
      setStats(statsRes.data);
    } catch (error) {
      console.error("Failed to load data:", error);
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }

  async function createSuite() {
    try {
      const res = await testingApi.createSuite({
        agentId: form.agentId,
        name: form.name,
        description: form.description,
        timeout: form.timeout,
        retries: form.retries,
        parallel: form.parallel,
      });
      setSuites([res.data, ...suites]);
      setShowCreateModal(false);
      setForm({
        agentId: "",
        name: "",
        description: "",
        timeout: 30000,
        retries: 0,
        parallel: false,
      });
    } catch (error) {
      console.error("Failed to create suite:", error);
    }
  }

  async function deleteSuite(id: string) {
    if (!(await confirmAction({ title: "Delete this test suite?", destructive: true }))) return;
    try {
      await testingApi.deleteSuite(id);
      setSuites(suites.filter((s) => s.id !== id));
    } catch (error) {
      console.error("Failed to delete suite:", error);
    }
  }

  async function loadCases(suiteId: string) {
    setLoadingCases(true);
    setCasesError(null);
    try {
      const res = await testingApi.getCases(suiteId);
      setCases(res.data);
    } catch (error) {
      setCases([]);
      setCasesError(error);
    } finally {
      setLoadingCases(false);
    }
  }

  function openSuite(suite: TestSuite) {
    setSelectedSuite(suite);
    setCases([]);
    setCaseForm({ name: "", input: "", assertionType: "contains", expected: "" });
    loadCases(suite.id);
  }

  async function addCase() {
    if (!selectedSuite || !caseForm.name.trim() || !caseForm.input.trim()) return;
    if (caseForm.assertionType === "json_schema") {
      // Parsed here so a typo is caught before a case that can never pass is saved.
      let schema: unknown;
      try {
        schema = JSON.parse(caseForm.expected);
      } catch {
        schema = null;
      }
      if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        toast.error("The JSON Schema must be a JSON object.");
        return;
      }
    }
    setSavingCase(true);
    try {
      await testingApi.createCase(selectedSuite.id, {
        name: caseForm.name.trim(),
        inputType: "message",
        input: caseForm.input.trim(),
        assertionType: caseForm.assertionType,
        expected: caseForm.expected.trim(),
      });
      setCaseForm({ name: "", input: "", assertionType: caseForm.assertionType, expected: "" });
      await loadCases(selectedSuite.id);
      // totalTests drives the Run button's enabled state.
      setSelectedSuite({
        ...selectedSuite,
        totalTests: selectedSuite.totalTests + 1,
      });
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to add test case"));
    } finally {
      setSavingCase(false);
    }
  }

  async function removeCase(caseId: string) {
    if (!selectedSuite) return;
    try {
      await testingApi.deleteCase(selectedSuite.id, caseId);
      await loadCases(selectedSuite.id);
      setSelectedSuite({
        ...selectedSuite,
        totalTests: Math.max(0, selectedSuite.totalTests - 1),
      });
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to delete test case"));
    }
  }

  async function runSuite(suiteId: string) {
    try {
      const res = await testingApi.runSuite(suiteId);
      toast.success(`Test run started! ID: ${res.data.id}`);
      loadData();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to run tests"));
    }
  }

  function getStatusColor(status: string | null) {
    switch (status) {
      case "passed":
        return "text-green-600 bg-green-500/10";
      case "failed":
        return "text-red-600 bg-red-500/10";
      case "partial":
        return "text-yellow-600 bg-yellow-500/10";
      case "running":
        return "text-blue-600 bg-blue-500/10";
      default:
        return "text-muted-foreground bg-muted";
    }
  }

  function getRunStatusColor(status: string) {
    switch (status) {
      case "completed":
        return "text-green-600";
      case "failed":
        return "text-red-600";
      case "running":
        return "text-blue-600";
      case "cancelled":
        return "text-muted-foreground";
      default:
        return "text-yellow-600";
    }
  }

  if (loading) {
    return <TestingPageSkeleton />;
  }

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Testing</h1>
        <p className="text-muted-foreground mt-2">
          Create test suites to validate your agents work correctly
        </p>
      </div>

      {loadError ? (
        <ErrorState
          title="Couldn't load test suites"
          error={loadError}
          onRetry={() => void loadData()}
        />
      ) : (
        <>
          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="border rounded-lg p-4">
                <div className="text-2xl font-bold">{stats.totalSuites}</div>
                <div className="text-sm text-muted-foreground">Test Suites</div>
              </div>
              <div className="border rounded-lg p-4">
                <div className="text-2xl font-bold">{stats.totalTests}</div>
                <div className="text-sm text-muted-foreground">Total Tests</div>
              </div>
              <div className="border rounded-lg p-4">
                <div className="text-2xl font-bold">
                  {stats.avgPassRate.toFixed(1)}%
                </div>
                <div className="text-sm text-muted-foreground">Avg Pass Rate</div>
              </div>
              <div className="border rounded-lg p-4">
                <div className="text-2xl font-bold">{stats.recentRuns.length}</div>
                <div className="text-sm text-muted-foreground">Recent Runs</div>
              </div>
            </div>
          )}

          {/* Test Suites */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold">Test Suites</h2>
              <Button onClick={() => setShowCreateModal(true)}>
                <PlusIcon className="w-4 h-4 mr-2" />
                New Suite
              </Button>
            </div>

            {suites.length === 0 ? (
              <EmptyState
                icon={Beaker}
                title="No test suites yet"
                description="Create a test suite to start testing your agents."
                actionLabel="Create Test Suite"
                onAction={() => setShowCreateModal(true)}
              />
            ) : (
              <div className="space-y-4">
                {suites.map((suite) => {
                  const agent = agents.find((a) => a.id === suite.agentId);
                  return (
                    <div
                      key={suite.id}
                      className="border rounded-lg p-4 hover:border-primary/50 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{suite.name}</span>
                            {suite.lastStatus && (
                              <span
                                className={`px-2 py-0.5 text-xs rounded capitalize ${getStatusColor(
                                  suite.lastStatus
                                )}`}
                              >
                                {suite.lastStatus}
                              </span>
                            )}
                          </div>
                          {suite.description && (
                            <p className="text-sm text-muted-foreground mt-1">
                              {suite.description}
                            </p>
                          )}
                          <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                            <span>Agent: {agent?.name || "Unknown"}</span>
                            <span>{suite.totalTests} tests</span>
                            {suite.passRate !== null && (
                              <span>{suite.passRate.toFixed(1)}% pass rate</span>
                            )}
                            {suite.lastRunAt && (
                              <span className="flex items-center gap-1">
                                <ClockIcon className="w-3 h-3" />
                                Last run: {new Date(suite.lastRunAt).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => runSuite(suite.id)}
                            disabled={suite.totalTests === 0}
                          >
                            <PlayIcon className="w-4 h-4 mr-1" />
                            Run
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openSuite(suite)}
                          >
                            View
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => deleteSuite(suite.id)}
                          >
                            <TrashIcon className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Runs */}
          {stats && stats.recentRuns.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Recent Runs</h2>
              <div className="border rounded-lg divide-y">
                {stats.recentRuns.map((run: any) => (
                  <div key={run.id} className="p-4 flex items-center justify-between">
                    <div>
                      <div className="font-medium">{run.suite?.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {new Date(run.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className={`font-medium ${getRunStatusColor(run.status)}`}>
                          {run.status}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {run.passedTests}/{run.totalTests} passed
                        </div>
                      </div>
                      {run.passRate !== null && (
                        <div
                          className={`w-12 h-12 rounded-full flex items-center justify-center ${
                            run.passRate >= 80
                              ? "bg-green-500/10 text-green-500"
                              : run.passRate >= 50
                              ? "bg-yellow-500/10 text-yellow-500"
                              : "bg-red-500/10 text-red-500"
                          }`}
                        >
                          <span className="text-sm font-bold">
                            {run.passRate.toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Create Suite Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-lg p-6 max-w-lg w-full mx-4">
            <h2 className="text-xl font-semibold mb-4">Create Test Suite</h2>
            <div className="space-y-4">
              <div>
                <Label>Agent</Label>
                <select
                  className="w-full mt-1 px-3 py-2 border rounded-md"
                  value={form.agentId}
                  onChange={(e) => setForm({ ...form, agentId: e.target.value })}
                >
                  <option value="">Select an agent</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="My Test Suite"
                />
              </div>
              <div>
                <Label>Description (optional)</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  placeholder="Describe what this test suite validates"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Timeout (ms)</Label>
                  <Input
                    type="number"
                    value={form.timeout}
                    onChange={(e) =>
                      setForm({ ...form, timeout: parseInt(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <Label>Retries</Label>
                  <Input
                    type="number"
                    value={form.retries}
                    onChange={(e) =>
                      setForm({ ...form, retries: parseInt(e.target.value) })
                    }
                  />
                </div>
              </div>
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.parallel}
                    onChange={(e) =>
                      setForm({ ...form, parallel: e.target.checked })
                    }
                  />
                  <span className="text-sm">Run tests in parallel</span>
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                Cancel
              </Button>
              <Button onClick={createSuite} disabled={!form.agentId || !form.name}>
                Create Suite
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Suite Detail Modal */}
      {selectedSuite && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">{selectedSuite.name}</h2>
              <button onClick={() => setSelectedSuite(null)} className="text-muted-foreground hover:text-foreground">
                Close
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="border rounded-lg p-3">
                  <div className="text-xl font-bold">{selectedSuite.totalTests}</div>
                  <div className="text-sm text-muted-foreground">Tests</div>
                </div>
                <div className="border rounded-lg p-3">
                  <div className="text-xl font-bold">
                    {selectedSuite.passRate?.toFixed(1) || 0}%
                  </div>
                  <div className="text-sm text-muted-foreground">Pass Rate</div>
                </div>
                <div className="border rounded-lg p-3">
                  <div className="text-xl font-bold capitalize">
                    {selectedSuite.lastStatus || "N/A"}
                  </div>
                  <div className="text-sm text-muted-foreground">Last Status</div>
                </div>
              </div>

              <div className="border rounded-lg p-4">
                <h3 className="font-medium mb-2">Configuration</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Timeout:</span>{" "}
                    {selectedSuite.timeout}ms
                  </div>
                  <div>
                    <span className="text-muted-foreground">Retries:</span>{" "}
                    {selectedSuite.retries}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Parallel:</span>{" "}
                    {selectedSuite.parallel ? "Yes" : "No"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Enabled:</span>{" "}
                    {selectedSuite.isEnabled ? "Yes" : "No"}
                  </div>
                </div>
              </div>

              {selectedSuite.description && (
                <div className="border rounded-lg p-4">
                  <h3 className="font-medium mb-2">Description</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedSuite.description}
                  </p>
                </div>
              )}

              {/* Test cases — authoring lives here so a suite can
                  actually be run (Wave 1). */}
              <div className="border rounded-lg p-4">
                <h3 className="font-medium mb-3">Test Cases</h3>

                {loadingCases ? (
                  <div className="space-y-2 mb-4" aria-busy="true">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div
                        key={i}
                        className="flex items-start justify-between gap-3 rounded border p-3"
                      >
                        <div className="min-w-0 flex-1 space-y-2">
                          <Skeleton className="h-4 w-1/3" />
                          <Skeleton className="h-4 w-2/3" />
                          <Skeleton className="h-3 w-1/4" />
                        </div>
                        <Skeleton className="h-9 w-20 shrink-0" />
                      </div>
                    ))}
                    <span className="sr-only">Loading test cases</span>
                  </div>
                ) : casesError ? (
                  <div className="mb-4">
                    <ErrorState
                      title="Couldn't load test cases"
                      error={casesError}
                      onRetry={() => void loadCases(selectedSuite.id)}
                    />
                  </div>
                ) : cases.length === 0 ? (
                  <div className="mb-4">
                    <EmptyState
                      icon={ListChecks}
                      title="No test cases yet"
                      description="Add one below — a suite needs at least one case before it can run."
                    />
                  </div>
                ) : (
                  <ul className="space-y-2 mb-4">
                    {cases.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-start justify-between gap-3 rounded border p-3 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="font-medium">{c.name}</div>
                          <div className="text-muted-foreground truncate">
                            {String(c.input)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {c.assertionType}
                            {c.expected ? ` → “${String(c.expected)}”` : ""}
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => removeCase(c.id)}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="space-y-2 border-t pt-3">
                  <Input
                    placeholder="Case name (e.g. answers billing question)"
                    value={caseForm.name}
                    onChange={(e) =>
                      setCaseForm({ ...caseForm, name: e.target.value })
                    }
                  />
                  <Textarea
                    placeholder="Input message sent to the agent"
                    rows={2}
                    value={caseForm.input}
                    onChange={(e) =>
                      setCaseForm({ ...caseForm, input: e.target.value })
                    }
                  />
                  <div className="flex gap-2">
                    <select
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                      value={caseForm.assertionType}
                      onChange={(e) =>
                        setCaseForm({
                          ...caseForm,
                          assertionType: e.target
                            .value as TestCase["assertionType"],
                        })
                      }
                    >
                      <option value="contains">contains</option>
                      <option value="exact">exact</option>
                      <option value="regex">regex</option>
                      <option value="semantic">word overlap</option>
                      <option value="json_schema">json schema</option>
                    </select>
                    {caseForm.assertionType !== "json_schema" && (
                      <Input
                        placeholder="Expected"
                        value={caseForm.expected}
                        onChange={(e) =>
                          setCaseForm({ ...caseForm, expected: e.target.value })
                        }
                      />
                    )}
                  </div>
                  {caseForm.assertionType === "json_schema" && (
                    <Textarea
                      aria-label="JSON Schema the reply must match"
                      placeholder={'{"type": "object", "required": ["answer"], "properties": {"answer": {"type": "string"}}}'}
                      rows={5}
                      spellCheck={false}
                      className="font-mono text-xs"
                      value={caseForm.expected}
                      onChange={(e) =>
                        setCaseForm({ ...caseForm, expected: e.target.value })
                      }
                    />
                  )}
                  <Button
                    onClick={addCase}
                    disabled={
                      savingCase || !caseForm.name.trim() || !caseForm.input.trim()
                    }
                    className="w-full"
                  >
                    <PlusIcon className="w-4 h-4 mr-2" />
                    {savingCase ? "Adding…" : "Add Test Case"}
                  </Button>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={() => {
                    runSuite(selectedSuite.id);
                    setSelectedSuite(null);
                  }}
                  disabled={selectedSuite.totalTests === 0}
                >
                  <PlayIcon className="w-4 h-4 mr-2" />
                  Run Tests
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
