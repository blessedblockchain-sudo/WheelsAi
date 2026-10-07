"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import {
  Database,
  Plus,
  Upload,
  Trash2,
  CheckCircle,
  Clock,
  FileText,
  RefreshCw,
  AlertTriangle,
  Eye,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import {
  trainingApi,
  type Dataset,
  type DatasetDetail,
  type DatasetStorageState,
  type DatasetValidationResult,
  formatDatasetRows,
  getApiErrorBody,
  getErrorMessage,
} from "@/lib/api";
import {
  DATASET_ROW_FORMATS,
  datasetFileTypeFromName,
  datasetRowFormat,
  datasetTrainingBlocker,
  formatBytes,
} from "@/lib/training";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 * 10 ? 2 : 0)} MB`;
}

/** How many sample rows and row errors the details card shows before "and N more". */
const SAMPLE_ROWS_SHOWN = 3;
const ROW_ERRORS_SHOWN = 10;

/** The result of the last validation run on this page, kept until another dataset is opened. */
interface LastValidation {
  datasetId: string;
  result: DatasetValidationResult;
}

/**
 * Rows in a JSON Lines file, counted by reading it once in the browser so a
 * file over the row limit is refused before it is uploaded. Other file types
 * are counted by the server when it validates them.
 */
async function countJsonlRows(file: File): Promise<number | undefined> {
  if (!/\.(jsonl|ndjson|json)$/i.test(file.name) || typeof file.stream !== "function") {
    return undefined;
  }
  const reader = file.stream().getReader();
  let rows = 0;
  let lineHasContent = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const byte of value) {
      if (byte === 10) {
        if (lineHasContent) rows += 1;
        lineHasContent = false;
      } else if (byte !== 13 && byte !== 32 && byte !== 9) {
        lineHasContent = true;
      }
    }
  }
  return lineHasContent ? rows + 1 : rows;
}

export default function DatasetsPage() {
  const confirmAction = useConfirm();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [storage, setStorage] = useState<DatasetStorageState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [selectedDataset, setSelectedDataset] = useState<DatasetDetail | null>(null);

  // Upload form state
  const [uploadForm, setUploadForm] = useState({
    name: "",
    description: "",
  });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [lastValidation, setLastValidation] = useState<LastValidation | null>(null);
  // Why a delete was refused (409 dataset_in_use), shown on the dataset's row.
  const [deleteRefusal, setDeleteRefusal] = useState<{ datasetId: string; message: string } | null>(null);
  // Why the chosen file cannot be uploaded, shown under the file input.
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  // The name follows the chosen file until the user types one of their own.
  const [nameIsSuggested, setNameIsSuggested] = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadDatasets() {
    try {
      const { datasets, storage } = await trainingApi.listDatasets();
      setDatasets(datasets);
      setStorage(storage);
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load datasets"));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadDatasets();
  }, []);

  function handleRetry() {
    setLoadError(null);
    setIsLoading(true);
    void loadDatasets();
  }

  /** Why this file would be refused, checked before a byte is sent; the server checks again. */
  function problemWithFile(file: File): string | null {
    if (datasetFileTypeFromName(file.name) === null) {
      return "This file type is not supported. Upload a .jsonl, .csv or .parquet file.";
    }
    if (file.size === 0) return "This file is empty.";
    if (storage && file.size > storage.maxDatasetBytes) {
      return `This file is ${formatMegabytes(file.size)}. The largest dataset is ${formatMegabytes(storage.maxDatasetBytes)}.`;
    }
    return null;
  }

  function handleFileChosen(file: File | null) {
    const problem = file ? problemWithFile(file) : null;
    setUploadFile(file);
    setFileProblem(problem);
    // A name is suggested from a file that can be uploaded, never forced.
    if (file && !problem && (nameIsSuggested || !uploadForm.name)) {
      const suggested = file.name
        .replace(/\.[a-z0-9]+$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100);
      if (suggested) {
        setUploadForm((form) => ({ ...form, name: suggested }));
        setNameIsSuggested(true);
      }
    }
  }

  async function handleUpload() {
    if (!uploadFile || !uploadForm.name) {
      toast.error("Please provide a name and select a file");
      return;
    }

    const problem = problemWithFile(uploadFile);
    const fileType = datasetFileTypeFromName(uploadFile.name);
    if (problem || fileType === null) {
      setFileProblem(problem);
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const rowCount = fileType === "jsonl" ? await countJsonlRows(uploadFile) : undefined;
      if (storage && rowCount !== undefined && rowCount > storage.maxDatasetRows) {
        setFileProblem(
          `This file has ${rowCount.toLocaleString()} rows. The most a dataset can have is ${storage.maxDatasetRows.toLocaleString()}.`
        );
        return;
      }

      // Step 1: Create dataset and get upload URL
      const { dataset, upload } = await trainingApi.createDataset({
        name: uploadForm.name,
        description: uploadForm.description,
        fileName: uploadFile.name,
        sizeBytes: uploadFile.size,
        rowCount,
        // From the file name's extension, the same rule the API applies.
        fileType,
        contentType: uploadFile.type || "application/octet-stream",
      });

      setUploadProgress(20);

      // Step 2: Upload the file straight to storage
      const xhr = new XMLHttpRequest();

      await new Promise<void>((resolve, reject) => {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            const progress = 20 + (e.loaded / e.total) * 60;
            setUploadProgress(Math.round(progress));
          }
        });

        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        });

        xhr.addEventListener("error", () => reject(new Error("Upload failed")));

        xhr.open(upload.method, upload.url);
        // The link is signed for exactly these headers.
        for (const [name, value] of Object.entries(upload.headers)) {
          xhr.setRequestHeader(name, value);
        }
        xhr.send(uploadFile);
      });

      setUploadProgress(80);

      // Step 3: Validate dataset
      setIsValidating(true);
      const validation = await trainingApi.validateDataset(dataset.id);
      setUploadProgress(100);

      if (validation.validation.isValid) {
        toast.success(
          validation.validation.rowCount === null
            ? "Dataset uploaded and recognised"
            : `Dataset uploaded: ${validation.validation.rowCount.toLocaleString()} rows validated`
        );
      } else {
        toast.warning(`Dataset uploaded with ${validation.validation.errorCount} validation errors`);
      }

      // Reset form, and open the new dataset with what validation found.
      setShowUploadForm(false);
      setUploadForm({ name: "", description: "" });
      setUploadFile(null);
      setFileProblem(null);
      setNameIsSuggested(true);
      setLastValidation({ datasetId: dataset.id, result: validation });
      loadDatasets();
      void handleViewDetails(dataset.id);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to upload dataset"));
    } finally {
      setIsUploading(false);
      setIsValidating(false);
      setUploadProgress(0);
    }
  }

  async function handleDelete(dataset: Dataset) {
    if (
      !(await confirmAction({
        title: `Delete "${dataset.name}"?`,
        description:
          "The file is removed from storage and the name becomes free. Finished training jobs keep their results.",
        confirmLabel: "Delete dataset",
        destructive: true,
      }))
    ) {
      return;
    }

    setDeleteRefusal(null);
    try {
      await trainingApi.deleteDataset(dataset.id);
      toast.success("Dataset deleted");
      loadDatasets();
      if (selectedDataset?.id === dataset.id) {
        setSelectedDataset(null);
      }
    } catch (error) {
      // 409 dataset_in_use: the API says how many unfinished jobs hold it.
      // The reason stays on the row; a toast alone would be gone in seconds.
      const failure = getApiErrorBody(error);
      if (failure?.status === 409) {
        setDeleteRefusal({
          datasetId: dataset.id,
          message: getErrorMessage(error, "This dataset is in use and cannot be deleted yet."),
        });
      } else {
        toast.error(getErrorMessage(error, "Failed to delete dataset"));
      }
    }
  }

  async function handleViewDetails(datasetId: string) {
    try {
      const { dataset } = await trainingApi.getDataset(datasetId);
      setSelectedDataset(dataset);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load dataset details"));
    }
  }

  async function handleRevalidate(datasetId: string) {
    setIsValidating(true);
    try {
      const validation = await trainingApi.validateDataset(datasetId);
      setLastValidation({ datasetId, result: validation });
      if (validation.validation.isValid) {
        toast.success("Dataset validated successfully");
      } else {
        toast.warning(`Validation found ${validation.validation.errorCount} errors`);
      }
      loadDatasets();
      if (selectedDataset?.id === datasetId) {
        handleViewDetails(datasetId);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, "Validation failed"));
    } finally {
      setIsValidating(false);
    }
  }

  // Known only once the list has loaded; until then nothing is claimed.
  const storageUnavailable = storage !== null && !storage.configured;
  const canUpload = storage !== null && storage.configured;

  return (
    <div className="flex flex-col">
      <Header
        title="Datasets"
        description="Manage training datasets"
      />

      <div className="p-8">
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Datasets list */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Your Datasets</CardTitle>
                  <CardDescription>Upload and manage training data</CardDescription>
                </div>
                <Button onClick={() => setShowUploadForm(true)} disabled={!canUpload}>
                  <Plus className="mr-2 h-4 w-4" />
                  Upload Dataset
                </Button>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-4" aria-busy="true">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between rounded-lg border p-4"
                      >
                        <div className="flex items-center gap-4">
                          <Skeleton className="h-10 w-10 rounded-lg" />
                          <div className="space-y-2">
                            <Skeleton className="h-5 w-40" />
                            <Skeleton className="h-4 w-32" />
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-5 w-16 rounded-full" />
                          <Skeleton className="h-9 w-9" />
                          <Skeleton className="h-9 w-9" />
                        </div>
                      </div>
                    ))}
                    <span className="sr-only">Loading datasets</span>
                  </div>
                ) : loadError ? (
                  <ErrorState
                    title="Couldn't load datasets"
                    error={loadError}
                    onRetry={handleRetry}
                  />
                ) : datasets.length === 0 ? (
                  <EmptyState
                    icon={Database}
                    title="No datasets yet"
                    description={
                      canUpload
                        ? "Upload your first dataset to start training."
                        : "Datasets you upload will be listed here."
                    }
                    actionLabel={canUpload ? "Upload Dataset" : undefined}
                    onAction={canUpload ? () => setShowUploadForm(true) : undefined}
                  />
                ) : (
                  <div className="space-y-4">
                    {datasets.map((dataset) => (
                      <div
                        key={dataset.id}
                        className={cn(
                          "rounded-lg border p-4 transition-colors",
                          selectedDataset?.id === dataset.id
                            ? "border-primary bg-primary/10"
                            : "hover:bg-muted"
                        )}
                      >
                       <div className="flex items-center justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-4">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15">
                            <FileText className="h-5 w-5 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-medium">{dataset.name}</p>
                              <Badge variant="outline">{dataset.fileType}</Badge>
                              {dataset.schemaFormat && (
                                <Badge variant="secondary">{datasetRowFormat(dataset.schemaFormat).label}</Badge>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {formatDatasetRows(dataset.rowCount)} &bull; {formatBytes(dataset.sizeBytes)}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-3">
                          <Badge variant={dataset.isValidated ? "success" : "secondary"}>
                            {dataset.isValidated ? (
                              <>
                                <CheckCircle className="mr-1 h-3 w-3" />
                                Valid
                              </>
                            ) : (
                              <>
                                <Clock className="mr-1 h-3 w-3" />
                                Not valid
                              </>
                            )}
                          </Badge>

                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`View ${dataset.name}`}
                            onClick={() => {
                              if (lastValidation?.datasetId !== dataset.id) setLastValidation(null);
                              void handleViewDetails(dataset.id);
                            }}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>

                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Delete ${dataset.name}`}
                            onClick={() => handleDelete(dataset)}
                          >
                            <Trash2 className="h-4 w-4 text-danger" />
                          </Button>
                        </div>
                       </div>
                        {deleteRefusal?.datasetId === dataset.id && (
                          <p
                            role="alert"
                            data-testid="dataset-delete-refusal"
                            className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-foreground"
                          >
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span>
                              Not deleted. {deleteRefusal.message}{" "}
                              <Link href="/dashboard/training" className="text-primary underline-offset-4 hover:underline">
                                See training jobs
                              </Link>
                            </span>
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Storage is not set up: say so where the upload form would be */}
            {storageUnavailable && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                    Uploads are not available
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    This server has no object storage configured, so it cannot accept a
                    dataset upload yet. Nothing was uploaded or lost.
                  </p>
                  <p>
                    Datasets that already exist are still listed. Uploading opens once an
                    administrator connects a storage bucket.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Upload form */}
            {showUploadForm && canUpload && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Upload Dataset</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground">
                      Dataset Name *
                    </label>
                    <Input
                      value={uploadForm.name}
                      onChange={(e) => {
                        setUploadForm({ ...uploadForm, name: e.target.value });
                        setNameIsSuggested(false);
                      }}
                      placeholder="my-training-data"
                      className="mt-1"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground">
                      Description
                    </label>
                    <Input
                      value={uploadForm.description}
                      onChange={(e) => setUploadForm({ ...uploadForm, description: e.target.value })}
                      placeholder="Customer support conversations..."
                      className="mt-1"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground">
                      File
                    </label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".jsonl,.ndjson,.json,.csv,.parquet"
                      aria-describedby="dataset-file-help"
                      onChange={(e) => handleFileChosen(e.target.files?.[0] || null)}
                      className="mt-1 block w-full text-sm text-muted-foreground file:mr-4 file:rounded-lg file:border-0 file:bg-primary/15 file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/25"
                    />
                    {uploadFile && !fileProblem && (
                      <p className="mt-1 text-xs text-muted-foreground" data-testid="dataset-file-type">
                        {uploadFile.name} ({formatBytes(uploadFile.size)}), read as{" "}
                        <span className="font-medium text-foreground">
                          {datasetFileTypeFromName(uploadFile.name)}
                        </span>{" "}
                        from its extension
                      </p>
                    )}
                    {fileProblem && (
                      <p role="alert" className="mt-1 text-xs text-danger">
                        {fileProblem}
                      </p>
                    )}
                    {storage && (
                      <p id="dataset-file-help" className="mt-1 text-xs text-muted-foreground">
                        JSONL, CSV or Parquet, up to {formatMegabytes(storage.maxDatasetBytes)} and{" "}
                        {storage.maxDatasetRows.toLocaleString()} rows. The row format is detected
                        when the file is validated.
                      </p>
                    )}
                  </div>

                  {isUploading && (
                    <div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">
                          {isValidating ? "Validating..." : "Uploading..."}
                        </span>
                        <span className="font-medium">{uploadProgress}%</span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-primary-500 transition-all"
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowUploadForm(false);
                        setUploadFile(null);
                        setFileProblem(null);
                      }}
                      disabled={isUploading}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleUpload}
                      disabled={!uploadFile || !uploadForm.name || isUploading || fileProblem !== null}
                      isLoading={isUploading}
                      className="flex-1"
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Upload
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Dataset details */}
            {selectedDataset && (() => {
              // What the last validation on this page found, when it was this dataset's:
              // it carries the true error count, the warnings and the token figures.
              const validated =
                lastValidation?.datasetId === selectedDataset.id ? lastValidation.result : null;
              const errors = validated?.validation.errors ?? selectedDataset.validationErrors ?? [];
              const errorCount = validated?.validation.errorCount ?? errors.length;
              const warnings = validated?.validation.warnings ?? [];
              const samples = validated?.sampleRows ?? selectedDataset.sampleRows ?? [];
              const rowFormat = datasetRowFormat(selectedDataset.schemaFormat);
              // A dataset that is not valid either has row errors or was never checked.
              const blocker =
                !selectedDataset.isValidated && errorCount > 0
                  ? "It has row errors. Fix the file and upload it again."
                  : !selectedDataset.isValidated
                    ? "It has not been validated. Use Validate again."
                    : datasetTrainingBlocker(selectedDataset);
              return (
              <Card data-testid="dataset-details">
                <CardHeader>
                  <CardTitle className="text-base">{selectedDataset.name}</CardTitle>
                  <CardDescription>
                    {selectedDataset.description || "No description"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">File type</dt>
                      <dd className="font-medium">{selectedDataset.fileType}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Row format</dt>
                      <dd className="text-right font-medium" data-testid="dataset-row-format">
                        {rowFormat.label}
                        {rowFormat.shape && (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {rowFormat.shape}
                          </span>
                        )}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Rows</dt>
                      <dd className="font-medium">
                        {selectedDataset.rowCount === null
                          ? "Unknown"
                          : selectedDataset.rowCount.toLocaleString()}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Size</dt>
                      <dd className="font-medium">{formatBytes(selectedDataset.sizeBytes)}</dd>
                    </div>
                    {selectedDataset.avgTokensPerRow !== null && (
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Tokens per row (average)</dt>
                        <dd className="font-medium">
                          {Math.round(selectedDataset.avgTokensPerRow).toLocaleString()}
                        </dd>
                      </div>
                    )}
                    {selectedDataset.totalTokens !== null && (
                      <div className="flex justify-between gap-4">
                        <dt className="text-muted-foreground">Tokens (total)</dt>
                        <dd className="font-medium">{selectedDataset.totalTokens.toLocaleString()}</dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Status</dt>
                      <dd>
                        <Badge
                          variant={
                            selectedDataset.isValidated ? "success" : errorCount > 0 ? "destructive" : "secondary"
                          }
                        >
                          {selectedDataset.isValidated
                            ? "Valid"
                            : errorCount > 0
                              ? "Has row errors"
                              : "Not validated"}
                        </Badge>
                      </dd>
                    </div>
                  </dl>

                  {errors.length > 0 && (
                    <div
                      className="rounded-lg border border-danger/30 bg-danger/10 p-3"
                      data-testid="dataset-row-errors"
                    >
                      <div className="flex items-center gap-2 text-sm font-medium text-danger">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        {errorCount.toLocaleString()} row {errorCount === 1 ? "error" : "errors"}
                      </div>
                      <ul className="mt-2 space-y-1 text-xs text-foreground">
                        {errors.slice(0, ROW_ERRORS_SHOWN).map((issue, i) => (
                          <li key={i}>
                            {issue.row !== undefined && (
                              <span className="font-mono text-muted-foreground">Row {issue.row}: </span>
                            )}
                            {issue.message}
                          </li>
                        ))}
                      </ul>
                      {errorCount > Math.min(errors.length, ROW_ERRORS_SHOWN) && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          and {(errorCount - Math.min(errors.length, ROW_ERRORS_SHOWN)).toLocaleString()} more.
                          Fix the file and upload it again; a dataset with row errors cannot be trained on.
                        </p>
                      )}
                    </div>
                  )}

                  {warnings.length > 0 && (
                    <ul className="space-y-1 rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
                      {warnings.map((warning, i) => (
                        <li key={i}>{warning.message}</li>
                      ))}
                    </ul>
                  )}

                  {samples.length > 0 && (
                    <div data-testid="dataset-sample">
                      <p className="text-sm font-medium text-foreground">
                        Sample rows
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          first {Math.min(samples.length, SAMPLE_ROWS_SHOWN)} as read from the file
                        </span>
                      </p>
                      <div className="mt-2 space-y-2">
                        {samples.slice(0, SAMPLE_ROWS_SHOWN).map((row, i) => (
                          <pre
                            key={i}
                            className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs text-foreground"
                          >
                            {JSON.stringify(row, null, 2)}
                          </pre>
                        ))}
                      </div>
                    </div>
                  )}

                  {blocker && (
                    <p className="text-xs text-muted-foreground" data-testid="dataset-training-blocker">
                      Cannot be trained on yet. {blocker}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRevalidate(selectedDataset.id)}
                      isLoading={isValidating}
                      disabled={!canUpload}
                      title={canUpload ? undefined : "Validation reads the file from storage, which is not configured."}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Validate again
                    </Button>
                    {blocker ? (
                      <Button size="sm" disabled>
                        Train on this dataset
                      </Button>
                    ) : (
                      <Link href={`/dashboard/training/new?dataset=${selectedDataset.id}`}>
                        <Button size="sm">Train on this dataset</Button>
                      </Link>
                    )}
                  </div>
                </CardContent>
              </Card>
              );
            })()}

            {/* Format guide */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Row formats</CardTitle>
                <CardDescription>
                  Upload JSON Lines, CSV or Parquet. The row format is detected from the columns when
                  the file is validated.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {DATASET_ROW_FORMATS.map((format) => (
                  <div key={format.id}>
                    <p className="font-medium">{format.label}</p>
                    <p className="text-muted-foreground">Fields: {format.shape}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
