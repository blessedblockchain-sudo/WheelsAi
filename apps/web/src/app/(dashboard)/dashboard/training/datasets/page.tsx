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
  formatDatasetRows,
  getErrorMessage,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";

const formatColors: Record<string, string> = {
  jsonl: "bg-blue-500/10 text-blue-500",
  csv: "bg-green-500/10 text-green-500",
  parquet: "bg-purple-500/10 text-purple-500",
  alpaca: "bg-orange-500/10 text-orange-500",
  sharegpt: "bg-pink-500/10 text-pink-500",
};

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 * 10 ? 2 : 0)} MB`;
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

  async function handleUpload() {
    if (!uploadFile || !uploadForm.name) {
      toast.error("Please provide a name and select a file");
      return;
    }

    // Refused here, before a byte is sent; the server checks again.
    if (storage && uploadFile.size > storage.maxDatasetBytes) {
      toast.error(
        `This file is ${formatMegabytes(uploadFile.size)}. The largest dataset is ${formatMegabytes(storage.maxDatasetBytes)}.`
      );
      return;
    }
    if (uploadFile.size === 0) {
      toast.error("This file is empty");
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const rowCount = await countJsonlRows(uploadFile);
      if (storage && rowCount !== undefined && rowCount > storage.maxDatasetRows) {
        toast.error(
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

      // Reset form
      setShowUploadForm(false);
      setUploadForm({ name: "", description: "" });
      setUploadFile(null);
      loadDatasets();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to upload dataset"));
    } finally {
      setIsUploading(false);
      setIsValidating(false);
      setUploadProgress(0);
    }
  }

  async function handleDelete(datasetId: string) {
    if (!(await confirmAction({ title: "Delete this dataset?", destructive: true }))) {
      return;
    }

    try {
      await trainingApi.deleteDataset(datasetId);
      toast.success("Dataset deleted");
      loadDatasets();
      if (selectedDataset?.id === datasetId) {
        setSelectedDataset(null);
      }
    } catch (error: any) {
      toast.error(getErrorMessage(error, "Failed to delete dataset"));
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
                          "flex items-center justify-between rounded-lg border p-4 transition-colors",
                          selectedDataset?.id === dataset.id
                            ? "border-primary-500 bg-primary/10"
                            : "hover:bg-muted"
                        )}
                      >
                        <div className="flex items-center gap-4">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                            <FileText className="h-5 w-5 text-blue-600" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{dataset.name}</p>
                              <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", formatColors[dataset.fileType] || "bg-muted text-foreground")}>
                                {dataset.fileType}
                              </span>
                              {dataset.schemaFormat && (
                                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                                  {dataset.schemaFormat}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {formatDatasetRows(dataset.rowCount)} &bull;{" "}
                              {(dataset.sizeBytes / 1024 / 1024).toFixed(2)} MB
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
                                Pending
                              </>
                            )}
                          </Badge>

                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleViewDetails(dataset.id)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>

                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(dataset.id)}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </div>
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
                      onChange={(e) => setUploadForm({ ...uploadForm, name: e.target.value })}
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
                      accept=".jsonl,.json,.csv,.parquet"
                      onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                      className="mt-1 block w-full text-sm text-muted-foreground file:mr-4 file:rounded-lg file:border-0 file:bg-primary-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-700 hover:file:bg-primary-100"
                    />
                    {uploadFile && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {uploadFile.name} ({(uploadFile.size / 1024 / 1024).toFixed(2)} MB)
                      </p>
                    )}
                    {storage && (
                      <p className="mt-1 text-xs text-muted-foreground">
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
                      }}
                      disabled={isUploading}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleUpload}
                      disabled={!uploadFile || !uploadForm.name || isUploading}
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
            {selectedDataset && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{selectedDataset.name}</CardTitle>
                  <CardDescription>
                    {selectedDataset.description || "No description"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">File type</dt>
                      <dd className="font-medium">{selectedDataset.fileType}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Row format</dt>
                      <dd className="font-medium">
                        {selectedDataset.schemaFormat ?? "Not detected yet"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Rows</dt>
                      <dd className="font-medium">
                        {selectedDataset.rowCount === null
                          ? "Unknown"
                          : selectedDataset.rowCount.toLocaleString()}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Size</dt>
                      <dd className="font-medium">
                        {(selectedDataset.sizeBytes / 1024 / 1024).toFixed(2)} MB
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Status</dt>
                      <dd>
                        <Badge variant={selectedDataset.isValidated ? "success" : "secondary"}>
                          {selectedDataset.isValidated ? "Valid" : "Pending Validation"}
                        </Badge>
                      </dd>
                    </div>
                  </dl>

                  {selectedDataset.validationErrors && selectedDataset.validationErrors.length > 0 && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-red-500">
                        <AlertTriangle className="h-4 w-4" />
                        {selectedDataset.validationErrors.length} Validation Errors
                      </div>
                      <ul className="mt-2 space-y-1 text-xs text-red-500">
                        {selectedDataset.validationErrors.slice(0, 5).map((err: any, i: number) => (
                          <li key={i}>
                            {err.row ? `Row ${err.row}: ` : ""}{err.message}
                          </li>
                        ))}
                        {selectedDataset.validationErrors.length > 5 && (
                          <li>...and {selectedDataset.validationErrors.length - 5} more</li>
                        )}
                      </ul>
                    </div>
                  )}

                  {selectedDataset.sampleRows && selectedDataset.sampleRows.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-foreground">Sample Data</p>
                      <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-3 text-xs">
                        {JSON.stringify(selectedDataset.sampleRows[0], null, 2)}
                      </pre>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRevalidate(selectedDataset.id)}
                      isLoading={isValidating}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Revalidate
                    </Button>
                    <Link href={`/dashboard/training/new?dataset=${selectedDataset.id}`}>
                      <Button size="sm">
                        Start Training
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Format guide */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Dataset Formats</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div>
                  <p className="font-medium">Alpaca Format</p>
                  <p className="text-muted-foreground">
                    JSONL with instruction, input (optional), and output fields
                  </p>
                </div>
                <div>
                  <p className="font-medium">ShareGPT Format</p>
                  <p className="text-muted-foreground">
                    JSONL with conversations array containing human/gpt turns
                  </p>
                </div>
                <div>
                  <p className="font-medium">Text Format</p>
                  <p className="text-muted-foreground">
                    JSONL with a single text field containing the full example
                  </p>
                </div>
                <div>
                  <p className="font-medium">CSV Format</p>
                  <p className="text-muted-foreground">
                    CSV with prompt and completion columns
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
