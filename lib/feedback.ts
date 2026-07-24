import { Storage } from "@google-cloud/storage";
import { Firestore, Timestamp } from "@google-cloud/firestore";

// Both clients pick up credentials + project automatically from the Cloud Run service's attached
// service account (or `gcloud auth application-default login` locally) — no explicit key file.
const storage = new Storage();
const firestore = new Firestore();

const BUCKET_NAME = process.env.FLAGGED_PAGES_BUCKET || "twc2-ai-flagged-pages";
const COLLECTION = "flaggedPages";

export type FlaggedPageEntry = {
    date: string;
    type: "worked" | "rest_day" | "hours_worked";
    clockIn?: number | null;
    clockOut?: number | null;
    hoursWorked?: number | null;
    otHours?: number | null;
    guessed?: boolean;
};

// Stores one flagged page's image + before/after entries in GCS/Firestore, for building a
// ground-truth corpus of OCR failures (raw model output vs. what the user actually corrected it
// to) — not for the live scan/generate path, so a failure here shouldn't block the user's actual
// work. Callers should catch and log rather than surface this as a request failure.
export async function uploadFlaggedPage(params: {
    source: string;
    image: string; // base64 PNG, same downscaled copy already shown in the review UI
    rawEntries: FlaggedPageEntry[];
    correctedEntries: FlaggedPageEntry[];
    note: string | null;
    dataModel: string;
    pageContext: string;
}): Promise<{ docId: string }> {
    const docRef = firestore.collection(COLLECTION).doc();
    const objectPath = `${docRef.id}.png`;

    await storage
        .bucket(BUCKET_NAME)
        .file(objectPath)
        .save(Buffer.from(params.image, "base64"), { contentType: "image/png" });

    await docRef.set({
        source: params.source,
        imagePath: `gs://${BUCKET_NAME}/${objectPath}`,
        rawEntries: params.rawEntries,
        correctedEntries: params.correctedEntries,
        note: params.note,
        dataModel: params.dataModel,
        pageContext: params.pageContext,
        flaggedAt: Timestamp.now(),
    });

    return { docId: docRef.id };
}
