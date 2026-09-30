"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Database,
  FileText,
  Layers,
  Plus,
  Search,
  Trash2,
  ChevronDown,
  ChevronRight,
  X,
  BookOpen,
  Sparkles,
  Hash,
  AlertCircle,
  Loader2,
} from "lucide-react";
import {
  knowledgeApi,
  type KnowledgeBase,
  type KnowledgeDocument,
  type SearchResult,
  getErrorMessage,
} from "@/lib/api";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";

// ---------------------------------------------------------------------------
// Status badge color map
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  ready: "bg-green-500/20 text-green-400 border-green-500/30",
  processing: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  error: "bg-red-500/20 text-red-400 border-red-500/30",
  pending: "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

function statusClasses(status: string): string {
  return STATUS_COLORS[status] ?? "bg-gray-500/20 text-gray-400 border-gray-500/30";
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function KnowledgePage() {
  const confirmAction = useConfirm();
  // Data state
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [stats, setStats] = useState<{
    totalBases: number;
    totalDocuments: number;
    totalChunks: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  // UI state
  const [activeTab, setActiveTab] = useState<"bases" | "search">("bases");
  const [expandedKbId, setExpandedKbId] = useState<string | null>(null);
  const [expandedDocs, setExpandedDocs] = useState<KnowledgeDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddDocModal, setShowAddDocModal] = useState(false);
  const [addDocKbId, setAddDocKbId] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchKbId, setSearchKbId] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);

  // Create KB form
  const [createForm, setCreateForm] = useState({
    name: "",
    description: "",
    embeddingModel: "text-embedding-3-small",
    chunkSize: 512,
    chunkOverlap: 50,
  });
  const [creating, setCreating] = useState(false);

  // Add document form
  const [docForm, setDocForm] = useState({
    title: "",
    content: "",
    sourceType: "text" as string,
    tags: "",
  });
  const [addingDoc, setAddingDoc] = useState(false);

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [statsData, listData] = await Promise.all([
        knowledgeApi.getStats(),
        knowledgeApi.list({ limit: 50 }),
      ]);
      setStats(statsData);
      setKnowledgeBases(listData.knowledgeBases);
    } catch (error) {
      console.error("Failed to load knowledge data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ---------------------------------------------------------------------------
  // Expand / collapse a knowledge base to show its documents
  // ---------------------------------------------------------------------------

  async function toggleExpand(kbId: string) {
    if (expandedKbId === kbId) {
      setExpandedKbId(null);
      setExpandedDocs([]);
      return;
    }
    try {
      setDocsLoading(true);
      setExpandedKbId(kbId);
      const data = await knowledgeApi.getDocuments(kbId, { limit: 50 });
      setExpandedDocs(data.documents);
    } catch (error) {
      console.error("Failed to load documents:", error);
      setExpandedDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Create knowledge base
  // ---------------------------------------------------------------------------

  async function handleCreateKb() {
    if (!createForm.name.trim()) return;
    try {
      setCreating(true);
      await knowledgeApi.create({
        name: createForm.name,
        description: createForm.description,
        embeddingModel: createForm.embeddingModel,
        chunkSize: createForm.chunkSize,
        chunkOverlap: createForm.chunkOverlap,
      });
      setShowCreateModal(false);
      setCreateForm({
        name: "",
        description: "",
        embeddingModel: "text-embedding-3-small",
        chunkSize: 512,
        chunkOverlap: 50,
      });
      await loadData();
    } catch (error) {
      console.error("Failed to create knowledge base:", error);
      toast.error(getErrorMessage(error, "Failed to create knowledge base"));
    } finally {
      setCreating(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Delete knowledge base
  // ---------------------------------------------------------------------------

  async function handleDeleteKb(kbId: string) {
    if (!(await confirmAction({ title: "Delete this knowledge base and all its documents?", destructive: true }))) {
      return;
    }
    try {
      await knowledgeApi.delete(kbId);
      if (expandedKbId === kbId) {
        setExpandedKbId(null);
        setExpandedDocs([]);
      }
      await loadData();
    } catch (error) {
      console.error("Failed to delete knowledge base:", error);
    }
  }

  // ---------------------------------------------------------------------------
  // Add document
  // ---------------------------------------------------------------------------

  async function handleAddDocument() {
    if (!addDocKbId || !docForm.title.trim() || !docForm.content.trim()) return;
    try {
      setAddingDoc(true);
      const tags = docForm.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await knowledgeApi.addDocument(addDocKbId, {
        title: docForm.title,
        content: docForm.content,
        sourceType: docForm.sourceType,
        tags: tags.length > 0 ? tags : undefined,
      });
      setShowAddDocModal(false);
      setDocForm({ title: "", content: "", sourceType: "text", tags: "" });
      // Refresh the expanded docs if this KB is expanded
      if (expandedKbId === addDocKbId) {
        const data = await knowledgeApi.getDocuments(addDocKbId, { limit: 50 });
        setExpandedDocs(data.documents);
      }
      await loadData();
    } catch (error) {
      console.error("Failed to add document:", error);
      toast.error(getErrorMessage(error, "Failed to add document"));
    } finally {
      setAddingDoc(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Delete document
  // ---------------------------------------------------------------------------

  async function handleDeleteDoc(kbId: string, docId: string) {
    if (!(await confirmAction({ title: "Delete this document?", destructive: true }))) return;
    try {
      await knowledgeApi.deleteDocument(kbId, docId);
      setExpandedDocs((prev) => prev.filter((d) => d.id !== docId));
      await loadData();
    } catch (error) {
      console.error("Failed to delete document:", error);
    }
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async function handleSearch() {
    if (!searchKbId || !searchQuery.trim()) return;
    try {
      setSearching(true);
      const data = await knowledgeApi.search(searchKbId, searchQuery, 10);
      setSearchResults(data.results);
      setSearchTotal(data.totalChunksSearched);
    } catch (error) {
      console.error("Search failed:", error);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading spinner
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 text-primary animate-spin" />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary tracking-wide">
            Knowledge Bases
          </h1>
          <p className="text-gray-400 mt-1">
            Manage RAG knowledge bases, documents, and semantic search
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary border border-primary/30 rounded-lg hover:bg-primary/20 transition-colors font-medium"
        >
          <Plus className="h-4 w-4" />
          New Knowledge Base
        </button>
      </div>

      {/* Stats Row */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            icon={Database}
            label="Total Bases"
            value={stats.totalBases}
          />
          <StatCard
            icon={FileText}
            label="Total Documents"
            value={stats.totalDocuments}
          />
          <StatCard
            icon={Layers}
            label="Total Chunks"
            value={stats.totalChunks}
          />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        <button
          onClick={() => setActiveTab("bases")}
          className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
            activeTab === "bases"
              ? "text-primary"
              : "text-muted-foreground hover:text-gray-300"
          }`}
        >
          Knowledge Bases
          {activeTab === "bases" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("search")}
          className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
            activeTab === "search"
              ? "text-primary"
              : "text-muted-foreground hover:text-gray-300"
          }`}
        >
          Search
          {activeTab === "search" && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
          )}
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "bases" && (
        <KnowledgeBasesTab
          knowledgeBases={knowledgeBases}
          expandedKbId={expandedKbId}
          expandedDocs={expandedDocs}
          docsLoading={docsLoading}
          onToggleExpand={toggleExpand}
          onDeleteKb={handleDeleteKb}
          onDeleteDoc={handleDeleteDoc}
          onAddDoc={(kbId) => {
            setAddDocKbId(kbId);
            setShowAddDocModal(true);
          }}
          onCreateNew={() => setShowCreateModal(true)}
        />
      )}

      {activeTab === "search" && (
        <SearchTab
          knowledgeBases={knowledgeBases}
          searchQuery={searchQuery}
          searchKbId={searchKbId}
          searchResults={searchResults}
          searchTotal={searchTotal}
          searching={searching}
          onQueryChange={setSearchQuery}
          onKbChange={setSearchKbId}
          onSearch={handleSearch}
        />
      )}

      {/* Create KB Modal */}
      {showCreateModal && (
        <Modal onClose={() => setShowCreateModal(false)} title="Create Knowledge Base">
          <div className="space-y-4">
            <FieldGroup label="Name">
              <input
                type="text"
                value={createForm.name}
                onChange={(e) =>
                  setCreateForm({ ...createForm, name: e.target.value })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-gray-200 placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                placeholder="My Knowledge Base"
              />
            </FieldGroup>
            <FieldGroup label="Description">
              <textarea
                value={createForm.description}
                onChange={(e) =>
                  setCreateForm({ ...createForm, description: e.target.value })
                }
                rows={3}
                className="w-full px-3 py-2 bg-background border border-input rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 resize-none"
                placeholder="Describe what this knowledge base contains..."
              />
            </FieldGroup>
            <FieldGroup label="Embedding Model">
              <select
                value={createForm.embeddingModel}
                onChange={(e) =>
                  setCreateForm({ ...createForm, embeddingModel: e.target.value })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-gray-200 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
              >
                <option value="text-embedding-3-small">text-embedding-3-small</option>
                <option value="text-embedding-3-large">text-embedding-3-large</option>
                <option value="text-embedding-ada-002">text-embedding-ada-002</option>
              </select>
            </FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <FieldGroup label="Chunk Size">
                <input
                  type="number"
                  value={createForm.chunkSize}
                  onChange={(e) =>
                    setCreateForm({
                      ...createForm,
                      chunkSize: parseInt(e.target.value, 10) || 0,
                    })
                  }
                  min={64}
                  max={8192}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-gray-200 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                />
              </FieldGroup>
              <FieldGroup label="Chunk Overlap">
                <input
                  type="number"
                  value={createForm.chunkOverlap}
                  onChange={(e) =>
                    setCreateForm({
                      ...createForm,
                      chunkOverlap: parseInt(e.target.value, 10) || 0,
                    })
                  }
                  min={0}
                  max={1024}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-gray-200 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                />
              </FieldGroup>
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={() => setShowCreateModal(false)}
              className="px-4 py-2 text-gray-400 hover:text-gray-200 hover:bg-muted rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateKb}
              disabled={!createForm.name.trim() || creating}
              className="flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary border border-primary/30 rounded-lg hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Create
            </button>
          </div>
        </Modal>
      )}

      {/* Add Document Modal */}
      {showAddDocModal && addDocKbId && (
        <Modal onClose={() => setShowAddDocModal(false)} title="Add Document">
          <div className="space-y-4">
            <FieldGroup label="Title">
              <input
                type="text"
                value={docForm.title}
                onChange={(e) =>
                  setDocForm({ ...docForm, title: e.target.value })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-gray-200 placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                placeholder="Document title"
              />
            </FieldGroup>
            <FieldGroup label="Content">
              <textarea
                value={docForm.content}
                onChange={(e) =>
                  setDocForm({ ...docForm, content: e.target.value })
                }
                rows={6}
                className="w-full px-3 py-2 bg-background border border-input rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 resize-none font-mono text-sm"
                placeholder="Paste or type document content..."
              />
            </FieldGroup>
            <FieldGroup label="Source Type">
              <select
                value={docForm.sourceType}
                onChange={(e) =>
                  setDocForm({ ...docForm, sourceType: e.target.value })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-gray-200 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
              >
                <option value="text">Text</option>
                <option value="url">URL</option>
                <option value="file">File</option>
              </select>
            </FieldGroup>
            <FieldGroup label="Tags (comma-separated)">
              <input
                type="text"
                value={docForm.tags}
                onChange={(e) =>
                  setDocForm({ ...docForm, tags: e.target.value })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-gray-200 placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                placeholder="docs, api, guide"
              />
            </FieldGroup>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={() => setShowAddDocModal(false)}
              className="px-4 py-2 text-gray-400 hover:text-gray-200 hover:bg-muted rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAddDocument}
              disabled={!docForm.title.trim() || !docForm.content.trim() || addingDoc}
              className="flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary border border-primary/30 rounded-lg hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {addingDoc && <Loader2 className="h-4 w-4 animate-spin" />}
              Add Document
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ===========================================================================
// Knowledge Bases Tab
// ===========================================================================

function KnowledgeBasesTab({
  knowledgeBases,
  expandedKbId,
  expandedDocs,
  docsLoading,
  onToggleExpand,
  onDeleteKb,
  onDeleteDoc,
  onAddDoc,
  onCreateNew,
}: {
  knowledgeBases: KnowledgeBase[];
  expandedKbId: string | null;
  expandedDocs: KnowledgeDocument[];
  docsLoading: boolean;
  onToggleExpand: (id: string) => void;
  onDeleteKb: (id: string) => void;
  onDeleteDoc: (kbId: string, docId: string) => void;
  onAddDoc: (kbId: string) => void;
  onCreateNew: () => void;
}) {
  if (knowledgeBases.length === 0) {
    return (
      <div className="text-center py-16">
        <Database className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-300 mb-2">
          No knowledge bases yet
        </h3>
        <p className="text-muted-foreground mb-6">
          Create your first knowledge base to start adding documents and enable semantic search.
        </p>
        <button
          onClick={onCreateNew}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary border border-primary/30 rounded-lg hover:bg-primary/20 transition-colors font-medium"
        >
          <Plus className="h-4 w-4" />
          New Knowledge Base
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {knowledgeBases.map((kb) => {
        const isExpanded = expandedKbId === kb.id;
        return (
          <div
            key={kb.id}
            className="rounded-xl border border-border bg-card transition-all duration-200 hover:border-primary/20"
          >
            {/* Card header */}
            <button
              onClick={() => onToggleExpand(kb.id)}
              className="w-full px-5 py-4 flex items-start gap-4 text-left"
            >
              <div className="mt-0.5 text-muted-foreground">
                {isExpanded ? (
                  <ChevronDown className="h-5 w-5 text-primary" />
                ) : (
                  <ChevronRight className="h-5 w-5" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h3 className="font-semibold text-gray-100 truncate">
                    {kb.name}
                  </h3>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${statusClasses(
                      kb.status
                    )}`}
                  >
                    {kb.status}
                  </span>
                </div>

                {kb.description && (
                  <p className="text-sm text-gray-400 mt-1 line-clamp-2">
                    {kb.description}
                  </p>
                )}

                <div className="flex items-center gap-5 mt-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <FileText className="h-3.5 w-3.5" />
                    {kb.totalDocuments} document{kb.totalDocuments !== 1 ? "s" : ""}
                  </span>
                  <span className="flex items-center gap-1">
                    <Layers className="h-3.5 w-3.5" />
                    {kb.totalChunks} chunk{kb.totalChunks !== 1 ? "s" : ""}
                  </span>
                  <span className="flex items-center gap-1">
                    <Sparkles className="h-3.5 w-3.5" />
                    {kb.embeddingModel}
                  </span>
                  <span className="hidden sm:flex items-center gap-1">
                    <Hash className="h-3.5 w-3.5" />
                    {kb.chunkSize} / {kb.chunkOverlap}
                  </span>
                </div>
              </div>

              <div
                className="shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => onDeleteKb(kb.id)}
                  className="p-2 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  title="Delete knowledge base"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </button>

            {/* Expanded documents section */}
            {isExpanded && (
              <div className="border-t border-border px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-medium text-gray-300">Documents</h4>
                  <button
                    onClick={() => onAddDoc(kb.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary/10 text-primary border border-primary/30 rounded-md hover:bg-primary/20 transition-colors font-medium"
                  >
                    <Plus className="h-3 w-3" />
                    Add Document
                  </button>
                </div>

                {docsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 text-primary animate-spin" />
                  </div>
                ) : expandedDocs.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    <BookOpen className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                    No documents yet. Add one to get started.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {expandedDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-background border border-border/60"
                      >
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-200 truncate">
                            {doc.title}
                          </p>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${statusClasses(
                                doc.status
                              )}`}
                            >
                              {doc.status}
                            </span>
                            <span>{doc.sourceType}</span>
                            <span>{doc.chunkCount} chunks</span>
                            <span>{formatBytes(doc.sizeBytes)}</span>
                            {doc.tags.length > 0 && (
                              <span className="text-primary">
                                {doc.tags.join(", ")}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => onDeleteDoc(kb.id, doc.id)}
                          className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded transition-colors shrink-0"
                          title="Delete document"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ===========================================================================
// Search Tab
// ===========================================================================

function SearchTab({
  knowledgeBases,
  searchQuery,
  searchKbId,
  searchResults,
  searchTotal,
  searching,
  onQueryChange,
  onKbChange,
  onSearch,
}: {
  knowledgeBases: KnowledgeBase[];
  searchQuery: string;
  searchKbId: string;
  searchResults: SearchResult[];
  searchTotal: number;
  searching: boolean;
  onQueryChange: (v: string) => void;
  onKbChange: (v: string) => void;
  onSearch: () => void;
}) {
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      onSearch();
    }
  }

  return (
    <div className="space-y-5">
      {/* Search controls */}
      <div className="flex flex-col sm:flex-row gap-3">
        <select
          value={searchKbId}
          onChange={(e) => onKbChange(e.target.value)}
          className="px-3 py-2 bg-background border border-border rounded-lg text-gray-200 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 sm:w-64"
        >
          <option value="">Select Knowledge Base</option>
          {knowledgeBases.map((kb) => (
            <option key={kb.id} value={kb.id}>
              {kb.name}
            </option>
          ))}
        </select>

        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter your semantic search query..."
            className="w-full pl-10 pr-4 py-2 bg-background border border-border rounded-lg text-gray-200 placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
          />
        </div>

        <button
          onClick={onSearch}
          disabled={!searchKbId || !searchQuery.trim() || searching}
          className="flex items-center justify-center gap-2 px-5 py-2 bg-primary/10 text-primary border border-primary/30 rounded-lg hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium shrink-0"
        >
          {searching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Search
        </button>
      </div>

      {/* Results */}
      {searchResults.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} found
            {searchTotal > 0 && (
              <span> &middot; {searchTotal} chunks searched</span>
            )}
          </p>

          {searchResults.map((result, idx) => (
            <div
              key={`${result.chunkId}-${idx}`}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium text-gray-200">
                    {result.documentTitle}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Chunk #{result.chunkIndex}
                  </span>
                </div>
                <ScoreBadge score={result.score} />
              </div>
              <p className="text-sm text-gray-400 leading-relaxed whitespace-pre-wrap line-clamp-4">
                {result.content}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Empty state for search */}
      {!searching && searchResults.length === 0 && searchQuery.trim() && searchKbId && (
        <div className="text-center py-12">
          <AlertCircle className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-gray-400">No results found for your query.</p>
        </div>
      )}

      {!searchKbId && (
        <div className="text-center py-12">
          <Search className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-gray-400">
            Select a knowledge base and enter a query to search.
          </p>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Shared sub-components
// ===========================================================================

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
          <p className="text-xl font-bold text-gray-100">{value}</p>
        </div>
      </div>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  let color = "text-gray-400 border-gray-600";
  if (pct >= 80) {
    color = "text-green-400 border-green-500/40 bg-green-500/10";
  } else if (pct >= 60) {
    color = "text-yellow-400 border-yellow-500/40 bg-yellow-500/10";
  } else if (pct >= 40) {
    color = "text-orange-400 border-orange-500/40 bg-orange-500/10";
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border ${color}`}
    >
      {score.toFixed(3)}
    </span>
  );
}

function Modal({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-card border border-border rounded-xl p-6 w-full max-w-lg mx-4 shadow-2xl shadow-black/50">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-gray-100">{title}</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-gray-300 hover:bg-background rounded-lg transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-400 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

// ===========================================================================
// Utilities
// ===========================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
