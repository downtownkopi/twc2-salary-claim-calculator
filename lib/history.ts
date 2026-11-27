import Database from "better-sqlite3";
import * as path from "path";
import { mkdirSync, writeFileSync } from "fs";
import { rm } from "fs/promises";

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

// A "claim" groups however many scan types (timesheet/bank/medical bills/medical certs/payslips)
// a caseworker attached in one combined "Extract details" submit, so history can show them all
// together on one page later — exactly how the live page already shows them all together right
// after that submit. One claims row per combined submit; `scans.claim_id` (below) points back to
// it. notes/title live here, not on `scans` — a caseworker's own annotation, independent of any
// one scan type, that should survive even if an individual scan type's result_json shape changes.
db.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    user_fullname   TEXT NOT NULL,
    user_email      TEXT NOT NULL,
    title           TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// `CREATE TABLE IF NOT EXISTS` above only applies to a brand-new DB file — an existing deployment's
// scans table predates this column, so it needs an explicit, idempotent ALTER TABLE instead.
// Nullable on purpose: every scan persisted before this change has claim_id = NULL, and every
// grouping query below treats `COALESCE(claim_id, id)` as "this scan's own group" — a legacy row
// groups as a singleton claim keyed by its own id, so old history keeps working with zero backfill.
{
    const existingCols = db.prepare(`PRAGMA table_info(scans)`).all() as { name: string }[];
    if (!existingCols.some(c => c.name === "claim_id")) {
        db.exec(`ALTER TABLE scans ADD COLUMN claim_id TEXT`);
    }
}

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
    claim_id: string | null;
};

export type ScanListRow = Omit<ScanRow, "user_id" | "user_fullname" | "user_email" | "result_json">;

export type ClaimRow = {
    id: string;
    user_id: number;
    user_fullname: string;
    user_email: string;
    title: string | null;
    notes: string | null;
    created_at: string;
};

export type PersistScanOpts = {
    id: string; // reuses the job's own randomUUID() — one less id to track between live job and history record
    // The shared id grouping this scan together with any OTHER scan types submitted in the same
    // "Extract details" click — see the `claims` table comment above. Always set by the caller
    // (server.ts calls ensureClaim() for this id before the job runner ever reaches persistScan).
    claimId: string;
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
            `INSERT INTO scans (id, scan_type, user_id, user_fullname, user_email, title, result_json, cost_usd, duration_ms, claim_id)
             VALUES (@id, @scanType, @userId, @userFullname, @userEmail, @title, @resultJson, @costUsd, @durationMs, @claimId)`
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
            claimId: opts.claimId,
        });
    } catch (e) {
        console.error(`persistScan(${opts.id}, ${opts.scanType}) failed — this scan was not saved to history:`, e);
    }
}

/**
 * Ensures a `claims` row exists for `claimId`, creating it if this is the first of possibly-several
 * scan-type POSTs from the same combined "Extract details" submit to reach the server. `INSERT OR
 * IGNORE` (not an existence check + conditional insert) deliberately makes the race between two of
 * those concurrent POSTs harmless — whichever lands first wins, the rest are no-ops against the
 * same row.
 */
export function ensureClaim(claimId: string, userId: number, userFullname: string, userEmail: string): void {
    db.prepare(
        `INSERT OR IGNORE INTO claims (id, user_id, user_fullname, user_email) VALUES (@id, @userId, @userFullname, @userEmail)`
    ).run({ id: claimId, userId, userFullname, userEmail });
}

// Keyed by a SCAN's own id (not a claim groupId) — used only by the image-serving route, which
// needs to resolve exactly one scan row (each scan type within a combined claim still has its own
// separate on-disk image directory, written under its own id by persistScan above) to confirm it
// exists before streaming a file from its directory. No ownership check, same "any authenticated
// user can view" openness the rest of the read-side history routes already have.
/** Single scan row by its own id, no ownership check, or `null` if it doesn't exist. */
export function getScanById(id: string): ScanRow | null {
    const row = db.prepare(`SELECT * FROM scans WHERE id = @id`).get({ id }) as ScanRow | undefined;
    return row ?? null;
}

/** Fetches every scan row belonging to one claim group, owner-scoped. `groupId` is `COALESCE(claim_id, id)` — a legacy (pre-claims) scan groups as a singleton keyed by its own id. */
function scansForGroup(groupId: string, userId?: number): ScanRow[] {
    const whereUser = userId !== undefined ? "AND user_id = @userId" : "";
    return db
        .prepare(`SELECT * FROM scans WHERE COALESCE(claim_id, id) = @groupId ${whereUser}`)
        .all({ groupId, userId: userId ?? null }) as ScanRow[];
}

/** Full claim (every underlying scan row + the claims row, if one exists yet), owner-scoped. Returns `null` if nothing matches at all. */
export function getClaimGroup(groupId: string, userId: number): { claim: ClaimRow | null; scans: ScanRow[] } | null {
    const scans = scansForGroup(groupId, userId);
    const claim = (db.prepare(`SELECT * FROM claims WHERE id = @groupId AND user_id = @userId`).get({ groupId, userId }) as ClaimRow | undefined) ?? null;
    if (scans.length === 0 && !claim) return null;
    return { claim, scans };
}

// No ownership check — mirrors the old getScanById's "any authenticated user can view" openness,
// for the admin dashboard / the general "View" action on someone else's claim.
/** Full claim, no ownership check — the ownership gate on edits/append/delete is unaffected. */
export function getClaimGroupAny(groupId: string): { claim: ClaimRow | null; scans: ScanRow[] } | null {
    const scans = scansForGroup(groupId);
    const claim = (db.prepare(`SELECT * FROM claims WHERE id = @groupId`).get({ groupId }) as ClaimRow | undefined) ?? null;
    if (scans.length === 0 && !claim) return null;
    return { claim, scans };
}

export type ClaimListRow = {
    groupId: string;
    scanTypes: ScanType[];
    title: string | null;
    costUsd: number | null;
    createdAt: string;
};

/**
 * Lists a user's claims (grouped scans), most recent first, for the history list view. Never
 * includes `result_json` — kept small regardless of how large any one claim's payload is.
 * Pagination applies to the GROUPED claims, not the underlying scan rows.
 */
export function listClaimsForUser(userId: number, opts: { limit: number; offset: number; scanType?: string }): { rows: ClaimListRow[]; total: number } {
    const havingType = opts.scanType ? `HAVING SUM(scan_type = @scanType) > 0` : "";
    // MAX(title)/MIN(user_id)-style aggregates are a "good enough, not guaranteed deterministic
    // across ties" pick — SQLite's MAX over text is lexicographic, not "most meaningful title";
    // in practice this almost always resolves to the timesheet's IPA-derived worker name anyway,
    // since every OTHER scan type's title is always null (COALESCE/MAX skips nulls).
    const rows = db
        .prepare(
            `SELECT COALESCE(claim_id, id) AS groupId,
                    GROUP_CONCAT(DISTINCT scan_type) AS scanTypesCsv,
                    MAX(title) AS title,
                    SUM(cost_usd) AS costUsd,
                    MAX(created_at) AS createdAt
             FROM scans
             WHERE user_id = @userId
             GROUP BY groupId
             ${havingType}
             ORDER BY createdAt DESC
             LIMIT @limit OFFSET @offset`
        )
        .all({ userId, scanType: opts.scanType ?? null, limit: opts.limit, offset: opts.offset }) as Array<{
            groupId: string; scanTypesCsv: string; title: string | null; costUsd: number | null; createdAt: string;
        }>;
    const total = (
        db.prepare(
            `SELECT COUNT(*) as c FROM (
                SELECT COALESCE(claim_id, id) AS groupId FROM scans WHERE user_id = @userId GROUP BY groupId ${havingType}
             )`
        ).get({ userId, scanType: opts.scanType ?? null }) as { c: number }
    ).c;
    return {
        rows: rows.map(r => ({ groupId: r.groupId, scanTypes: r.scanTypesCsv.split(",") as ScanType[], title: r.title, costUsd: r.costUsd, createdAt: r.createdAt })),
        total,
    };
}

export type AdminClaimListRow = ClaimListRow & { userId: number; userFullname: string; userEmail: string };

/** Lists claims across every user (admin dashboard) — optionally scoped to one user_id for drill-down. Never includes result_json. */
export function listAllClaims(opts: { limit: number; offset: number; scanType?: string; userId?: number }): { rows: AdminClaimListRow[]; total: number } {
    const conditions = [opts.userId !== undefined ? "user_id = @userId" : null].filter((c): c is string => c !== null);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const havingType = opts.scanType ? `HAVING SUM(scan_type = @scanType) > 0` : "";
    const params = { scanType: opts.scanType ?? null, userId: opts.userId ?? null, limit: opts.limit, offset: opts.offset };
    const rows = db
        .prepare(
            `SELECT COALESCE(claim_id, id) AS groupId,
                    GROUP_CONCAT(DISTINCT scan_type) AS scanTypesCsv,
                    MAX(title) AS title,
                    SUM(cost_usd) AS costUsd,
                    MAX(created_at) AS createdAt,
                    MAX(user_id) AS userId,
                    MAX(user_fullname) AS userFullname,
                    MAX(user_email) AS userEmail
             FROM scans
             ${whereClause}
             GROUP BY groupId
             ${havingType}
             ORDER BY createdAt DESC
             LIMIT @limit OFFSET @offset`
        )
        .all(params) as Array<{
            groupId: string; scanTypesCsv: string; title: string | null; costUsd: number | null; createdAt: string;
            userId: number; userFullname: string; userEmail: string;
        }>;
    const total = (
        db.prepare(`SELECT COUNT(*) as c FROM (SELECT COALESCE(claim_id, id) AS groupId FROM scans ${whereClause} GROUP BY groupId ${havingType})`).get(params) as { c: number }
    ).c;
    return {
        rows: rows.map(r => ({
            groupId: r.groupId, scanTypes: r.scanTypesCsv.split(",") as ScanType[], title: r.title, costUsd: r.costUsd, createdAt: r.createdAt,
            userId: r.userId, userFullname: r.userFullname, userEmail: r.userEmail,
        })),
        total,
    };
}

/**
 * Cost/count rollups for the admin dashboard. Rolling windows (today/last-7-days/calendar-month-
 * so-far/all-time) plus day/month trend breakdowns for the last 30 days / 12 months. `created_at`
 * is stored as a sortable ISO8601 string (see the schema above), which SQLite's date()/datetime()/
 * strftime() operate on directly — no separate date parsing needed. Unchanged by the claims
 * grouping work — a cost rollup doesn't care whether scans are grouped, only their raw sum.
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

// The one genuinely-editable array per scan type — timesheet's day-by-day rows, the other 4
// types' single flat entry/transaction list. Used to validate a PUT /api/claims/:groupId body only
// ever touches the field it's actually allowed to (never scan_type, user_id, or an image field).
const EDITABLE_FIELD_BY_SCAN_TYPE: Record<ScanType, string> = {
    timesheet: "reviewRows",
    bank_statement: "transactions",
    medical_bills: "entries",
    medical_certificates: "entries",
    payslips: "entries",
};

/**
 * Merges newly-scanned pages/rows into an EXISTING scan row (same scan type, same claim) — used by
 * `POST /api/claims/:groupId/append` when "Add more X files" targets a type the claim already has
 * at least one scan of. For a type the claim does NOT yet have, the caller should just call
 * `persistScan` with `claimId` set to the claim's groupId instead (a fresh insert, no merge).
 *
 * New page images are written into the EXISTING scan's own image directory (keyed by
 * `existingScanId`, same as `persistScan`'s `writeImage`), continuing the index sequence from
 * however many pages that scan already has — never restarting at 0, which would otherwise collide
 * with and silently overwrite the first already-saved page's image file.
 *
 * @returns `true` if `existingScanId` exists and is owned by `userId`, `false` otherwise.
 */
export function appendScanPages(
    existingScanId: string,
    userId: number,
    opts: {
        result: Record<string, unknown>;
        pages?: { image: string; [k: string]: unknown }[];
        costUsd: number | null;
        durationMs: number | null;
    }
): boolean {
    const scan = getScanById(existingScanId);
    if (!scan || scan.user_id !== userId) return false;

    const existingResult = JSON.parse(scan.result_json) as Record<string, unknown>;
    const scanImagesDir = path.join(HISTORY_IMAGES_DIR, scan.id);
    mkdirSync(scanImagesDir, { recursive: true });
    const writeImage = (ref: string, base64: string): { ref: string } => {
        writeFileSync(path.join(scanImagesDir, `${ref}.png`), Buffer.from(base64, "base64"));
        return { ref };
    };

    if (scan.scan_type === "timesheet") {
        const existingPageCount = (existingResult.pageReviews as unknown[] | undefined)?.length ?? 0;
        const newReviews = JSON.parse(JSON.stringify((opts.result.pageReviews as unknown[]) ?? [])) as Array<Record<string, unknown>>;
        newReviews.forEach((p, i) => {
            if (typeof p.image === "string") p.image = writeImage(`page-${existingPageCount + i}`, p.image);
        });
        existingResult.pageReviews = [...((existingResult.pageReviews as unknown[]) ?? []), ...newReviews];
        existingResult.reviewRows = [...((existingResult.reviewRows as unknown[]) ?? []), ...((opts.result.reviewRows as unknown[]) ?? [])];
        // ipa/ipaImage intentionally untouched — appending more timesheet pages never re-sends or
        // replaces the IPA letter this scan already has.
    } else {
        const existingPageCount = (existingResult.pages as unknown[] | undefined)?.length ?? 0;
        const newPages = JSON.parse(JSON.stringify(opts.pages ?? [])) as Array<Record<string, unknown>>;
        newPages.forEach((p, i) => {
            if (typeof p.image === "string") p.image = writeImage(`page-${existingPageCount + i}`, p.image);
        });
        existingResult.pages = [...((existingResult.pages as unknown[]) ?? []), ...newPages];
        const field = EDITABLE_FIELD_BY_SCAN_TYPE[scan.scan_type];
        const newRows = (opts.result as Record<string, unknown>)[field] as unknown[] | undefined;
        existingResult[field] = [...((existingResult[field] as unknown[]) ?? []), ...(newRows ?? [])];
    }

    const newCost = (scan.cost_usd ?? 0) + (opts.costUsd ?? 0);
    const newDuration = (scan.duration_ms ?? 0) + (opts.durationMs ?? 0);
    db.prepare(`UPDATE scans SET result_json = @r, cost_usd = @c, duration_ms = @d WHERE id = @id`)
        .run({ id: scan.id, r: JSON.stringify(existingResult), c: newCost, d: newDuration });
    return true;
}

/**
 * Replaces ONE page's entries/transactions (and optionally its image, if rotated) in an existing
 * scan — used by `POST /api/claims/:groupId/rescan-page` to persist a single-page rescan run
 * against an already-stored page image. Not supported for `scan_type === "timesheet"` (its
 * pageReviews/reviewRows shape doesn't map 1:1 onto one page the way the other 4 types' flat
 * per-page `transactions`/`entries` array does — see the project plan's Phase 5 for timesheet's
 * own, separate rescan support).
 *
 * The page's OWN per-page array (`result.pages[pageIndex][field]`) is replaced outright; the
 * scan's FLAT top-level array (`result[field]`, e.g. every transaction across every page) has this
 * page's old entries (matched by `source`) removed and the fresh ones spliced in — every other
 * page's entries in that same flat array are left untouched.
 *
 * @returns `true` if the scan exists, is owned by `userId`, isn't a timesheet, and `pageIndex` is
 * in range; `false` otherwise.
 */
export function replaceScanPage(
    existingScanId: string,
    userId: number,
    pageIndex: number,
    opts: { newImageBase64?: string; pageEntries: unknown[]; costUsd: number; durationMs: number }
): boolean {
    const scan = getScanById(existingScanId);
    if (!scan || scan.user_id !== userId || scan.scan_type === "timesheet") return false;

    const result = JSON.parse(scan.result_json) as Record<string, unknown>;
    const pages = (result.pages as Array<Record<string, unknown>> | undefined) ?? [];
    const page = pages[pageIndex];
    if (!page) return false;
    const source = page.source as string;

    if (opts.newImageBase64) {
        const scanImagesDir = path.join(HISTORY_IMAGES_DIR, scan.id);
        mkdirSync(scanImagesDir, { recursive: true });
        // Same filename the original page was written under (page-<index>.png) — the stored {ref}
        // marker already points at this path, so overwriting in place needs no result_json change.
        writeFileSync(path.join(scanImagesDir, `page-${pageIndex}.png`), Buffer.from(opts.newImageBase64, "base64"));
    }

    const field = EDITABLE_FIELD_BY_SCAN_TYPE[scan.scan_type];
    pages[pageIndex] = { ...page, [field]: opts.pageEntries };
    result.pages = pages;
    const taggedEntries = (opts.pageEntries as Array<Record<string, unknown>>).map(e => ({ ...e, source }));
    const otherPagesEntries = ((result[field] as Array<Record<string, unknown>> | undefined) ?? []).filter(e => e.source !== source);
    result[field] = [...otherPagesEntries, ...taggedEntries];

    const newCost = (scan.cost_usd ?? 0) + opts.costUsd;
    const newDuration = (scan.duration_ms ?? 0) + opts.durationMs;
    db.prepare(`UPDATE scans SET result_json = @r, cost_usd = @c, duration_ms = @d WHERE id = @id`)
        .run({ id: scan.id, r: JSON.stringify(result), c: newCost, d: newDuration });
    return true;
}

/**
 * Persists an edit made while viewing a claim — e.g. a caseworker fixing a typo on one of its
 * scan types, and/or updating the claim's own note/title. Scoped narrowly per scan type: only the
 * one editable array that type actually has (see EDITABLE_FIELD_BY_SCAN_TYPE) can be replaced,
 * nothing else in that scan's result_json is touched. No optimistic locking (last-write-wins) — a
 * single caseworker per claim in practice, not worth the complexity yet.
 *
 * @param perTypeRows - Only the scan types actually present/edited on screen need to appear here;
 * a type this claim doesn't have is silently ignored (no matching scan row to update).
 * @param notes - The claim's free-text case note. `undefined` leaves it untouched; an explicit
 * `null`/`''` clears it.
 * @param title - The claim's own title, independent of any scan type's own `title` column.
 * `undefined` leaves it untouched.
 * @returns `true` if anything matched (at least one scan row updated, or the claims row
 * created/updated), `false` if this groupId+userId matched nothing at all.
 */
export function updateClaimFields(
    groupId: string,
    userId: number,
    perTypeRows: Partial<Record<ScanType, { rows: unknown[]; ipa?: unknown }>>,
    notes?: string | null,
    title?: string | null
): boolean {
    const scans = scansForGroup(groupId, userId);
    if (scans.length === 0) return false;

    const txn = db.transaction(() => {
        let matchedAny = false;
        for (const [scanType, edit] of Object.entries(perTypeRows) as [ScanType, { rows: unknown[]; ipa?: unknown }][]) {
            const scan = scans.find(s => s.scan_type === scanType);
            if (!scan || !edit) continue;
            matchedAny = true;
            const field = EDITABLE_FIELD_BY_SCAN_TYPE[scanType];
            const result = JSON.parse(scan.result_json) as Record<string, unknown>;
            result[field] = edit.rows;
            if (scanType === "timesheet" && edit.ipa !== undefined) result.ipa = edit.ipa;
            db.prepare(`UPDATE scans SET result_json = @resultJson WHERE id = @id`).run({ id: scan.id, resultJson: JSON.stringify(result) });
        }

        if (notes !== undefined || title !== undefined) {
            matchedAny = true;
            const existingClaim = db.prepare(`SELECT * FROM claims WHERE id = @groupId`).get({ groupId }) as ClaimRow | undefined;
            if (existingClaim) {
                const sets = [];
                const params: Record<string, unknown> = { groupId };
                if (notes !== undefined) { sets.push("notes = @notes"); params.notes = notes; }
                if (title !== undefined) { sets.push("title = @title"); params.title = title; }
                db.prepare(`UPDATE claims SET ${sets.join(", ")} WHERE id = @groupId`).run(params);
            } else {
                // Lazy upgrade: this groupId has never had a real claims row (every matching scan is
                // still a legacy claim_id=NULL singleton, grouped only via COALESCE(claim_id, id)).
                // Create one now (id = groupId), and back-stamp claim_id on every scan currently
                // grouped under it that doesn't already have one set — from now on this groupId is a
                // first-class claim, same as one created via ensureClaim at submit time.
                const anyScan = scans[0];
                db.prepare(
                    `INSERT INTO claims (id, user_id, user_fullname, user_email, title, notes) VALUES (@id, @userId, @userFullname, @userEmail, @title, @notes)`
                ).run({ id: groupId, userId: anyScan.user_id, userFullname: anyScan.user_fullname, userEmail: anyScan.user_email, title: title ?? null, notes: notes ?? null });
                db.prepare(`UPDATE scans SET claim_id = @groupId WHERE COALESCE(claim_id, id) = @groupId AND claim_id IS NULL`).run({ groupId });
            }
        }
        return matchedAny;
    });
    return txn();
}

// Same ownership scoping as before — a caseworker can only delete their own claims, never another
// user's (no admin bypass here either, same reasoning as the edit route: deleting someone else's
// case data is a bigger trust decision than viewing it). Every underlying scan row's own image
// directory is removed (a claim can now span MULTIPLE image directories, one per scan type it
// contains, not just one), plus the scans rows themselves and the claims row if one exists.
/**
 * Deletes every scan row in a claim group and their saved page images, but only if `userId` owns
 * them, plus the `claims` row itself if one exists.
 *
 * @returns `true` if anything was found (and owned by this user) and deleted, `false` otherwise.
 */
export async function deleteClaim(groupId: string, userId: number): Promise<boolean> {
    const scans = scansForGroup(groupId, userId);
    if (scans.length === 0) return false;
    const ids = scans.map(s => s.id);
    db.prepare(`DELETE FROM scans WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    db.prepare(`DELETE FROM claims WHERE id = @groupId`).run({ groupId });
    await Promise.all(ids.map(id => rm(path.join(HISTORY_IMAGES_DIR, id), { recursive: true, force: true })));
    return true;
}

// Recursively replaces every `{ref: string}` marker (and nothing else — a real object with other
// keys alongside `ref` is left alone) with the authenticated image-serving URL for that scan.
// Generic across every scan type's result shape on purpose: whatever shape future scan types take,
// an image field written via persistScan's writeImage() helper above is always exactly `{ref}`,
// so this never needs updating when a new scan type/image field is added. Takes the underlying
// SCAN's own id (not a claim groupId) — each scan type within a combined claim still has its own
// separate image directory on disk, written under its own id by persistScan above.
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
