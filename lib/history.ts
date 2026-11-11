import Database from "better-sqlite3";
import * as path from "path";
import { mkdirSync, writeFileSync } from "fs";

// First persistent store in this app — everything else (processJobs, bankJobs, medicalJobs,
// medicalCertJobs, payslipJobs) is an in-memory Map with TTL eviction (see lib/jobs/shared.ts).
// Runs on the deploying VPS's own disk (not Cloud Run — no ephemeral-filesystem concern), so a
// single SQLite file + a sibling images/ directory is enough; no separate database server needed.
export const DATA_DIR = process.env.HISTORY_DATA_DIR || path.join(__dirname, "..", "data");
export const HISTORY_IMAGES_DIR = path.join(DATA_DIR, "images");
mkdirSync(HISTORY_IMAGES_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "history.sqlite"));
db.pragma("journal_mode = WAL"); // history-list reads shouldn't block a scan's persist write

// One unified table (not 5 normalized ones) — nothing here needs to SQL-filter on a scan's
// *contents*, only user_id/created_at for the list view and id for detail fetch, so a flexible
// result_json blob is simpler and keeps the list query fast regardless of how large any one
// scan's payload is. user_fullname/user_email are a deliberate snapshot of the camans JWT at
// scan time, not a live join — camans' User table lives in a completely different service/DB.
db.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id              TEXT PRIMARY KEY,
    scan_type       TEXT NOT NULL,
    user_id         INTEGER NOT NULL,
    user_fullname   TEXT NOT NULL,
    user_email      TEXT NOT NULL,
    title           TEXT,
    result_json     TEXT NOT NULL,
    cost_usd        REAL,
    duration_ms     INTEGER,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scans_user_created ON scans (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_scans_user_type_created ON scans (user_id, scan_type, created_at DESC);
`);

export type ScanType = "timesheet" | "bank_statement" | "medical_bills" | "medical_certificates" | "payslips";

export type ScanRow = {
    id: string;
    scan_type: ScanType;
    user_id: number;
    user_fullname: string;
    user_email: string;
    title: string | null;
    result_json: string;
    cost_usd: number | null;
    duration_ms: number | null;
    created_at: string;
};

export type ScanListRow = Omit<ScanRow, "user_id" | "user_fullname" | "user_email" | "result_json">;

export type PersistScanOpts = {
    id: string; // reuses the job's own randomUUID() — one less id to track between live job and history record
    scanType: ScanType;
    userId: number;
    userFullname: string;
    userEmail: string;
    title: string | null;
    costUsd: number | null;
    durationMs: number | null;
    // The job's finished `result` object, images still inline as base64 — NOT mutated by this
    // function (deep-cloned internally), since the caller's in-memory job.result may still be
    // actively served to a live poller when this runs.
    result: Record<string, unknown>;
    // Only the 4 non-timesheet scan types carry their page images on job.pages rather than
    // inside job.result — passed separately so persistScan can fold them into the stored envelope
    // as `result.pages` (matching what those types' render functions expect, see public/index.html).
    pages?: { image: string; [k: string]: unknown }[];
    // Timesheet-only: the separate IPA letter page image, not part of pageReviews.
    ipaImage?: string | null;
};

/**
 * Writes a finished scan's page images to disk and its (image-stripped) result to the `scans`
 * table. Never throws — a persistence failure must not surface as a scan failure to the
 * caseworker; the live in-memory job result already exists regardless, history is additive.
 */
export function persistScan(opts: PersistScanOpts): void {
    try {
        const cloned = JSON.parse(JSON.stringify(opts.result)) as Record<string, unknown>;
        const scanImagesDir = path.join(HISTORY_IMAGES_DIR, opts.id);
        mkdirSync(scanImagesDir, { recursive: true });

        // Writes raw decoded PNG bytes (the in-memory `image` field is already a sharp(...).png()
        // buffer re-encoded as base64 — see lib/ocr/images.ts's resizeForDisplay — so this is a
        // direct decode-and-write, no re-encoding) and returns the `{ref}` marker that replaces the
        // base64 string in result_json. Rewritten to a real URL at GET time, not here — see
        // rehydrateImageRefs below — so the route prefix never gets baked into stored data.
        const writeImage = (ref: string, base64: string): { ref: string } => {
            writeFileSync(path.join(scanImagesDir, `${ref}.png`), Buffer.from(base64, "base64"));
            return { ref };
        };

        if (opts.scanType === "timesheet") {
            const pageReviews = cloned.pageReviews as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(pageReviews)) {
                pageReviews.forEach((p, i) => {
                    if (typeof p.image === "string") p.image = writeImage(`page-${i}`, p.image);
                });
            }
            if (typeof opts.ipaImage === "string" && opts.ipaImage) {
                cloned.ipaImage = writeImage("ipa", opts.ipaImage);
            }
        } else if (opts.pages) {
            const clonedPages = JSON.parse(JSON.stringify(opts.pages)) as Array<Record<string, unknown>>;
            clonedPages.forEach((p, i) => {
                if (typeof p.image === "string") p.image = writeImage(`page-${i}`, p.image);
            });
            cloned.pages = clonedPages;
        }

        db.prepare(
            `INSERT INTO scans (id, scan_type, user_id, user_fullname, user_email, title, result_json, cost_usd, duration_ms)
             VALUES (@id, @scanType, @userId, @userFullname, @userEmail, @title, @resultJson, @costUsd, @durationMs)`
        ).run({
            id: opts.id,
            scanType: opts.scanType,
            userId: opts.userId,
            userFullname: opts.userFullname,
            userEmail: opts.userEmail,
            title: opts.title,
            resultJson: JSON.stringify(cloned),
            costUsd: opts.costUsd,
            durationMs: opts.durationMs,
        });
    } catch (e) {
        console.error(`persistScan(${opts.id}, ${opts.scanType}) failed — this scan was not saved to history:`, e);
    }
}

/** Lists a user's scans, most recent first, for the history list view. Never includes `result_json` — kept small regardless of how large any one scan's payload is. */
export function listScansForUser(userId: number, opts: { limit: number; offset: number; scanType?: string }): { rows: ScanListRow[]; total: number } {
    const whereType = opts.scanType ? "AND scan_type = @scanType" : "";
    const rows = db
        .prepare(
            `SELECT id, scan_type, title, cost_usd, duration_ms, created_at
             FROM scans WHERE user_id = @userId ${whereType} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
        )
        .all({ userId, scanType: opts.scanType ?? null, limit: opts.limit, offset: opts.offset }) as ScanListRow[];
    const total = (
        db.prepare(`SELECT COUNT(*) as c FROM scans WHERE user_id = @userId ${whereType}`).get({ userId, scanType: opts.scanType ?? null }) as { c: number }
    ).c;
    return { rows, total };
}

/** Full saved record, or null if it doesn't exist OR belongs to a different user — same 404 either way, no existence leak. */
export function getScanForOwner(id: string, userId: number): ScanRow | null {
    const row = db.prepare(`SELECT * FROM scans WHERE id = @id AND user_id = @userId`).get({ id, userId }) as ScanRow | undefined;
    return row ?? null;
}

export type AdminScanListRow = ScanListRow & { user_fullname: string; user_email: string };

/** Lists scans across every user (admin dashboard) — optionally scoped to one user_id for drill-down. Never includes result_json. */
export function listAllScans(opts: { limit: number; offset: number; scanType?: string; userId?: number }): { rows: AdminScanListRow[]; total: number } {
    const conditions = [opts.scanType ? "scan_type = @scanType" : null, opts.userId !== undefined ? "user_id = @userId" : null].filter((c): c is string => c !== null);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const params = { scanType: opts.scanType ?? null, userId: opts.userId ?? null, limit: opts.limit, offset: opts.offset };
    const rows = db
        .prepare(
            `SELECT id, scan_type, title, cost_usd, duration_ms, created_at, user_fullname, user_email
             FROM scans ${whereClause} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
        )
        .all(params) as AdminScanListRow[];
    const total = (db.prepare(`SELECT COUNT(*) as c FROM scans ${whereClause}`).get(params) as { c: number }).c;
    return { rows, total };
}

/**
 * Cost/count rollups for the admin dashboard. Rolling windows (today/last-7-days/calendar-month-
 * so-far/all-time) plus day/month trend breakdowns for the last 30 days / 12 months. `created_at`
 * is stored as a sortable ISO8601 string (see the schema above), which SQLite's date()/datetime()/
 * strftime() operate on directly — no separate date parsing needed.
 */
export function getCostSummary() {
    const one = (sql: string) => db.prepare(sql).get() as { total: number; count: number };
    const totalAllTime = one(`SELECT COALESCE(SUM(cost_usd),0) as total, COUNT(*) as count FROM scans`);
    const totalToday = one(`SELECT COALESCE(SUM(cost_usd),0) as total, COUNT(*) as count FROM scans WHERE date(created_at) = date('now')`);
    const totalThisWeek = one(`SELECT COALESCE(SUM(cost_usd),0) as total, COUNT(*) as count FROM scans WHERE created_at >= datetime('now','-7 days')`);
    const totalThisMonth = one(`SELECT COALESCE(SUM(cost_usd),0) as total, COUNT(*) as count FROM scans WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m','now')`);
    const byDay = db
        .prepare(
            `SELECT date(created_at) as bucket, COALESCE(SUM(cost_usd),0) as total, COUNT(*) as count
             FROM scans WHERE created_at >= datetime('now','-30 days') GROUP BY bucket ORDER BY bucket DESC`
        )
        .all() as { bucket: string; total: number; count: number }[];
    const byMonth = db
        .prepare(
            `SELECT strftime('%Y-%m', created_at) as bucket, COALESCE(SUM(cost_usd),0) as total, COUNT(*) as count
             FROM scans WHERE created_at >= datetime('now','-12 months') GROUP BY bucket ORDER BY bucket DESC`
        )
        .all() as { bucket: string; total: number; count: number }[];
    return { totalAllTime, totalToday, totalThisWeek, totalThisMonth, byDay, byMonth };
}

/** Same as getScanForOwner, but an admin can fetch ANY scan regardless of owner — used only by the two read (GET) routes, never by the edit (PUT) route (editing someone else's case data is a bigger trust decision this dashboard doesn't make). */
export function getScanForAdminOrOwner(id: string, userId: number, isAdmin: boolean): ScanRow | null {
    if (isAdmin) {
        const row = db.prepare(`SELECT * FROM scans WHERE id = @id`).get({ id }) as ScanRow | undefined;
        return row ?? null;
    }
    return getScanForOwner(id, userId);
}

// The one genuinely-editable array per scan type — timesheet's day-by-day rows, the other 4
// types' single flat entry/transaction list. Used to validate a PUT /api/history/:id body only
// ever touches the field it's actually allowed to (never scan_type, user_id, or an image field).
const EDITABLE_FIELD_BY_SCAN_TYPE: Record<ScanType, string> = {
    timesheet: "reviewRows",
    bank_statement: "transactions",
    medical_bills: "entries",
    medical_certificates: "entries",
    payslips: "entries",
};

/**
 * Persists an edit made while viewing a history record — e.g. a caseworker fixing a typo, then
 * reopening the same record later and expecting the fix to still be there. Scoped narrowly: only
 * the one editable array this scan type actually has (see EDITABLE_FIELD_BY_SCAN_TYPE) can be
 * replaced, nothing else in result_json is touched. No optimistic locking (last-write-wins) — a
 * single caseworker per claim in practice, not worth the complexity yet.
 *
 * @returns `true` if the scan was found (and owned by this user) and updated, `false` otherwise.
 */
export function updateScanEditableFields(id: string, userId: number, newRows: unknown[]): boolean {
    const scan = getScanForOwner(id, userId);
    if (!scan) return false;
    const field = EDITABLE_FIELD_BY_SCAN_TYPE[scan.scan_type];
    const result = JSON.parse(scan.result_json) as Record<string, unknown>;
    result[field] = newRows;
    db.prepare(`UPDATE scans SET result_json = @resultJson WHERE id = @id`).run({ id, resultJson: JSON.stringify(result) });
    return true;
}

// Recursively replaces every `{ref: string}` marker (and nothing else — a real object with other
// keys alongside `ref` is left alone) with the authenticated image-serving URL for that scan.
// Generic across every scan type's result shape on purpose: whatever shape future scan types take,
// an image field written via persistScan's writeImage() helper above is always exactly `{ref}`,
// so this never needs updating when a new scan type/image field is added.
export function rehydrateImageRefs(scanId: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map(v => rehydrateImageRefs(scanId, v));
    if (value !== null && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj);
        if (keys.length === 1 && keys[0] === "ref" && typeof obj.ref === "string") {
            return `/api/history/${scanId}/image/${obj.ref}`;
        }
        const out: Record<string, unknown> = {};
        for (const k of keys) out[k] = rehydrateImageRefs(scanId, obj[k]);
        return out;
    }
    return value;
}
