import { Download, FileDown, ShieldCheck, Trash2 } from "lucide-react";
import type { QuarantinedBrowserDownload } from "../contracts";

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.ceil(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MB`;
}

function sourceHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "approved website";
  }
}

export default function BotDownloadArtifacts({
  downloads,
  workingId,
  onRelease,
  onDelete,
}: {
  downloads: QuarantinedBrowserDownload[];
  workingId: string | null;
  onRelease: (download: QuarantinedBrowserDownload) => void;
  onDelete: (download: QuarantinedBrowserDownload) => void;
}) {
  return (
    <section className="bot-download-artifacts" aria-labelledby="bot-downloads-title">
      <header>
        <span className="bot-download-icon"><ShieldCheck size={16} /></span>
        <div>
          <strong id="bot-downloads-title">Downloads waiting for you</strong>
          <small>Quarantined locally. Bots cannot read or open these files.</small>
        </div>
      </header>
      <div className="bot-download-list">
        {downloads.map((download) => {
          const working = workingId === download.id;
          return (
            <article key={download.id}>
              <span className="bot-download-file"><FileDown size={16} /></span>
              <div>
                <strong>{download.fileName}</strong>
                <small>
                  {formatBytes(download.byteSize)} · {sourceHost(download.sourceUrl)} · {download.sha256.slice(0, 12)}
                </small>
              </div>
              <button
                type="button"
                className="bot-secondary-action bot-download-release"
                disabled={Boolean(workingId)}
                onClick={() => onRelease(download)}
              >
                {working ? <span className="spinner" /> : <Download size={14} />}
                Release…
              </button>
              <button
                type="button"
                className="bots-icon-button bot-download-delete"
                disabled={Boolean(workingId)}
                onClick={() => onDelete(download)}
                aria-label={`Delete quarantined ${download.fileName}`}
                title="Delete quarantined file"
              >
                <Trash2 size={15} />
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
