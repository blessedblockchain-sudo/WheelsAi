import { CopyTextButton, ResultView } from "@/components/ui/result-view";
import { PUBLIC_USE_MESSAGES } from "@/lib/public-use";
import { LocalTime } from "./local-time";

export interface PublicResult {
  finishedAt: string;
  text: string;
}

export interface PublicResultsPanelProps {
  /** Whether the owner shows this agent's results on its page. */
  resultsPublic: boolean;
  /** The latest results, newest first. */
  latest: PublicResult[];
}

/** What a self-running agent last produced, when its owner shows it. */
export function PublicResultsPanel({ resultsPublic, latest }: PublicResultsPanelProps) {
  if (!resultsPublic) {
    return <p className="p-4 text-sm text-muted-foreground sm:p-5">{PUBLIC_USE_MESSAGES.resultsPrivate}</p>;
  }
  if (latest.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground sm:p-5">{PUBLIC_USE_MESSAGES.noResults}</p>;
  }
  return (
    <ol className="divide-y">
      {latest.map((result, index) => (
        <li key={`${result.finishedAt}-${index}`} className="space-y-2 p-4 sm:p-5">
          <div className="flex min-h-7 items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <LocalTime iso={result.finishedAt} />
            </p>
            <CopyTextButton text={result.text} />
          </div>
          <ResultView text={result.text} />
        </li>
      ))}
    </ol>
  );
}
