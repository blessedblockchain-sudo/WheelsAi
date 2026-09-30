"use client";

import { useState, useEffect } from "react";
import {
  Plus,
  X,
  GitBranch,
  ArrowLeft,
  Upload,
  History,
  Tag,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  versioningApi,
  type VersionHistoryEntry,
  type AgentVersionDiff,
  type ChangeType,
  getErrorMessage,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentTabProps } from "./types";

export function VersionsTab({ agent, agentId, loadAgent }: AgentTabProps) {
  const [versionHistory, setVersionHistory] = useState<VersionHistoryEntry[]>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [showCreateVersion, setShowCreateVersion] = useState(false);
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);
  const [newVersionForm, setNewVersionForm] = useState({
    changeLog: "",
    changeType: "patch" as ChangeType,
    tags: "",
  });
  const [comparingVersions, setComparingVersions] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [versionDiff, setVersionDiff] = useState<AgentVersionDiff | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState<string | null>(null);

  async function loadVersionHistory() {
    setIsLoadingVersions(true);
    try {
      const history = await versioningApi.getHistory(agentId);
      setVersionHistory(history);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load version history"));
    } finally {
      setIsLoadingVersions(false);
    }
  }

  useEffect(() => {
    loadVersionHistory();
  }, [agentId]);

  async function handleCreateVersion() {
    setIsCreatingVersion(true);
    try {
      const tags = newVersionForm.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      await versioningApi.createVersion(agentId, {
        changeLog: newVersionForm.changeLog || undefined,
        changeType: newVersionForm.changeType,
        tags: tags.length > 0 ? tags : undefined,
      });

      toast.success("Version created successfully");
      setShowCreateVersion(false);
      setNewVersionForm({ changeLog: "", changeType: "patch", tags: "" });
      loadVersionHistory();
      loadAgent();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to create version"));
    } finally {
      setIsCreatingVersion(false);
    }
  }

  async function handleCompareVersions(from: string, to: string) {
    setComparingVersions({ from, to });
    setIsLoadingDiff(true);
    try {
      const diff = await versioningApi.compareVersions(agentId, from, to);
      setVersionDiff(diff);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to compare versions"));
    } finally {
      setIsLoadingDiff(false);
    }
  }

  async function handleRollback(version: string) {
    if (!confirm(`Are you sure you want to rollback to version ${version}? This will create a new version.`)) {
      return;
    }

    setIsRollingBack(version);
    try {
      await versioningApi.rollbackToVersion(agentId, version);
      toast.success(`Rolled back to version ${version}`);
      loadVersionHistory();
      loadAgent();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to rollback"));
    } finally {
      setIsRollingBack(null);
    }
  }

  async function handlePublishVersion(version: string) {
    try {
      await versioningApi.publishVersion(agentId, version);
      toast.success("Version published");
      loadVersionHistory();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to publish version"));
    }
  }

  return (
    <div className="space-y-6">
      {/* Create Version Modal */}
      {showCreateVersion && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Create New Version</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCreateVersion(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Change Type
              </label>
              <Select
                value={newVersionForm.changeType}
                onChange={(e) =>
                  setNewVersionForm({
                    ...newVersionForm,
                    changeType: e.target.value as ChangeType,
                  })
                }
              >
                <option value="patch">Patch (bug fixes)</option>
                <option value="minor">Minor (new features)</option>
                <option value="major">Major (breaking changes)</option>
              </Select>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Change Log (optional)
              </label>
              <Textarea
                value={newVersionForm.changeLog}
                onChange={(e) =>
                  setNewVersionForm({
                    ...newVersionForm,
                    changeLog: e.target.value,
                  })
                }
                placeholder="Describe what changed in this version..."
                rows={3}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Tags (comma-separated, optional)
              </label>
              <Input
                value={newVersionForm.tags}
                onChange={(e) =>
                  setNewVersionForm({
                    ...newVersionForm,
                    tags: e.target.value,
                  })
                }
                placeholder="stable, production, beta"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowCreateVersion(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateVersion}
                isLoading={isCreatingVersion}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create Version
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Version Comparison Modal */}
      {comparingVersions && (
        <Card className="border-blue-500/30 bg-blue-500/5">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                Comparing v{comparingVersions.from} → v{comparingVersions.to}
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setComparingVersions(null);
                  setVersionDiff(null);
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoadingDiff ? (
              <div className="h-32 animate-pulse rounded bg-muted" />
            ) : versionDiff ? (
              <div className="space-y-4">
                <div className="flex gap-4 text-sm">
                  {versionDiff.linesAdded > 0 && (
                    <span className="text-green-600">
                      +{versionDiff.linesAdded} added
                    </span>
                  )}
                  {versionDiff.linesRemoved > 0 && (
                    <span className="text-red-600">
                      -{versionDiff.linesRemoved} removed
                    </span>
                  )}
                </div>

                {versionDiff.addedFields.length > 0 && (
                  <div>
                    <p className="font-medium text-green-500 mb-1">
                      Added Fields:
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {versionDiff.addedFields.map((field) => (
                        <Badge key={field} variant="success">
                          {field}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {versionDiff.removedFields.length > 0 && (
                  <div>
                    <p className="font-medium text-red-500 mb-1">
                      Removed Fields:
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {versionDiff.removedFields.map((field) => (
                        <Badge key={field} variant="destructive">
                          {field}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {versionDiff.modifiedFields.length > 0 && (
                  <div>
                    <p className="font-medium text-yellow-500 mb-1">
                      Modified Fields:
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {versionDiff.modifiedFields.map((field) => (
                        <Badge key={field} variant="warning">
                          {field}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {Object.keys(versionDiff.changes).length > 0 && (
                  <div className="mt-4">
                    <p className="font-medium mb-2">Changes Detail:</p>
                    <pre className="rounded bg-gray-900 p-4 text-sm text-gray-100 overflow-auto max-h-64">
                      {JSON.stringify(versionDiff.changes, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">No differences found</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Version History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Version History</CardTitle>
              <CardDescription>
                Track changes and rollback to previous versions
              </CardDescription>
            </div>
            {!showCreateVersion && (
              <Button onClick={() => setShowCreateVersion(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create Version
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingVersions ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-24 animate-pulse rounded bg-muted"
                />
              ))}
            </div>
          ) : versionHistory.length > 0 ? (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-4 top-6 bottom-6 w-0.5 bg-muted" />

              <div className="space-y-4">
                {versionHistory.map((version, index) => {
                  const prevVersion = versionHistory[index + 1];

                  return (
                    <div
                      key={version.id}
                      className={cn(
                        "relative pl-10 rounded-lg border p-4",
                        version.isLatest && "border-primary/30 bg-primary/5"
                      )}
                    >
                      {/* Timeline dot */}
                      <div
                        className={cn(
                          "absolute left-2.5 top-6 h-3 w-3 rounded-full border-2 border-white",
                          version.isLatest
                            ? "bg-primary-500"
                            : "bg-gray-400"
                        )}
                      />

                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold">
                              v{version.version}
                            </span>
                            {version.isLatest && (
                              <Badge variant="success">Latest</Badge>
                            )}
                            {version.isPublished && (
                              <Badge variant="secondary">Published</Badge>
                            )}
                            <Badge
                              variant={
                                version.changeType === "major"
                                  ? "destructive"
                                  : version.changeType === "minor"
                                  ? "warning"
                                  : "secondary"
                              }
                            >
                              {version.changeType}
                            </Badge>
                          </div>

                          {version.changeLog && (
                            <p className="mt-1 text-sm text-muted-foreground">
                              {version.changeLog}
                            </p>
                          )}

                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>by {version.createdByName}</span>
                            <span>•</span>
                            <span>
                              {new Date(version.createdAt).toLocaleDateString()}
                            </span>
                            {version.tags.length > 0 && (
                              <>
                                <span>•</span>
                                <div className="flex gap-1">
                                  {version.tags.map((tag) => (
                                    <span
                                      key={tag}
                                      className="inline-flex items-center rounded bg-muted px-1.5 py-0.5"
                                    >
                                      <Tag className="mr-1 h-3 w-3" />
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>

                          {/* Diff summary */}
                          {version.diff && (
                            <div className="mt-2 flex gap-3 text-xs">
                              {version.diff.linesAdded > 0 && (
                                <span className="text-green-600">
                                  +{version.diff.linesAdded}
                                </span>
                              )}
                              {version.diff.linesRemoved > 0 && (
                                <span className="text-red-600">
                                  -{version.diff.linesRemoved}
                                </span>
                              )}
                              {version.diff.modifiedFields.length > 0 && (
                                <span className="text-muted-foreground">
                                  {version.diff.modifiedFields.length} fields
                                  changed
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="flex gap-2">
                          {prevVersion && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                handleCompareVersions(
                                  prevVersion.version,
                                  version.version
                                )
                              }
                            >
                              <GitBranch className="mr-1 h-3 w-3" />
                              Compare
                            </Button>
                          )}
                          {!version.isLatest && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRollback(version.version)}
                              isLoading={isRollingBack === version.version}
                            >
                              <ArrowLeft className="mr-1 h-3 w-3" />
                              Rollback
                            </Button>
                          )}
                          {!version.isPublished && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                handlePublishVersion(version.version)
                              }
                            >
                              <Upload className="mr-1 h-3 w-3" />
                              Publish
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-center py-8">
              <History className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-2 text-sm font-medium text-foreground">
                No versions yet
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Create your first version to start tracking changes.
              </p>
              <Button
                className="mt-4"
                onClick={() => setShowCreateVersion(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Create First Version
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
