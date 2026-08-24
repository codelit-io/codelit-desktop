import { Download, Search, Table2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { LocalBotTableView } from "../contracts";

function displayValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export default function BotDataTableArtifact({
  view,
  exporting,
  onExport,
  onClose,
}: {
  view: LocalBotTableView;
  exporting: boolean;
  onExport: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return view.rows;
    return view.rows.filter((row) => view.table.columns.some((column) => (
      displayValue(row.values[column.name]).toLowerCase().includes(query)
    )));
  }, [filter, view.rows, view.table.columns]);

  return (
    <section className="bot-data-artifact" aria-labelledby={`bot-data-title-${view.table.id}`}>
      <header>
        <span className="bot-data-icon"><Table2 size={16} /></span>
        <div>
          <strong id={`bot-data-title-${view.table.id}`}>{view.table.name}</strong>
          <small>{view.totalRows} {view.totalRows === 1 ? "row" : "rows"}, stored only on this Mac</small>
        </div>
        <button
          type="button"
          className="bots-icon-button"
          onClick={onExport}
          disabled={exporting}
          aria-label={`Export ${view.table.name} as CSV`}
          title="Export CSV"
        >
          <Download size={15} />
        </button>
        <button
          type="button"
          className="bots-icon-button"
          onClick={onClose}
          aria-label={`Close ${view.table.name}`}
          title="Close table"
        >
          <X size={15} />
        </button>
      </header>
      {view.totalRows > 0 && (
        <label className="bot-data-filter">
          <Search size={14} />
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter rows"
            aria-label={`Filter ${view.table.name}`}
          />
        </label>
      )}
      <div className="bot-data-table-scroll">
        <table>
          <thead>
            <tr>
              {view.table.columns.map((column) => (
                <th key={column.name} scope="col">
                  <span>{column.name}</span>
                  <small>{column.type}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {view.table.columns.map((column) => (
                  <td key={column.name}>{displayValue(row.values[column.name])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.totalRows === 0 && <p className="bot-data-empty">This table is ready for its first row.</p>}
      {view.totalRows > 0 && rows.length === 0 && <p className="bot-data-empty">No rows match this filter.</p>}
      {view.truncated && <small className="bot-data-limit">Showing the newest {view.rows.length} rows. Export includes all rows.</small>}
    </section>
  );
}
