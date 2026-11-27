import express from "express";
import multer from "multer";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import * as path from "path";
import { readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { translateTierCondition, parseTierConditionsBatch } from "./lib/tierCondition";
import { buildWorkerPersonalDetailsDocx } from "./lib/workerDetailsDocx";
import { buildWorkerPersonalDetailsPdf } from "./lib/workerDetailsPdf";
import type { WorkerDetailsExportPayload } from "./lib/workerDetailsShared";
import {
    upload,
    SUPPORTED_YEARS,
    enforceTotalUploadSize,
    MAX_TOTAL_UPLOAD_BYTES,
    acquireJobSlot,
    releaseJobSlot,
} from "./lib/jobs/shared";
import { processJobs, runProcessJob, scheduleJobCleanup, type RotationMap } from "./lib/jobs/timesheetJob";
import { bankJobs, runBankStatementJob, scheduleBankJobCleanup, rescanPersistedBankPage } from "./lib/jobs/bankStatementJob";
import { medicalJobs, runMedicalBillsJob, scheduleMedicalJobCleanup, rescanPersistedMedicalBillsPage } from "./lib/jobs/medicalBillsJob";
import { medicalCertJobs, runMedicalCertificateJob, scheduleMedicalCertJobCleanup, rescanPersistedMedicalCertPage } from "./lib/jobs/medicalCertificateJob";
import { payslipJobs, runPayslipJob, schedulePayslipJobCleanup, rescanPersistedPayslipPage } from "./lib/jobs/payslipJob";
import { previewJobs, runPreviewJob, schedulePreviewJobCleanup, blankPreviewJob } from "./lib/jobs/previewJob";
import { rotateImage } from "./lib/ocr";
import {
    ensureClaim,
    getClaimGroup,
    getClaimGroupAny,
    getScanById,
    rehydrateImageRefs,
    updateClaimFields,
    setClaimTitle,
    deleteClaim,
    listClaimsForUser,
    listAllClaims,
    getCostSummary,
    replaceScanPage,
    HISTORY_IMAGES_DIR,
    type ScanType,
} from "./lib/history";

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
const CLAIMS_BASE_URL = "https://cuba.twc2.org.sg";
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

// Pulls the identity fields scan history records are keyed/labeled by out of the decoded camans
// JWT (see the SSO gate above) — the token's shape, confirmed by reading the sibling camans
// identity-provider repo directly (not documented anywhere in this codebase), is
// `{ user: { id, user_fullname, user_email_address, user_role, ... } }`. `user_role` is one of
// "Admin" | "Manager" | "Specialist" | "Associate" | "Recorder" (camans/server/app/controllers/
// system/helper.controller.js:241-256) — camans itself gates every admin-only check with a plain
// `user_role === "Admin"` string comparison (e.g. auth.controller.js:129), not role_id, so this
// matches that exact convention rather than inventing a different one. Falls back to a fixed dev
// identity when DISABLE_SSO is set (the gate above skips verification entirely in that case, so
// there's no real decoded token to read) — scan history still works locally, just attributed to
// one shared "dev" user rather than crashing for lack of a JWT. Defaults that dev identity to
// admin so local testing doesn't dead-end on the one gate that needs a real camans session — has
// no effect in production (SSO always verifies a real token there, this branch never runs).
function getAuthedUser(req: express.Request): { id: number; fullname: string; email: string; isAdmin: boolean } {
    const decoded = (req as any).user?.user;
    if (decoded && typeof decoded.id === "number") {
        return { id: decoded.id, fullname: decoded.user_fullname ?? "", email: decoded.user_email_address ?? "", isAdmin: decoded.user_role === "Admin" };
    }
    return { id: 0, fullname: "dev", email: "dev@localhost", isAdmin: true };
}

/** Shared 403 guard for the admin-only routes below — returns `false` (and has already sent the response) if the caller isn't an admin. */
function requireAdmin(req: express.Request, res: express.Response): boolean {
    if (!getAuthedUser(req).isAdmin) {
        res.status(403).json({ error: "admin access required" });
        return false;
    }
    return true;
}

// Lets the frontend decide whether to show the "Admin dashboard" nav link without duplicating the
// role-check logic client-side — a non-admin simply never sees `isAdmin: true`, never renders the
// link, and would still get a 403 from the admin routes themselves if they somehow hit them directly.
app.get("/api/me", (req, res) => {
    const u = getAuthedUser(req);
    res.json({ id: u.id, fullname: u.fullname, email: u.email, isAdmin: u.isAdmin });
});

app.use(express.static(path.join(__dirname, "public")));

// Renders a thumbnail of every page of every attached file (no OCR/model calls at all — just
// pdf-to-image/image-normalize + downscale, same functions /api/process itself uses to load
// pages) so the browser can show a staging grid right after attaching, before the real (expensive,
// multi-pass) scan runs. Lets a human confirm/rotate a sideways page up front — auto-detecting
// this from the model was tried and found unreliable (see lib/ocr.ts's rotateImage comment).
//
// A background job (like every real scan type), not a single blocking request/response — see
// lib/jobs/previewJob.ts's own comment for why (a large/slow source PDF risked the hosting proxy's
// own timeout killing the connection before a single big response could ever be sent — seen in
// production as a Cloudflare 524 on a 52MB/20-page upload). Returns a job id instantly; the
// frontend polls GET /api/preview/:jobId the same way it already polls every other scan type.
app.post(
    "/api/preview",
    upload.fields([
        { name: "pdfs", maxCount: 10 },
        { name: "ipa", maxCount: 1 },
        { name: "bankStatement", maxCount: 10 },
        { name: "medicalBills", maxCount: 10 },
        { name: "medicalCertificates", maxCount: 10 },
        { name: "payslips", maxCount: 10 },
    ]),
    enforceTotalUploadSize,
    (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const filesByField = {
            pdfs: uploadedFields?.pdfs ?? [],
            ipa: uploadedFields?.ipa?.[0],
            bankStatement: uploadedFields?.bankStatement ?? [],
            medicalBills: uploadedFields?.medicalBills ?? [],
            medicalCertificates: uploadedFields?.medicalCertificates ?? [],
            payslips: uploadedFields?.payslips ?? [],
        };

        const jobId = randomUUID();
        previewJobs.set(jobId, blankPreviewJob());
        acquireJobSlot()
            .then(() => runPreviewJob(jobId, filesByField))
            .catch(e => {
                const job = previewJobs.get(jobId);
                if (job) { job.status = "error"; job.error = e.message; }
            })
            .finally(() => {
                releaseJobSlot();
                schedulePreviewJobCleanup(jobId);
            });

        res.json({ jobId });
    }
);

app.get("/api/preview/:jobId", (req, res) => {
    const job = previewJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({
            error:
                "This preview's progress can't be found anymore. This almost always means the server process restarted while it was still rendering — its in-progress state only lives in memory, not a database, so a restart (a new deploy, or the server recycling itself) wipes it. " +
                "Please re-attach the file(s) to try again.",
        });
    }
    res.json(job);
});

// Resolves the `claimId` a combined "Extract details" submit shares across however many of the 5
// scan-type POSTs it actually fires (public/index.html generates ONE crypto.randomUUID() up front
// and sends it to each — see the client's submit handler). Falls back to minting a fresh one
// server-side for an older/unmodified client that doesn't send one at all, so this never 400s —
// that request just becomes its own standalone single-scan-type claim, same as every claim was
// before this grouping existed.
function resolveClaimId(req: express.Request): string {
    return typeof req.body?.claimId === "string" && req.body.claimId.trim() ? req.body.claimId.trim() : randomUUID();
}

// The "Case label" typed on the main form (e.g. "456K-Hamid") before a combined submit — sent
// identically to all 5 scan types' own POST (same sharing pattern as claimId above), so whichever
// one actually creates the claims row (see ensureClaim) can generate the full title regardless of
// which types were attached to this submit.
function parseTitlePrefix(req: express.Request): string | undefined {
    return typeof req.body?.titlePrefix === "string" && req.body.titlePrefix.trim() ? req.body.titlePrefix.trim() : undefined;
}

app.post(
    "/api/process",
    upload.fields([
        { name: "pdfs", maxCount: 10 },
        { name: "ipa", maxCount: 1 }, // the IPA letter, a single separate document — compulsory even when pdfs (timesheets) are skipped in favor of a payslip
    ]),
    enforceTotalUploadSize,
    (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        // Timesheet files are optional — a claim can run on a payslip's stated OT hours alone (see
        // lib/jobs/payslipJob.ts), with the claim-period dates driving which days get an
        // auto-inserted default-shift row instead of a scanned one. An empty/missing `pdfs` field
        // is treated the same as zero files, not an error.
        const files = uploadedFields?.pdfs ?? [];
        // IPA letter is optional — a caseworker may fill in worker/employer/salary fields by hand
        // instead of uploading one (see public/index.html's blank-IPA render path).
        const ipaFile = uploadedFields?.ipa?.[0];

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

        // Same idea as excludedPages above, but for the IPA letter's own pages (public/index.html's
        // IPA staging grid) — the IPA upload can be multi-page, and runProcessJob picks the first
        // page NOT in this set rather than always assuming page 0.
        let excludedIpaPages = new Set<number>();
        try {
            if (typeof req.body.excludedIpaPages === "string") {
                const parsed = JSON.parse(req.body.excludedIpaPages);
                if (Array.isArray(parsed)) excludedIpaPages = new Set(parsed.map(Number));
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

        // Only sent by the post-scan "resolve this document's reading convention" rescan flow
        // (public/index.html) — a caseworker's answer to a structural interpretation question the
        // agentic loop flagged across several pages of the same document. See runProcessJob's
        // interpretationHint param comment.
        const interpretationHint = typeof req.body.interpretationHint === "string" && req.body.interpretationHint.trim() ? req.body.interpretationHint.trim() : undefined;

        // The caseworker's declared claim period (public/index.html's contractStartDate/
        // contractEndDate fields) — see runProcessJob's claimStartDate/claimEndDate param comments
        // for why this must reach the server rather than being enforced client-side only. A malformed
        // or absent value is treated as "not declared" (undefined), not an error — the claim period
        // is optional, and runProcessJob only filters on the side(s) actually declared.
        const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
        const claimStartDate = isYmd(req.body.claimStartDate) ? req.body.claimStartDate : undefined;
        const claimEndDate = isYmd(req.body.claimEndDate) ? req.body.claimEndDate : undefined;

        // A real scan (many pages, sequential) can run 15-20+ minutes — long enough that holding this
        // HTTP request open the whole time is fragile (proxies/networks can drop a connection that
        // long) and gives the browser zero visibility into progress until the very end. Instead: kick
        // the scan off as a background job and return its id immediately; public/index.html polls
        // GET /api/process/:jobId, which renders each page's card as soon as that page finishes rather
        // than waiting for the entire batch.
        const jobId = randomUUID();
        const claimId = resolveClaimId(req);
        const controller = new AbortController();
        const authedUser = getAuthedUser(req);
        // The "Reading notes for this scan" text, if any, becomes the claim's initial case note —
        // see ensureClaim's own comment on why.
        ensureClaim(claimId, authedUser.id, authedUser.fullname, authedUser.email, interpretationHint, parseTitlePrefix(req));
        processJobs.set(jobId, {
            status: "running",
            pages: [],
            result: null,
            error: null,
            events: [],
            controller,
            userId: authedUser.id,
            userFullname: authedUser.fullname,
            userEmail: authedUser.email,
        });
        // Cloud Run would just add instances under load; a fixed VPS can't — acquireJobSlot queues
        // this job's actual work (not the response below, which returns immediately either way)
        // until a concurrency slot is free, so peak memory/CPU stays bounded to MAX_CONCURRENT_JOBS
        // regardless of how many caseworkers upload at the same moment.
        acquireJobSlot()
            .then(() => runProcessJob(jobId, claimId, undefined, files, ipaFile, rotations, excludedPages, excludedIpaPages, standardBreakHours, fallbackYear, controller.signal, interpretationHint, claimStartDate, claimEndDate))
            .catch(e => {
                const job = processJobs.get(jobId);
                if (job && job.status === "running") { job.status = "error"; job.error = e.message; }
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
    // This is a live-progress poll, not a cacheable resource — the response changes on every call
    // while a job is running. Without this header some browsers/proxies can serve a cached copy of
    // an earlier response for repeated identical GETs to the same URL, which would make the client's
    // live event feed/page cards appear frozen until the cache finally invalidates.
    res.set("Cache-Control", "no-store");
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
    // completed, still in upload-order relative to each other. `controller` is deliberately
    // excluded — an AbortController isn't meaningfully serializable and the client has no use for it.
    res.json({ ...job, controller: undefined, userId: undefined, userFullname: undefined, userEmail: undefined, pages: job.pages.filter(p => p !== undefined) });
});

// Lets a caseworker stop a running scan mid-way — most useful now that discovery is agentic
// (lib/ocr/agentLoop.ts): loop length/cost per page is no longer fixed the way a single prompt
// call was, so a job that's clearly going sideways (or just taking too long) is worth being able
// to cut off rather than only ever waiting it out. Already-finished pages are kept; in-flight
// pages are aborted via the job's AbortController (threaded all the way down to individual vision
// calls, see lib/ocr/visionClient.ts's signal param) rather than left to finish.
app.post("/api/process/:jobId/cancel", (req, res) => {
    const job = processJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    if (job.status === "running") {
        job.controller.abort();
        job.status = "cancelled";
    }
    res.json({ status: job.status });
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
        // Same single-page "Rescan" popup hint as /api/process — see that route's comment.
        const interpretationHint = typeof req.body.interpretationHint === "string" && req.body.interpretationHint.trim() ? req.body.interpretationHint.trim() : undefined;

        const jobId = randomUUID();
        const claimId = resolveClaimId(req);
        const authedUser = getAuthedUser(req);
        ensureClaim(claimId, authedUser.id, authedUser.fullname, authedUser.email, undefined, parseTitlePrefix(req));
        bankJobs.set(jobId, { status: "running", pages: [], result: null, error: null, userId: authedUser.id, userFullname: authedUser.fullname, userEmail: authedUser.email });
        acquireJobSlot()
            .then(() => runBankStatementJob(jobId, claimId, undefined, files, rotations, excludedPages, interpretationHint))
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
    res.json({ ...job, userId: undefined, userFullname: undefined, userEmail: undefined, pages: job.pages.filter(p => p !== undefined) });
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
        // Same single-page "Rescan" popup hint as /api/process — see that route's comment.
        const interpretationHint = typeof req.body.interpretationHint === "string" && req.body.interpretationHint.trim() ? req.body.interpretationHint.trim() : undefined;

        const jobId = randomUUID();
        const claimId = resolveClaimId(req);
        const authedUser = getAuthedUser(req);
        ensureClaim(claimId, authedUser.id, authedUser.fullname, authedUser.email, undefined, parseTitlePrefix(req));
        medicalJobs.set(jobId, { status: "running", pages: [], result: null, error: null, userId: authedUser.id, userFullname: authedUser.fullname, userEmail: authedUser.email });
        acquireJobSlot()
            .then(() => runMedicalBillsJob(jobId, claimId, undefined, files, rotations, excludedPages, interpretationHint))
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
    res.json({ ...job, userId: undefined, userFullname: undefined, userEmail: undefined, pages: job.pages.filter(p => p !== undefined) });
});

// A medical certificate (MC) is a distinct document from a medical bill/invoice — see
// lib/medicalCertificates.ts — so it's its own upload/job/endpoint rather than folded into
// /api/medical-bills above. Mirrors that endpoint's structure exactly.
app.post(
    "/api/medical-certificates",
    upload.fields([{ name: "medicalCertificates", maxCount: 10 }]),
    enforceTotalUploadSize,
    (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.medicalCertificates;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No medical certificate files uploaded." });
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
        // Same single-page "Rescan" popup hint as /api/process — see that route's comment.
        const interpretationHint = typeof req.body.interpretationHint === "string" && req.body.interpretationHint.trim() ? req.body.interpretationHint.trim() : undefined;

        const jobId = randomUUID();
        const claimId = resolveClaimId(req);
        const authedUser = getAuthedUser(req);
        ensureClaim(claimId, authedUser.id, authedUser.fullname, authedUser.email, undefined, parseTitlePrefix(req));
        medicalCertJobs.set(jobId, { status: "running", pages: [], result: null, error: null, userId: authedUser.id, userFullname: authedUser.fullname, userEmail: authedUser.email });
        acquireJobSlot()
            .then(() => runMedicalCertificateJob(jobId, claimId, undefined, files, rotations, excludedPages, interpretationHint))
            .catch(e => {
                const job = medicalCertJobs.get(jobId);
                if (job) { job.status = "error"; job.error = e.message; }
            })
            .finally(() => {
                releaseJobSlot();
                scheduleMedicalCertJobCleanup(jobId);
            });

        res.json({ jobId });
    }
);

app.get("/api/medical-certificates/:jobId", (req, res) => {
    const job = medicalCertJobs.get(req.params.jobId);
    if (!job) {
        console.error(`GET /api/medical-certificates/${req.params.jobId}: job not found (jobs map has ${medicalCertJobs.size} entr${medicalCertJobs.size === 1 ? "y" : "ies"})`);
        return res.status(404).json({
            error:
                "This medical certificate scan's progress can't be found anymore. This almost always means the server process restarted while the scan was still running — its in-progress state only lives in memory, not a database, so a restart (a new deploy, or the server recycling itself) wipes it. " +
                "It is NOT something you did wrong, and nothing about your uploaded files caused it. " +
                "Nothing can be recovered from this specific scan — please re-upload and start it again. " +
                `(job id: ${req.params.jobId}, if this keeps happening please share this id and the approximate time)`,
        });
    }
    res.json({ ...job, userId: undefined, userFullname: undefined, userEmail: undefined, pages: job.pages.filter(p => p !== undefined) });
});

// A payslip states overtime hours the employer already worked out for some period (day/week/
// month) — a distinct document from a timesheet's daily punch log. Mirrors the medical
// certificates endpoint's structure exactly.
app.post(
    "/api/payslips",
    upload.fields([{ name: "payslips", maxCount: 10 }]),
    enforceTotalUploadSize,
    (req, res) => {
        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.payslips;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No payslip files uploaded." });
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
        // Same single-page "Rescan" popup hint as /api/process — see that route's comment.
        const interpretationHint = typeof req.body.interpretationHint === "string" && req.body.interpretationHint.trim() ? req.body.interpretationHint.trim() : undefined;

        const jobId = randomUUID();
        const claimId = resolveClaimId(req);
        const authedUser = getAuthedUser(req);
        ensureClaim(claimId, authedUser.id, authedUser.fullname, authedUser.email, undefined, parseTitlePrefix(req));
        payslipJobs.set(jobId, { status: "running", pages: [], result: null, error: null, userId: authedUser.id, userFullname: authedUser.fullname, userEmail: authedUser.email });
        acquireJobSlot()
            .then(() => runPayslipJob(jobId, claimId, undefined, files, rotations, excludedPages, interpretationHint))
            .catch(e => {
                const job = payslipJobs.get(jobId);
                if (job) { job.status = "error"; job.error = e.message; }
            })
            .finally(() => {
                releaseJobSlot();
                schedulePayslipJobCleanup(jobId);
            });

        res.json({ jobId });
    }
);

app.get("/api/payslips/:jobId", (req, res) => {
    const job = payslipJobs.get(req.params.jobId);
    if (!job) {
        console.error(`GET /api/payslips/${req.params.jobId}: job not found (jobs map has ${payslipJobs.size} entr${payslipJobs.size === 1 ? "y" : "ies"})`);
        return res.status(404).json({
            error:
                "This payslip scan's progress can't be found anymore. This almost always means the server process restarted while the scan was still running — its in-progress state only lives in memory, not a database, so a restart (a new deploy, or the server recycling itself) wipes it. " +
                "It is NOT something you did wrong, and nothing about your uploaded files caused it. " +
                "Nothing can be recovered from this specific scan — please re-upload and start it again. " +
                `(job id: ${req.params.jobId}, if this keeps happening please share this id and the approximate time)`,
        });
    }
    res.json({ ...job, userId: undefined, userFullname: undefined, userEmail: undefined, pages: job.pages.filter(p => p !== undefined) });
});

// Scan history — the first persistent store in this app (see lib/history.ts). Every finished scan
// of any of the 5 types above gets a row here via persistScan(), keyed to whichever caseworker ran
// it (from the SSO JWT, see getAuthedUser above), and grouped into a "claim" (lib/history.ts's
// `claims` table) alongside any OTHER scan types submitted in the same combined "Extract details"
// click. These routes let a caseworker revisit a past claim: list their own claims, fetch one in
// full — EVERY scan type it contains at once, not just one — re-rendered through the same review
// UI a live multi-type scan uses, and view its page images.
//
// Lists the current user's claims, most recent first — one row per claim (however many scan types
// it contains), never includes result_json (could be large for a timesheet's pageReviews), just
// enough to render a history list row. `rows[].groupId` is what every other /api/claims/* route
// below expects as its :groupId param.
app.get("/api/history", (req, res) => {
    const userId = getAuthedUser(req).id;
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const scanType = typeof req.query.type === "string" ? req.query.type : undefined;
    const search = typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : undefined;
    const { rows, total } = listClaimsForUser(userId, { limit, offset, scanType, search });
    res.json({ rows, total, limit, offset });
});

// "All claims" dashboard — oversight across every caseworker's claims, not just the requester's
// own. Open to any authenticated user (not admin-gated) — a caseworker can review any claim the
// same way an admin does. Cost figures are the one thing still admin-only: stripped from the
// listing below for a non-admin, and getCostSummary (its own separate endpoint) stays behind
// requireAdmin entirely.
app.get("/api/admin/scans", (req, res) => {
    const authedUser = getAuthedUser(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const scanType = typeof req.query.type === "string" ? req.query.type : undefined;
    const userId = req.query.userId !== undefined ? Number(req.query.userId) : undefined;
    const search = typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : undefined;
    const { rows, total } = listAllClaims({ limit, offset, scanType, userId, search });
    const visibleRows = authedUser.isAdmin ? rows : rows.map(({ costUsd, ...rest }) => rest);
    res.json({ rows: visibleRows, total, limit, offset });
});

// Cost/spend rollups — admin-only, unlike the scan listing above. This is the one piece of the
// admin dashboard that stays gated (see requireAdmin).
app.get("/api/admin/cost-summary", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(getCostSummary());
});

// Full saved claim, every scan type it contains at once — no ownership check (see
// getClaimGroupAny: any authenticated user can view any claim, same as the "All claims" listing
// above). Cost is still admin-only, so costUsd is omitted entirely for a non-admin rather than
// sent and merely hidden client-side. Image fields are rewritten from their stored {ref} markers
// to this route's own URLs at READ time (not persist time), so the route prefix never gets baked
// into stored data — keyed by each underlying SCAN's own id (not the claim's groupId), since each
// scan type within a combined claim still has its own separate on-disk image directory.
app.get("/api/claims/:groupId", (req, res) => {
    const authedUser = getAuthedUser(req);
    const group = getClaimGroupAny(req.params.groupId);
    if (!group) return res.status(404).json({ error: "claim not found" });
    const types: Partial<Record<ScanType, unknown>> = {};
    let totalCostUsd = 0;
    for (const scan of group.scans) {
        types[scan.scan_type] = {
            id: scan.id,
            title: scan.title,
            createdAt: scan.created_at,
            durationMs: scan.duration_ms,
            userId: scan.user_id,
            userFullname: scan.user_fullname,
            result: rehydrateImageRefs(scan.id, JSON.parse(scan.result_json)),
        };
        totalCostUsd += scan.cost_usd ?? 0;
    }
    res.json({
        groupId: req.params.groupId,
        title: group.claim?.title ?? group.scans.find(s => s.title)?.title ?? null,
        notes: group.claim?.notes ?? null,
        createdAt: group.claim?.created_at ?? group.scans.map(s => s.created_at).sort().pop() ?? null,
        costUsd: authedUser.isAdmin ? totalCostUsd : undefined,
        types,
    });
});

// Streams one page image from a saved scan — no ownership check, same as the route above (any
// authenticated user can view any scan's images). Keyed by the SCAN's own id (not a claim
// groupId) — see getClaimGroup/:groupId route's own comment on why. :ref is whitelisted before
// being joined into a path even though it's always server-generated (see persistScan's writeImage
// helper), never taken directly off a client-controlled value.
app.get("/api/history/:scanId/image/:ref", (req, res) => {
    const scan = getScanById(req.params.scanId);
    if (!scan) return res.status(404).json({ error: "scan not found" });
    if (!/^[a-zA-Z0-9_-]+$/.test(req.params.ref)) return res.status(400).json({ error: "invalid image ref" });
    res.sendFile(path.join(HISTORY_IMAGES_DIR, scan.id, `${req.params.ref}.png`), err => {
        if (err) res.status(404).json({ error: "image not found" });
    });
});

// Persists an edit made while viewing a claim — e.g. fixing a misread clock time on one of its
// scan types, and/or updating its case note — so it survives leaving the page, same durability the
// live review already has once you click Generate. Scoped per scan type to just the one editable
// array that type actually has (reviewRows/transactions/entries — see lib/history.ts's
// EDITABLE_FIELD_BY_SCAN_TYPE); nothing else in a saved scan (images, scan_type, cost) can be
// touched through this route. `types` only needs to include whichever scan types are actually
// present/edited on screen — a type this claim doesn't have is silently ignored for timesheet
// (no manual-entry UI for it); for bank_statement/medical_bills/medical_certificates/payslips,
// non-empty rows for a not-yet-present type create a brand-new zero-cost scan row (see
// lib/history.ts's updateClaimFields) — this is how "manually add a bank transaction/payslip
// entry with no file ever uploaded" gets persisted.
app.put("/api/claims/:groupId", express.json({ limit: "5mb" }), (req, res) => {
    const userId = getAuthedUser(req).id;
    const rawTypes = req.body?.types;
    const perTypeRows: Partial<Record<ScanType, { rows: unknown[]; ipa?: unknown }>> = {};
    if (rawTypes && typeof rawTypes === "object") {
        for (const [scanType, edit] of Object.entries(rawTypes)) {
            if (edit && typeof edit === "object" && Array.isArray((edit as any).rows)) {
                perTypeRows[scanType as ScanType] = { rows: (edit as any).rows, ipa: (edit as any).ipa };
            }
        }
    }
    // A caseworker's own free-text annotation/title, independent of scan_type — undefined when the
    // client genuinely didn't send the field at all (leaves the stored value untouched); an
    // explicit "" clears it. See updateClaimFields's own comment on the same distinction.
    const notes = typeof req.body?.notes === "string" ? req.body.notes : undefined;
    const title = typeof req.body?.title === "string" ? req.body.title : undefined;
    const updated = updateClaimFields(req.params.groupId, userId, perTypeRows, notes, title);
    if (!updated) return res.status(404).json({ error: "claim not found" });
    res.json({ success: true });
});

// Generates (or regenerates) a claim's title from a caseworker-typed "Case label" prefix — e.g.
// "456K-Hamid" -> "456K-Hamid-20261127-01" (today's date + an auto-incrementing counter scoped to
// that exact prefix, see lib/history.ts's nextTitleForPrefix). The explicit, caseworker-initiated
// counterpart to ensureClaim's own automatic once-only fill at submit time — always overwrites any
// existing title, since a caseworker clicking "Generate ID" again (e.g. after fixing a typo) means
// it. Owner-scoped (setClaimTitle), same edit-class trust boundary as PUT/DELETE above.
app.post("/api/claims/:groupId/generate-title", express.json({ limit: "1kb" }), (req, res) => {
    const userId = getAuthedUser(req).id;
    const prefix = typeof req.body?.prefix === "string" ? req.body.prefix.trim() : "";
    if (!prefix) return res.status(400).json({ error: "prefix required" });
    const title = setClaimTitle(req.params.groupId as string, userId, prefix);
    if (title === null) return res.status(404).json({ error: "claim not found" });
    res.json({ title });
});

// Deletes a claim (every scan type it contains) a caseworker performed themselves — owner-scoped
// only, same as the edit route above (no admin bypass; being able to VIEW any claim via the "All
// claims" dashboard doesn't imply being able to delete someone else's). 404s identically whether
// the id doesn't exist at all or just isn't owned by this user, same no-existence-leak behavior as
// every other owner-scoped route.
app.delete("/api/claims/:groupId", async (req, res) => {
    const userId = getAuthedUser(req).id;
    const deleted = await deleteClaim(req.params.groupId, userId);
    if (!deleted) return res.status(404).json({ error: "claim not found" });
    res.json({ success: true });
});

// "Add more X files" against an EXISTING claim — lets a caseworker reopen a saved claim (from
// history, or right after it just finished live) and attach one more document, either for a scan
// type the claim already has (merged into that scan's own existing rows via appendScanPages) or a
// type it doesn't have yet (a fresh scan row, same as a normal submit, just tagged with this
// claim's groupId instead of minting a new one). One route for all 5 scan types — `scanType` in
// the body picks which. Owner-scoped (getClaimGroup, not getClaimGroupAny) — this is an edit-class
// action, same trust boundary as PUT/DELETE above, explicitly NOT the open-to-every-authenticated-
// user GET routes.
//
// Timesheet's append reuses runProcessJob WHOLESALE (same agentic discovery, same IPA-untouched
// behavior since `ipaFile` is always undefined here) rather than a bespoke lighter path — appending
// is structurally "scan these new files, merge the resulting pages/rows into the existing scan",
// exactly what appendScanPages already does (see lib/history.ts, whose timesheet branch was
// written to support this from the start). What's genuinely NOT supported here: RESCANNING one
// already-persisted timesheet PAGE in place (as opposed to appending whole new pages) — unlike the
// other 4 types' flat per-page transactions/entries array, a timesheet page's rows don't carry a
// stable identifier back to "replace this exact page" without re-deriving a matching `source`
// string, which only a real multi-page file (not a single reconstructed page image) can reproduce
// correctly — see POST /api/claims/:groupId/rescan-page, which only accepts the other 4 types.
app.post(
    "/api/claims/:groupId/append",
    upload.fields([
        { name: "pdfs", maxCount: 10 },
        { name: "statements", maxCount: 10 },
        { name: "medicalBills", maxCount: 10 },
        { name: "medicalCertificates", maxCount: 10 },
        { name: "payslips", maxCount: 10 },
    ]),
    enforceTotalUploadSize,
    (req, res) => {
        const userId = getAuthedUser(req).id;
        const scanType = req.body?.scanType;
        const FIELD_BY_SCAN_TYPE: Record<string, string> = {
            timesheet: "pdfs",
            bank_statement: "statements",
            medical_bills: "medicalBills",
            medical_certificates: "medicalCertificates",
            payslips: "payslips",
        };
        const fieldName = FIELD_BY_SCAN_TYPE[scanType];
        if (!fieldName) return res.status(400).json({ error: `Unknown or unsupported scanType: ${scanType}` });

        // Express 5's path-to-regexp-derived param typing infers `string | string[]` for this
        // route's `:groupId` (a quirk of the trailing `/append` segment, unlike the simpler
        // "/api/claims/:groupId" GET/PUT/DELETE routes above) — it's always a plain string at
        // runtime for a route with no repeating segments; narrowed once here.
        const groupId = req.params.groupId as string;
        const group = getClaimGroup(groupId, userId);
        if (!group) return res.status(404).json({ error: "claim not found" });
        const appendToScanId = group.scans.find(s => s.scan_type === scanType)?.id;

        const uploadedFields = req.files as { [field: string]: Express.Multer.File[] } | undefined;
        const files = uploadedFields?.[fieldName];
        if (!files || files.length === 0) return res.status(400).json({ error: "No files uploaded." });

        // Same staging-confirmed rotation/exclusion/interpretation-hint parsing every normal scan
        // POST route already uses — see e.g. /api/bank-statement above.
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
        const interpretationHint = typeof req.body.interpretationHint === "string" && req.body.interpretationHint.trim() ? req.body.interpretationHint.trim() : undefined;

        const jobId = randomUUID();
        const claimId = groupId;
        const authedUser = getAuthedUser(req);

        if (scanType === "timesheet") {
            // runProcessJob expects RotationMap's nested `{pdfs:{...}, ipa:{...}}` shape, unlike the
            // flat `Record<string, number>` the other 4 types' `rotations` variable above was
            // already parsed as — re-parsed here specifically for this branch.
            let timesheetRotations: RotationMap = {};
            try {
                const parsed = JSON.parse(req.body.rotations ?? "{}");
                if (parsed && typeof parsed === "object") timesheetRotations = parsed;
            } catch {
                // ignore — fall through with no rotations applied
            }
            // Same parsing as the main /api/process route's standardBreakHours/fallbackYear/
            // claimStartDate/claimEndDate — ipaFile is always undefined here (appending more
            // timesheet pages never re-sends/replaces the IPA letter this claim already has) and
            // excludedIpaPages is always empty for the same reason.
            const parsedBreakHours = Number(req.body.standardBreakHours);
            const standardBreakHours = Number.isFinite(parsedBreakHours) && parsedBreakHours >= 0 ? parsedBreakHours : 1;
            const parsedFallbackYear = Number(req.body.fallbackYear);
            const fallbackYear = Number.isFinite(parsedFallbackYear) && SUPPORTED_YEARS.includes(parsedFallbackYear) ? parsedFallbackYear : undefined;
            const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
            const claimStartDate = isYmd(req.body.claimStartDate) ? req.body.claimStartDate : undefined;
            const claimEndDate = isYmd(req.body.claimEndDate) ? req.body.claimEndDate : undefined;

            const controller = new AbortController();
            processJobs.set(jobId, {
                status: "running", pages: [], result: null, error: null, events: [], controller,
                userId: authedUser.id, userFullname: authedUser.fullname, userEmail: authedUser.email,
            });
            acquireJobSlot()
                .then(() => runProcessJob(jobId, claimId, appendToScanId, files, undefined, timesheetRotations, excludedPages, new Set(), standardBreakHours, fallbackYear, controller.signal, interpretationHint, claimStartDate, claimEndDate))
                .catch(e => { const job = processJobs.get(jobId); if (job && job.status === "running") { job.status = "error"; job.error = e.message; } })
                .finally(() => { releaseJobSlot(); scheduleJobCleanup(jobId); });
            return res.json({ jobId });
        }

        if (scanType === "bank_statement") {
            bankJobs.set(jobId, { status: "running", pages: [], result: null, error: null, userId: authedUser.id, userFullname: authedUser.fullname, userEmail: authedUser.email });
            acquireJobSlot()
                .then(() => runBankStatementJob(jobId, claimId, appendToScanId, files, rotations, excludedPages, interpretationHint))
                .catch(e => { const job = bankJobs.get(jobId); if (job) { job.status = "error"; job.error = e.message; } })
                .finally(() => { releaseJobSlot(); scheduleBankJobCleanup(jobId); });
        } else if (scanType === "medical_bills") {
            medicalJobs.set(jobId, { status: "running", pages: [], result: null, error: null, userId: authedUser.id, userFullname: authedUser.fullname, userEmail: authedUser.email });
            acquireJobSlot()
                .then(() => runMedicalBillsJob(jobId, claimId, appendToScanId, files, rotations, excludedPages, interpretationHint))
                .catch(e => { const job = medicalJobs.get(jobId); if (job) { job.status = "error"; job.error = e.message; } })
                .finally(() => { releaseJobSlot(); scheduleMedicalJobCleanup(jobId); });
        } else if (scanType === "medical_certificates") {
            medicalCertJobs.set(jobId, { status: "running", pages: [], result: null, error: null, userId: authedUser.id, userFullname: authedUser.fullname, userEmail: authedUser.email });
            acquireJobSlot()
                .then(() => runMedicalCertificateJob(jobId, claimId, appendToScanId, files, rotations, excludedPages, interpretationHint))
                .catch(e => { const job = medicalCertJobs.get(jobId); if (job) { job.status = "error"; job.error = e.message; } })
                .finally(() => { releaseJobSlot(); scheduleMedicalCertJobCleanup(jobId); });
        } else {
            payslipJobs.set(jobId, { status: "running", pages: [], result: null, error: null, userId: authedUser.id, userFullname: authedUser.fullname, userEmail: authedUser.email });
            acquireJobSlot()
                .then(() => runPayslipJob(jobId, claimId, appendToScanId, files, rotations, excludedPages, interpretationHint))
                .catch(e => { const job = payslipJobs.get(jobId); if (job) { job.status = "error"; job.error = e.message; } })
                .finally(() => { releaseJobSlot(); schedulePayslipJobCleanup(jobId); });
        }

        res.json({ jobId });
    }
);

// Rescans ONE already-persisted page image against a claim's existing scan — e.g. a caseworker
// reopens a saved claim and wants to re-read a page the model misread, without re-uploading
// anything (the original file is long gone; the stored PNG is all that's left, and all that's
// actually needed — every scan primitive these 4 types use already operates on a rendered image
// buffer, never the original PDF). Single request/response (no background job + polling) since
// this is only ever ONE page's worth of vision calls, not a whole batch. Owner-scoped
// (getClaimGroup) — an edit-class action, same trust boundary as append/PUT/DELETE above.
// Timesheet is NOT supported here (see replaceScanPage's own comment) — Phase 5 territory.
app.post("/api/claims/:groupId/rescan-page", express.json({ limit: "1mb" }), async (req, res) => {
    const userId = getAuthedUser(req).id;
    const scanType = req.body?.scanType;
    const RESCAN_FN_BY_SCAN_TYPE: Record<string, (img: string, hint?: string) => Promise<{ transactions?: unknown[]; entries?: unknown[]; costUsd: number }>> = {
        bank_statement: rescanPersistedBankPage as any,
        medical_bills: rescanPersistedMedicalBillsPage as any,
        medical_certificates: rescanPersistedMedicalCertPage as any,
        payslips: rescanPersistedPayslipPage as any,
    };
    const rescanFn = RESCAN_FN_BY_SCAN_TYPE[scanType];
    if (!rescanFn) return res.status(400).json({ error: `Unknown or unsupported scanType for rescan: ${scanType}` });

    const pageIndex = Number(req.body?.pageIndex);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) return res.status(400).json({ error: "pageIndex (non-negative integer) required" });

    const group = getClaimGroup(req.params.groupId as string, userId);
    if (!group) return res.status(404).json({ error: "claim not found" });
    const scan = group.scans.find(s => s.scan_type === scanType);
    if (!scan) return res.status(404).json({ error: `this claim has no ${scanType} scan to rescan a page of` });

    const imagePath = path.join(HISTORY_IMAGES_DIR, scan.id, `page-${pageIndex}.png`);
    if (!existsSync(imagePath)) return res.status(404).json({ error: "page image not found" });
    let pageImageBase64 = readFileSync(imagePath).toString("base64");

    const rotationDeg = Number(req.body?.rotationDeg) || 0;
    let rotated = false;
    if (rotationDeg % 360 !== 0) {
        pageImageBase64 = await rotateImage(pageImageBase64, rotationDeg);
        rotated = true;
    }
    const interpretationHint = typeof req.body?.interpretationHint === "string" && req.body.interpretationHint.trim() ? req.body.interpretationHint.trim() : undefined;

    try {
        const result = await rescanFn(pageImageBase64, interpretationHint);
        const pageEntries = result.transactions ?? result.entries ?? [];
        const updated = replaceScanPage(scan.id, userId, pageIndex, {
            newImageBase64: rotated ? pageImageBase64 : undefined,
            pageEntries,
            costUsd: result.costUsd,
            durationMs: 0,
        });
        if (!updated) return res.status(404).json({ error: "page not found on this scan" });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ error: e?.message ?? "rescan failed" });
    }
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
    if (!p || typeof p.basicSalary !== "number" || !p.basic || !p.allowances || !p.nonFixedAllowance || !p.overtime || !p.restDays || !p.publicHolidays) {
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
    if (!p || typeof p.basicSalary !== "number" || !p.basic || !p.allowances || !p.nonFixedAllowance || !p.overtime || !p.restDays || !p.publicHolidays) {
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

// Non-fixed-allowance tier conditions (public/index.html) can be typed in plain English — this
// translates one sentence into the client's structured expression grammar via a cheap text LLM
// call (see lib/tierCondition.ts). The client ALWAYS re-compiles/validates whatever comes back
// before using it (same as a hand-typed condition) — this endpoint only proposes a candidate, it
// never becomes a trusted, unchecked input to the actual money math.
app.post("/api/translate-tier-condition", express.json({ limit: "10kb" }), async (req, res) => {
    const { text } = req.body ?? {};
    if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "text is required" });
    }
    try {
        const { expression, cost } = await translateTierCondition(text.trim());
        res.json({ success: true, expression, costUsd: cost });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// Batch sibling to /api/translate-tier-condition — the caseworker writes every non-fixed-allowance
// rule as one free-written paragraph (public/index.html's single textarea), and this extracts
// every distinct {condition, amount} rule out of it in one call, run once at "Extract details"
// time rather than live per tier. Same trust boundary as the single-condition endpoint: the client
// re-compiles/validates every returned condition before using it.
app.post("/api/parse-tier-conditions", express.json({ limit: "20kb" }), async (req, res) => {
    const { text } = req.body ?? {};
    if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "text is required" });
    }
    try {
        const { tiers, cost } = await parseTierConditionsBatch(text.trim());
        res.json({ success: true, tiers, costUsd: cost });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
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
