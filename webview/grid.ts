// webview/grid.ts
// Virtual scroll grid for Results Panel — TASK-006.
//
// Features:
// - Chỉ render rows trong viewport (windowing ~30 rows).
// - Sticky header via position: sticky on thead (parent scroll container).
// - NULL xám; số căn phải; selection + copy tab-separated.
// - Callback onLoadMore khi scroll gần cuối.
//
// IMPORTANT (fix round 1):
// - Header table is now properly appended to the DOM (was missing — thead
//   was built but never attached, causing setColumns() to match body table).
// - Column widths synced via table-layout: fixed on both header and body tables.

export interface GridColumn {
  name: string;
  /** Type hint: "number" → align right. */
  type?: "number" | "string" | "boolean" | "date" | "other";
  /** Optional explicit width (CSS string, e.g. "120px"). */
  width?: string;
}

export interface GridCallbacks {
  /** User request load more (scroll to bottom). */
  onLoadMore?: () => void;
  /** User copies selected cells/rows as tab-separated. */
  onCopy?: (text: string) => void;
}

const ROW_HEIGHT = 22; // px
const OVERSCAN = 5; // rows above/below viewport
const DEFAULT_MIN_WIDTH = "80px";

export class VirtualGrid {
  private readonly root: HTMLElement;
  private readonly headerTableEl: HTMLTableElement;
  private readonly scrollEl: HTMLElement;
  private readonly viewportEl: HTMLElement;
  private readonly spacerEl: HTMLElement;
  private readonly bodyTableEl: HTMLTableElement;
  private readonly footerEl: HTMLElement;
  private columns: GridColumn[] = [];
  private rows: any[][] = [];
  private callbacks: GridCallbacks = {};
  private totalRows: number | null = null;
  private hasMore: boolean = false;
  private rafId: number | null = null;
  private loadMoreInFlight: boolean = false;

  constructor(root: HTMLElement, columns: GridColumn[], callbacks: GridCallbacks = {}) {
    this.root = root;
    this.callbacks = callbacks;
    this.columns = columns.slice();
    this.root.innerHTML = "";
    this.root.classList.add("vsdb-grid-container");

    // ---- Header table (sticky via position: sticky on thead) ----
    this.headerTableEl = document.createElement("table");
    this.headerTableEl.className = "vsdb-grid vsdb-header";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of this.columns) {
      const th = document.createElement("th");
      th.textContent = col.name;
      if (col.type === "number") th.classList.add("vsdb-num");
      if (col.width) th.style.width = col.width;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    this.headerTableEl.appendChild(thead);

    // ---- Scroll container with body table ----
    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "vsdb-scroll";
    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "vsdb-viewport";
    this.spacerEl = document.createElement("div");
    this.spacerEl.className = "vsdb-spacer";
    this.bodyTableEl = document.createElement("table");
    this.bodyTableEl.className = "vsdb-grid vsdb-body";
    const tbodyBody = document.createElement("tbody");
    this.bodyTableEl.appendChild(tbodyBody);

    this.viewportEl.appendChild(this.spacerEl);
    this.scrollEl.appendChild(this.viewportEl);
    this.scrollEl.appendChild(this.bodyTableEl);

    // ---- Append header + scroll + footer in order ----
    this.root.appendChild(this.headerTableEl);
    this.root.appendChild(this.scrollEl);

    this.footerEl = document.createElement("div");
    this.footerEl.className = "vsdb-footer";
    this.root.appendChild(this.footerEl);

    // Wire scroll.
    this.scrollEl.addEventListener("scroll", () => this.requestRender());
    // Window resize → re-render.
    window.addEventListener("resize", () => this.requestRender());

    // Keyboard copy.
    this.root.addEventListener("keydown", (e) => this.handleKeydown(e));
    this.root.tabIndex = 0; // focusable for keyboard.
  }

  /**
   * Cập nhật dữ liệu. `totalRows` dùng cho spacer height; nếu null → dùng rows.length.
   */
  setData(rows: any[][], totalRows: number | null, hasMore: boolean): void {
    this.rows = rows;
    this.totalRows = totalRows;
    this.hasMore = hasMore;
    this.updateFooter();
    this.spacerEl.style.height = `${(totalRows ?? rows.length) * ROW_HEIGHT}px`;
    this.requestRender();
  }

  setColumns(columns: GridColumn[]): void {
    // Rebuild header only if column set actually changed.
    const same =
      columns.length === this.columns.length &&
      columns.every((c, i) => c.name === this.columns[i].name);
    if (same) return;
    this.columns = columns.slice();

    // Rebuild header thead.
    const old = this.headerTableEl.querySelector("thead");
    if (old) old.remove();
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const col of this.columns) {
      const th = document.createElement("th");
      th.textContent = col.name;
      if (col.type === "number") th.classList.add("vsdb-num");
      if (col.width) th.style.width = col.width;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    this.headerTableEl.appendChild(thead);
    this.requestRender();
  }

  /**
   * Mark whether a loadMore is currently in-flight. Used to throttle the
   * scroll-driven loadMore trigger (fix round 1 — IMPORTANT #3).
   */
  setLoadMoreInFlight(inFlight: boolean): void {
    this.loadMoreInFlight = inFlight;
  }

  setCallbacks(cb: GridCallbacks): void {
    this.callbacks = cb;
  }

  private getSelectedRows(): any[][] {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return [];
    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents();
    const rows: any[][] = [];
    const trs = fragment.querySelectorAll("tr");
    trs.forEach((tr) => {
      const cells: any[] = [];
      tr.querySelectorAll("td").forEach((td) => {
        cells.push(td.textContent ?? "");
      });
      if (cells.length > 0) rows.push(cells);
    });
    return rows;
  }

  private handleKeydown(e: KeyboardEvent): void {
    const isCopy = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c";
    if (!isCopy) return;
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) {
      e.preventDefault();
      const rows = this.getSelectedRows();
      if (rows.length > 0) {
        const text = rows.map((r) => r.map((c) => formatCell(c)).join("\t")).join("\n");
        if (this.callbacks.onCopy) {
          this.callbacks.onCopy(text);
        } else {
          navigator.clipboard.writeText(text).catch(() => {});
        }
      }
    }
  }

  private requestRender(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private render(): void {
    const scrollTop = this.scrollEl.scrollTop;
    const viewportHeight = this.scrollEl.clientHeight || 400;
    const total = this.totalRows ?? this.rows.length;
    let startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    let endIdx = Math.min(
      total,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
    );

    if (endIdx > this.rows.length) endIdx = this.rows.length;
    if (startIdx > endIdx) startIdx = endIdx;

    const offsetY = startIdx * ROW_HEIGHT;

    const tbody = this.bodyTableEl.querySelector("tbody") as HTMLElement;
    tbody.innerHTML = "";
    tbody.style.transform = `translateY(${offsetY}px)`;

    for (let i = startIdx; i < endIdx; i++) {
      const tr = document.createElement("tr");
      const row = this.rows[i] ?? [];
      for (let c = 0; c < this.columns.length; c++) {
        const td = document.createElement("td");
        const val = row[c];
        if (val === null || val === undefined) {
          td.textContent = "NULL";
          td.classList.add("vsdb-null");
        } else {
          td.textContent = formatCell(val);
        }
        if (this.columns[c].type === "number") td.classList.add("vsdb-num");
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    // Trigger load-more khi gần cuối — throttle nếu đang in-flight.
    if (this.hasMore && !this.loadMoreInFlight) {
      const remaining = scrollTop + viewportHeight;
      const totalHeight = total * ROW_HEIGHT;
      if (totalHeight - remaining < 200) {
        if (this.callbacks.onLoadMore) this.callbacks.onLoadMore();
      }
    }
  }

  private updateFooter(): void {
    const loaded = this.rows.length;
    const total = this.totalRows ?? loaded;
    if (this.totalRows === null) {
      this.footerEl.textContent = `${loaded} rows`;
    } else {
      this.footerEl.textContent = `${loaded} of ${total}`;
    }
  }
}

/**
 * Format 1 cell value thành string hiển thị / copy.
 * - BigInt → string.
 * - Date → ISO.
 * - Object → JSON.
 */
export function formatCell(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
