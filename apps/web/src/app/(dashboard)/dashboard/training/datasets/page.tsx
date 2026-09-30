"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import {
  Database,
  Plus,
  Upload,
  Trash2,
  CheckCircle,
  XCircle,
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
import { Select } from "@/components/ui/select";
import { trainingApi, type Dataset, type DatasetDetail, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

const formatColors: Record<string, string> = {
  jsonl: "bg-blue-500/10 text-blue-500",
  csv: "bg-green-500/10 text-green-500",
  parquet: "bg-purple-500/10 text-purple-500",
  alpaca: "bg-orange-500/10 text-orange-500",
  sharegpt: "bg-pink-500/10 text-pink-500",
};

export default function DatasetsPage() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [selectedDataset, setSelectedDataset] = useState<DatasetDetail | null>(null);

  // Upload form state
  const [uploadForm, setUploadForm] = useState({
    name: "",
    description: "",
    format: "jsonl" as const,
  });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadDatasets() {
    try {
      const { datasets } = await trainingApi.listDatasets();
      setDatasets(datasets);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load datasets"));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadDatasets();
  }, []);

  async function handleUpload() {
    if (!uploadFile || !uploadForm.name) {
      toast.error("Please provide a name and select a file");
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      // Step 1: Create dataset and get upload URL
      const { dataset, upload } = await trainingApi.createDataset({
        name: uploadForm.name,
        description: uploadForm.description,
        fileName: uploadFile.name,
        contentType: uploadFile.type || "application/octet-stream",
        format: uploadForm.format,
      });

      setUploadProgress(20);

      // Step 2: Upload file to S3
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

        xhr.open("PUT", upload.url);
        xhr.setRequestHeader("Content-Type", uploadFile.type || "application/octet-stream");
        xhr.send(uploadFile);
      });

      setUploadProgress(80);

      // Step 3: Validate dataset
      setIsValidating(true);
      const validation = await trainingApi.validateDataset(dataset.id);
      setUploadProgress(100);

      if (validation.validation.isValid) {
        toast.success(`Dataset uploaded: ${validation.validation.rowCount} rows validated`);
      } else {
        toast.warning(`Dataset uploaded with ${validation.validation.errors.length} validation errors`);
      }

      // Reset form
      setShowUploadForm(false);
      setUploadForm({ name: "", description: "", format: "jsonl" });
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
    if (!confirm("Are you sure you want to delete this dataset?")) {
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
        toast.warning(`Validation found ${validation.validation.errors.length} errors`);
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
                <Button onClick={() => setShowUploadForm(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Upload Dataset
                </Button>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
                    ))}
                  </div>
                ) : datasets.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16">
                    <Database className="h-16 w-16 text-gray-300" />
                    <h3 className="mt-4 text-xl font-medium">No datasets yet</h3>
                    <p className="mt-2 text-muted-foreground">
                      Upload your first dataset to start training
                    </p>
                    <Button onClick={() => setShowUploadForm(true)} className="mt-6">
                      <Upload className="mr-2 h-4 w-4" />
                      Upload Dataset
                    </Button>
                  </div>
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
                              <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", formatColors[dataset.format] || "bg-muted text-foreground")}>
                                {dataset.format}
                              </span>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {dataset.rowCount.toLocaleString()} rows &bull;{" "}
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
            {/* Upload form */}
            {showUploadForm && (
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
                      Format
                    </label>
                    <Select
                      value={uploadForm.format}
                      onChange={(e) => setUploadForm({ ...uploadForm, format: e.target.value as any })}
                      className="mt-1"
                    >
                      <option value="jsonl">JSONL</option>
                      <option value="csv">CSV</option>
                      <option value="parquet">Parquet</option>
                      <option value="alpaca">Alpaca Format</option>
                      <option value="sharegpt">ShareGPT Format</option>
                    </Select>
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
                      <dt className="text-muted-foreground">Format</dt>
                      <dd className="font-medium">{selectedDataset.format}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Rows</dt>
                      <dd className="font-medium">{selectedDataset.rowCount.toLocaleString()}</dd>
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
