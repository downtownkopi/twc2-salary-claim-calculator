import express from "express";
import multer from "multer";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import * as path from "path";
import { randomUUID } from "crypto";
import { resizeForDisplay } from "./lib/ocr";
import { fillTimesheetFromRows, MONTH_ABBR, type FillWarning, type ReviewRow } from "./lib/xlsx";
import { uploadFlaggedPage, type FlaggedPageEntry } from "./lib/feedback";
import { buildWorkerPersonalDetailsDocx } from "./lib/workerDetailsDocx";
import { buildWorkerPersonalDetailsPdf } from "./lib/workerDetailsPdf";
import type { WorkerDetailsExportPayload } from "./lib/workerDetailsShared";
import {
    upload,
    loadPagesForFile,
    SUPPORTED_YEARS,
    enforceTotalUploadSize,
    MAX_TOTAL_UPLOAD_BYTES,
    MAX_PAGES_PER_JOB,
    acquireJobSlot,
    releaseJobSlot,
    jobPagesDir,
    cleanupJobDir,
} from "./lib/jobs/shared";
import { processJobs, runProcessJob, scheduleJobCleanup, type RotationMap } from "./lib/jobs/timesheetJob";
import { bankJobs, runBankStatementJob, scheduleBankJobCleanup } from "./lib/jobs/bankStatementJob";
import { medicalJobs, runMedicalBillsJob, scheduleMedicalJobCleanup } from "./lib/jobs/medicalBillsJob";

const TEMPLATE_PATH = path.join(__dirname, "calculation.xltx");
const PORT = process.env.PORT || 3002;

// Fanning out many parallel scan calls per page (bands x temperatures) means far more surface
// area for a flaky upstream response. Our own try/catch around each scanPageImage call assumes SDK failures
// always surface as a rejected promise we're awaiting — but a malformed/truncated network
// response can throw inside the SDK's internals detached from that chain (an unhandled rejection
// or uncaught exception), which by default kills the entire Node process and drops every
// in-flight request, not just the one that hit the flaky response. Requests here are stateless
// (memory-storage uploads, no shared mutable state or open transactions), so logging and staying
// up is safe and far better than a total outage over one bad upstream response.
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection (server staying up):", reason);
});
process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (server staying up):", err);
});

const CAMANS_LOGIN_URL = "https://camans.twc2.org.sg/login";
const CLAIMS_BASE_URL = "https://claims.twc2.org.sg";
const SSO_COOKIE_DOMAIN = process.env.NODE_ENV === "production" ? ".twc2.org.sg" : undefined;

const app = express();
app.use(cookieParser());

// SSO gate: camans.twc2.org.sg is the identity provider. It writes a JWT into a
// cookie scoped to the shared parent domain (.twc2.org.sg) on login, and clears
// it on logout/idle-timeout — see camans client's App.js/header.js/Protected.js.
// This app trusts that same cookie instead of running its own login, and checks
// it fresh on every request (no independent session) so a camans logout also
// signs the user out here.
app.use((req, res, next) => {
    if (process.env.NODE_ENV !== "production" && process.env.DISABLE_SSO === "true") {
        return next();
    }

    const token = req.cookies?.token;
    const redirectTarget = `${CAMANS_LOGIN_URL}?redirect=${encodeURIComponent(`${CLAIMS_BASE_URL}${req.originalUrl}`)}`;

    if (!token) {
        return res.redirect(redirectTarget);
    }

    const secret = process.env.JWT_ACCESS_TOKEN_SECRET;
    if (!secret) {
        console.error("JWT_ACCESS_TOKEN_SECRET is not set — cannot verify camans SSO cookie.");
        return res.status(500).send("Server misconfigured.");
    }

    try {
        (req as any).user = jwt.verify(token, secret);
        next();
    } catch {
        res.clearCookie("token", { path: "/", domain: SSO_COOKIE_DOMAIN });
        return res.redirect(redirectTarget);
    }
});

app.use(express.static(path.join(__dirname, "public")));

// Renders a thumbnail of every page of every attached file (no OCR/model calls at all — just
// pdf-to-image/image-normalize + downscale, same functions /api/process itself uses to load
// pages) so the browser can show a staging grid right after attaching, before the real (expensive,
// multi-pass) scan runs. Lets a human confirm/rotate a sideways page up front — auto-detecting
// this from the model was tried and found unreliable (see lib/ocr.ts's rotateImage comment).
app.post(
    "/api/preview",
    upload.fields([
        { name: "pdfs", maxCount: 10 },
        { name: "ipa", maxCount: 1 },
        { name: "bankStatement", maxCount: 10 },
        { name: "medicalBills", maxCount: 10 },
    ]),
    enforceTotalUploadSize,
    async (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.pdfs ?? [];
        const ipaFile = uploadedFields?.ipa?.[0];
        const bankStatementFiles = uploadedFields?.bankStatement ?? [];
        const medicalBillsFiles = uploadedFields?.medicalBills ?? [];

        // Preview is a one-shot request/response (not a background job), so its rendered pages get
        // their own short-lived temp dir instead of a job id — cleaned up in the `finally` below as
        // soon as the response is built, rather than waiting on any job's TTL.
        const previewDir = jobPagesDir(randomUUID());
        try {
            const pdfsPreview: { fileIndex: number; pageIndex: number; fileName: string; image: string }[] = [];
            const pdfsErrors: { fileName: string; error: string }[] = [];
            for (let fi = 0; fi < files.length; fi++) {
                const file = files[fi];
                try {
                    const images = await loadPagesForFile(file, path.join(previewDir, `pdfs-${fi}`), MAX_PAGES_PER_JOB);
                    for (let pi = 0; pi < images.length; pi++) {
                        pdfsPreview.push({ fileIndex: fi, pageIndex: pi, fileName: file.originalname, image: await resizeForDisplay(await images.get(pi), 400) });
                    }
                } catch (e: any) {
                    pdfsErrors.push({ fileName: file.originalname, error: e.message });
                }
            }

            let ipaPreview: string | null = null;
            let ipaError: string | null = null;
            if (ipaFile) {
                try {
                    const images = await loadPagesForFile(ipaFile, path.join(previewDir, "ipa"), MAX_PAGES_PER_JOB);
                    // Only the first page is ever sent to extractIpaFields (lib/ipa.ts) — previewing
                    // later pages would invite rotating a page that isn't actually used.
                    if (images.length > 0) ipaPreview = await resizeForDisplay(await images.get(0), 400);
                } catch (e: any) {
                    ipaError = e.message;
                }
            }

            // Same staging idea as pdfs above — a bank statement is just as likely to be a phone
            // photo as a clean digital export, so it gets the same rotate/exclude-before-scan step.
            const bankStatementPreview: { fileIndex: number; pageIndex: number; fileName: string; image: string }[] = [];
            const bankStatementErrors: { fileName: string; error: string }[] = [];
            for (let fi = 0; fi < bankStatementFiles.length; fi++) {
                const file = bankStatementFiles[fi];
                try {
                    const images = await loadPagesForFile(file, path.join(previewDir, `bankStatement-${fi}`), MAX_PAGES_PER_JOB);
                    for (let pi = 0; pi < images.length; pi++) {
                        bankStatementPreview.push({ fileIndex: fi, pageIndex: pi, fileName: file.originalname, image: await resizeForDisplay(await images.get(pi), 400) });
                    }
                } catch (e: any) {
                    bankStatementErrors.push({ fileName: file.originalname, error: e.message });
                }
            }

            // Same staging idea as bankStatement above — an MC/hospital bill is just as likely to be a
            // phone photo as a clean printout.
            const medicalBillsPreview: { fileIndex: number; pageIndex: number; fileName: string; image: string }[] = [];
            const medicalBillsErrors: { fileName: string; error: string }[] = [];
            for (let fi = 0; fi < medicalBillsFiles.length; fi++) {
                const file = medicalBillsFiles[fi];
                try {
                    const images = await loadPagesForFile(file, path.join(previewDir, `medicalBills-${fi}`), MAX_PAGES_PER_JOB);
                    for (let pi = 0; pi < images.length; pi++) {
                        medicalBillsPreview.push({ fileIndex: fi, pageIndex: pi, fileName: file.originalname, image: await resizeForDisplay(await images.get(pi), 400) });
                    }
                } catch (e: any) {
                    medicalBillsErrors.push({ fileName: file.originalname, error: e.message });
                }
            }

            res.json({ pdfsPreview, pdfsErrors, ipaPreview, ipaError, bankStatementPreview, bankStatementErrors, medicalBillsPreview, medicalBillsErrors });
        } finally {
            await cleanupJobDir(previewDir);
        }
    }
);

app.post(
    "/api/process",
    upload.fields([
        { name: "pdfs", maxCount: 10 },
        { name: "ipa", maxCount: 1 }, // the IPA letter, a single separate document from the timesheets — compulsory, same as pdfs
    ]),
    enforceTotalUploadSize,
    (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.pdfs;
        const ipaFile = uploadedFields?.ipa?.[0];
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No PDF files uploaded." });
        }
        if (!ipaFile) {
            return res.status(400).json({ error: "No IPA letter uploaded — it's required, same as the timesheet files." });
        }

        // Rotation degrees a human confirmed against the /api/preview thumbnails (public/index.html's
        // staging step) — applied below via rotateImage before anything else ever looks at a page's
        // image, so every downstream step (context extraction, scanning, IPA extraction) sees the
        // corrected orientation. Absent/malformed is treated as "no rotations chosen" rather than an
        // error — the staging step is a UX improvement, not a required step, so a request without it
        // (e.g. an older client) should still scan normally, just without the correction.
        let rotations: RotationMap = {};
        try {
            if (typeof req.body.rotations === "string") rotations = JSON.parse(req.body.rotations);
        } catch {
            // ignore — fall through with no rotations applied
        }

        // Pages a human dropped in the staging preview ("<fileIndex>-<pageIndex>" keys, same as
        // rotations.pdfs) — the underlying file is still uploaded whole (a PDF's pages can't be
        // stripped client-side), so exclusion is enforced here: skip these pages entirely, before any
        // context extraction or scan attempt, as if that page were never on the page count at all.
        let excludedPages = new Set<string>();
        try {
            if (typeof req.body.excludedPages === "string") {
                const parsed = JSON.parse(req.body.excludedPages);
                if (Array.isArray(parsed)) excludedPages = new Set(parsed);
            }
        } catch {
            // ignore — fall through with no exclusions applied
        }

        // The caseworker's declared standard break (public/index.html's radio group) — used as
        // the assumed break for single-shift days (nothing is actually observed to contradict it
        // there) and as the value a multi-shift day's genuinely observed gap gets compared against
        // client-side (checkBreakMismatch). Falls back to 1h on anything unparseable/out of range,
        // matching the form's own default.
        const parsedBreakHours = Number(req.body.standardBreakHours);
        const standardBreakHours = Number.isFinite(parsedBreakHours) && parsedBreakHours >= 0 ? parsedBreakHours : 1;

        // Only sent by the single-page "Rotate + Rescan" flow (public/index.html) — see
        // runProcessJob's own fallbackYear param comment for why it's needed there.
        const parsedFallbackYear = Number(req.body.fallbackYear);
        const fallbackYear = Number.isFinite(parsedFallbackYear) && SUPPORTED_YEARS.includes(parsedFallbackYear) ? parsedFallbackYear : undefined;

        // A real scan (many pages, sequential) can run 15-20+ minutes — long enough that holding this
        // HTTP request open the whole time is fragile (proxies/networks can drop a connection that
        // long) and gives the browser zero visibility into progress until the very end. Instead: kick
        // the scan off as a background job and return its id immediately; public/index.html polls
        // GET /api/process/:jobId, which renders each page's card as soon as that page finishes rather
        // than waiting for the entire batch.
        const jobId = randomUUID();
        processJobs.set(jobId, { status: "running", pages: [], result: null, error: null });
        // Cloud Run would just add instances under load; a fixed VPS can't — acquireJobSlot queues
        // this job's actual work (not the response below, which returns immediately either way)
        // until a concurrency slot is free, so peak memory/CPU stays bounded to MAX_CONCURRENT_JOBS
        // regardless of how many caseworkers upload at the same moment.
        acquireJobSlot()
            .then(() => runProcessJob(jobId, files, ipaFile, rotations, excludedPages, standardBreakHours, fallbackYear))
            .catch(e => {
                const job = processJobs.get(jobId);
                if (job) { job.status = "error"; job.error = e.message; }
            })
            .finally(() => {
                releaseJobSlot();
                scheduleJobCleanup(jobId);
            });

        res.json({ jobId });
    }
);

// Polled by public/index.html every few seconds while a scan runs. `pages` grows live as each
// page finishes scanning; `result`/`error` land once `status` moves away from "running".
app.get("/api/process/:jobId", (req, res) => {
    const job = processJobs.get(req.params.jobId);
    if (!job) {
        // Logged server-side with the exact jobId/timestamp so a real occurrence can be grepped
        // out of Cloud Run logs directly, instead of having to cross-reference "user says it
        // happened around X" against deploy/restart history after the fact.
        console.error(`GET /api/process/${req.params.jobId}: job not found (jobs map has ${processJobs.size} entr${processJobs.size === 1 ? "y" : "ies"})`);
        return res.status(404).json({
            error:
                "This scan's progress can't be found anymore. This almost always means the server process restarted while the scan was still running — its in-progress state only lives in memory, not a database, so a restart (a new deploy, or the server recycling itself) wipes it. " +
                "It is NOT something you did wrong, and nothing about your uploaded files caused it. " +
                "Nothing can be recovered from this specific scan — please re-upload and start it again. " +
                `(job id: ${req.params.jobId}, if this keeps happening please share this id and the approximate time)`,
        });
    }
    // job.pages is pre-sized to the page count and written by index (upload order), so a page
    // that hasn't finished yet — or never will, e.g. excluded/failed — leaves a hole. Filtered out
    // here rather than sent as JSON `null`, so the client only ever sees pages that actually
    // completed, still in upload-order relative to each other.
    res.json({ ...job, pages: job.pages.filter(p => p !== undefined) });
});

// Standalone cross-check tool: caseworker uploads the worker's own bank statement(s), and every
// page is scanned for every incoming (credit) transaction — no keyword filtering (see
// lib/bankstatement.ts) — surfaced as a plain list for the caseworker to prune by hand and compare
// against the claim total by eye. Not wired into /api/generate or the spreadsheet at all (v1 scope
// is "surface matches", not automated gap calculation).
app.post(
    "/api/bank-statement",
    upload.fields([{ name: "statements", maxCount: 10 }]),
    enforceTotalUploadSize,
    (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.statements;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No bank statement files uploaded." });
        }

        // Same staging-confirmed rotation/exclusion pattern as /api/process — keyed
        // "<fileIndex>-<pageIndex>", from the /api/preview-backed staging step in public/index.html.
        let rotations: Record<string, number> = {};
        try {
            const parsed = JSON.parse(req.body.rotations ?? "{}");
            if (parsed && typeof parsed === "object") rotations = parsed;
        } catch {
            // ignore — fall through with no rotations applied
        }
        let excludedPages = new Set<string>();
        try {
            const parsed = JSON.parse(req.body.excludedPages ?? "[]");
            if (Array.isArray(parsed)) excludedPages = new Set(parsed);
        } catch {
            // ignore — fall through with no exclusions applied
        }

        const jobId = randomUUID();
        bankJobs.set(jobId, { status: "running", pages: [], result: null, error: null });
        acquireJobSlot()
            .then(() => runBankStatementJob(jobId, files, rotations, excludedPages))
            .catch(e => {
                const job = bankJobs.get(jobId);
                if (job) { job.status = "error"; job.error = e.message; }
            })
            .finally(() => {
                releaseJobSlot();
                scheduleBankJobCleanup(jobId);
            });

        res.json({ jobId });
    }
);

app.get("/api/bank-statement/:jobId", (req, res) => {
    const job = bankJobs.get(req.params.jobId);
    if (!job) {
        console.error(`GET /api/bank-statement/${req.params.jobId}: job not found (jobs map has ${bankJobs.size} entr${bankJobs.size === 1 ? "y" : "ies"})`);
        return res.status(404).json({
            error:
                "This bank statement scan's progress can't be found anymore. This almost always means the server process restarted while the scan was still running — its in-progress state only lives in memory, not a database, so a restart (a new deploy, or the server recycling itself) wipes it. " +
                "It is NOT something you did wrong, and nothing about your uploaded files caused it. " +
                "Nothing can be recovered from this specific scan — please re-upload and start it again. " +
                `(job id: ${req.params.jobId}, if this keeps happening please share this id and the approximate time)`,
        });
    }
    // job.pages is pre-sized to the page count and written by index (upload order) — see
    // runBankStatementJob — so a page that hasn't finished yet leaves a hole, filtered out here
    // rather than sent as JSON `null`.
    res.json({ ...job, pages: job.pages.filter(p => p !== undefined) });
});

// Standalone cross-check tool, same shape as /api/bank-statement above: caseworker uploads the
// worker's medical bills/invoices, and every page is scanned for a billed date+amount — surfaced
// as an editable list the caseworker marks reimbursed/unreimbursed against, which then feeds the
// "unreimbursed medical bills" claim (see computeMedicalBillsClaim in public/index.html). An
// employer of a Work Permit holder is generally obliged to bear the worker's medical costs — this
// checks whether that actually happened, separate from the sick leave pay (s.89) claim, which is
// about leave DAYS, not billed amounts.
app.post(
    "/api/medical-bills",
    upload.fields([{ name: "medicalBills", maxCount: 10 }]),
    enforceTotalUploadSize,
    (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.medicalBills;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No medical bill files uploaded." });
        }

        let rotations: Record<string, number> = {};
        try {
            const parsed = JSON.parse(req.body.rotations ?? "{}");
            if (parsed && typeof parsed === "object") rotations = parsed;
        } catch {
            // ignore — fall through with no rotations applied
        }
        let excludedPages = new Set<string>();
        try {
            const parsed = JSON.parse(req.body.excludedPages ?? "[]");
            if (Array.isArray(parsed)) excludedPages = new Set(parsed);
        } catch {
            // ignore — fall through with no exclusions applied
        }

        const jobId = randomUUID();
        medicalJobs.set(jobId, { status: "running", pages: [], result: null, error: null });
        acquireJobSlot()
            .then(() => runMedicalBillsJob(jobId, files, rotations, excludedPages))
            .catch(e => {
                const job = medicalJobs.get(jobId);
                if (job) { job.status = "error"; job.error = e.message; }
            })
            .finally(() => {
                releaseJobSlot();
                scheduleMedicalJobCleanup(jobId);
            });

        res.json({ jobId });
    }
);

app.get("/api/medical-bills/:jobId", (req, res) => {
    const job = medicalJobs.get(req.params.jobId);
    if (!job) {
        console.error(`GET /api/medical-bills/${req.params.jobId}: job not found (jobs map has ${medicalJobs.size} entr${medicalJobs.size === 1 ? "y" : "ies"})`);
        return res.status(404).json({
            error:
                "This medical bills scan's progress can't be found anymore. This almost always means the server process restarted while the scan was still running — its in-progress state only lives in memory, not a database, so a restart (a new deploy, or the server recycling itself) wipes it. " +
                "It is NOT something you did wrong, and nothing about your uploaded files caused it. " +
                "Nothing can be recovered from this specific scan — please re-upload and start it again. " +
                `(job id: ${req.params.jobId}, if this keeps happening please share this id and the approximate time)`,
        });
    }
    res.json({ ...job, pages: job.pages.filter(p => p !== undefined) });
});

// Takes the human-reviewed (possibly hand-corrected) rows from the browser's edit step and writes
// them straight to the spreadsheet — no OCR here, this is pure "given these final numbers, fill
// the template" work, so it's fast and synchronous compared to /api/process.
app.post("/api/generate", express.json({ limit: "5mb" }), async (req, res) => {
    // No year gate here — fillTimesheetFromRows below picks each row's sheet straight off its own
    // r.date (already a full YYYY-MM-DD), and silently skips (with a warning) any date outside the
    // template's supported range. The claim-wide year itself was already resolved and validated
    // against SUPPORTED_YEARS back at /api/process (runProcessJob's prescan) before these rows ever
    // reached the browser for review.
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) {
        return res.status(400).json({ error: "rows must be an array" });
    }

    let buffer: Buffer;
    let warnings: FillWarning[];
    let writtenDates: Date[];
    try {
        ({ buffer, warnings, writtenDates } = await fillTimesheetFromRows(TEMPLATE_PATH, rows as ReviewRow[]));
    } catch (e: any) {
        return res.status(500).json({ error: `failed to fill template: ${e.message}` });
    }

    // Same "every day of every touched month, flag anything uncovered" coverage check as the scan
    // step's preview, but authoritative now — based on what fillTimesheetFromRows actually wrote
    // (post 24h-sanity-check) plus confirmed rest days, rather than the pre-write preview.
    const coveredByMonth = new Map<string, Set<number>>();
    for (const d of writtenDates) {
        const k = `${d.getFullYear()}-${d.getMonth()}`;
        (coveredByMonth.get(k) ?? coveredByMonth.set(k, new Set()).get(k)!).add(d.getDate());
    }
    for (const r of rows as ReviewRow[]) {
        if (!r.restDay) continue;
        const [y, m, d] = r.date.split("-").map(Number);
        const k = `${y}-${m - 1}`;
        (coveredByMonth.get(k) ?? coveredByMonth.set(k, new Set()).get(k)!).add(d);
    }
    const explainedDates = new Set(warnings.map(w => w.date).filter((d): d is string => d !== undefined));

    const monthSummary: { label: string; filled: number; total: number }[] = [];
    for (const [key, daysCovered] of [...coveredByMonth].sort()) {
        const [y, monthIndex0] = key.split("-").map(Number);
        const daysInMonth = new Date(y, monthIndex0 + 1, 0).getDate();
        for (let day = 1; day <= daysInMonth; day++) {
            if (daysCovered.has(day)) continue;
            const dateStr = `${y}-${String(monthIndex0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            if (explainedDates.has(dateStr)) continue;
            const date = new Date(y, monthIndex0, day);
            warnings.push({
                source: "coverage check",
                reason: `${date.toDateString()} has no row submitted — please check this date directly.`,
                category: "missing_data",
                date: dateStr,
            });
        }
        monthSummary.push({ label: `${MONTH_ABBR[monthIndex0]} ${y}`, filled: daysCovered.size, total: daysInMonth });
    }

    res.json({
        success: true,
        filename: breakdownFilename(req.body?.workerFin, "xlsx"),
        file: buffer.toString("base64"),
        warnings,
        entriesWritten: writtenDates.length,
        monthSummary,
    });
});

// Same naming convention as the caseworker's own hand-copied breakdowns (e.g. "419K_Breakdown.pdf")
// — last 4 characters of the FIN, which is exactly what a masked/partial FIN already is (see
// lib/ipa.ts's PARTIAL_FIN_FORMAT), so this works the same whether the IPA gave a full or masked
// FIN. Falls back to "Worker" if no FIN was captured at all, rather than failing the export.
/**
 * Builds the download filename for a Worker Personal Details export, matching the caseworker's own
 * hand-copied naming convention (e.g. `"419K_Breakdown.pdf"`).
 *
 * @param fin - The worker's FIN (full or masked); only its last 4 characters are used.
 * @param ext - The file extension, e.g. `"docx"`, `"pdf"`, `"xlsx"`.
 * @returns The filename, e.g. `"419K_Breakdown.pdf"`, or `"Worker_Breakdown.pdf"` if no FIN was captured.
 */
function breakdownFilename(fin: string | null | undefined, ext: string): string {
    const suffix = fin && fin.trim() ? fin.trim().slice(-4).toUpperCase() : "Worker";
    return `${suffix}_Breakdown.${ext}`;
}

// The browser already computed every number this document needs (public/index.html's
// buildExportPayload, off the same monthKeys/totals/allocated that render the on-screen
// breakdown tables) — this endpoint only formats that payload into the Worker Personal Details
// docx template, it does no calculation of its own.
app.post("/api/export-docx", express.json({ limit: "1mb" }), async (req, res) => {
    const p = req.body as Partial<WorkerDetailsExportPayload>;
    if (!p || typeof p.basicSalary !== "number" || !p.basic || !p.allowances || !p.overtime || !p.restDays || !p.publicHolidays) {
        return res.status(400).json({ error: "missing or malformed claim breakdown" });
    }
    try {
        const buffer = await buildWorkerPersonalDetailsDocx(p as WorkerDetailsExportPayload);
        res.json({
            success: true,
            filename: breakdownFilename(p.workerFin, "docx"),
            file: buffer.toString("base64"),
        });
    } catch (e: any) {
        res.status(500).json({ error: `failed to build document: ${e.message}` });
    }
});

// Same payload/validation as /api/export-docx above, just formatted into a PDF instead — see that
// endpoint's comment for why there's no calculation here either.
app.post("/api/export-pdf", express.json({ limit: "1mb" }), async (req, res) => {
    const p = req.body as Partial<WorkerDetailsExportPayload>;
    if (!p || typeof p.basicSalary !== "number" || !p.basic || !p.allowances || !p.overtime || !p.restDays || !p.publicHolidays) {
        return res.status(400).json({ error: "missing or malformed claim breakdown" });
    }
    try {
        const buffer = await buildWorkerPersonalDetailsPdf(p as WorkerDetailsExportPayload);
        res.json({
            success: true,
            filename: breakdownFilename(p.workerFin, "pdf"),
            file: buffer.toString("base64"),
        });
    } catch (e: any) {
        res.status(500).json({ error: `failed to build document: ${e.message}` });
    }
});

// Ground-truth corpus builder, not part of the scan/generate critical path — a user marks a page
// as misread, we store the source image next to what the pipeline produced (rawEntries, the
// pre-edit reconciled output already sent to the browser in /api/process's pageReviews) and what
// the user actually corrected it to (correctedEntries, read back from their edited review rows).
// Used later for prompt fixes/regression tests, not live inference, so a storage hiccup here
// shouldn't look like a failure of the actual scan/generate the user cares about.
app.post("/api/flag-page", express.json({ limit: "5mb" }), async (req, res) => {
    const { source, image, rawEntries, correctedEntries, note, dataModel, pageContext } = req.body ?? {};
    if (typeof source !== "string" || typeof image !== "string" || !Array.isArray(rawEntries) || !Array.isArray(correctedEntries)) {
        return res.status(400).json({ error: "source, image, rawEntries, correctedEntries are required" });
    }
    try {
        const { docId } = await uploadFlaggedPage({
            source,
            image,
            rawEntries: rawEntries as FlaggedPageEntry[],
            correctedEntries: correctedEntries as FlaggedPageEntry[],
            note: typeof note === "string" && note.trim() ? note.trim() : null,
            dataModel: typeof dataModel === "string" ? dataModel : "unclear",
            pageContext: typeof pageContext === "string" ? pageContext : "",
        });
        res.json({ success: true, docId });
    } catch (e: any) {
        console.error("failed to store flagged page:", e);
        res.status(500).json({ error: `failed to store flagged page: ${e.message}` });
    }
});

// Catches multer's upload errors (e.g. a second file sent under the "ipa" field, which
// maxCount: 1 above rejects) so they come back as the same clean JSON shape every other error on
// these routes uses, instead of Express's default HTML 500 page — the frontend only ever expects
// to res.json() a response body, never HTML.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
        const message =
            err.code === "LIMIT_UNEXPECTED_FILE" && err.field === "ipa"
                ? "only 1 IPA file is accepted"
                : err.code === "LIMIT_FILE_SIZE"
                    ? `file too large — each attachment must be under ${MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024)}MB`
                    : err.message;
        return res.status(400).json({ error: message });
    }
    // Any other upload-time error (e.g. a malformed multipart body) still needs to come back as
    // JSON — Express's default HTML error page makes the frontend's res.json() throw a useless
    // "did not match the expected pattern" error instead of showing what actually broke.
    console.error("upload error:", err);
    res.status(500).json({ error: err?.message || "upload failed" });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
