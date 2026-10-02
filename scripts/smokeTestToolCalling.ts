// Throwaway smoke test — NOT part of the shipped pipeline. Confirms, before any agent-loop code
// is written, that xiaomi/mimo-v2.5 on OpenRouter (a) actually emits tool_calls under both
// toolChoice "auto" and "required" instead of answering in prose, and (b) honors an image
// attached inside a tool-result follow-up turn (needed for the agent loop's cropRegion tool).
// Run: node --require tsx/cjs --env-file=.env scripts/smokeTestToolCalling.ts
import { OpenRouter } from "@openrouter/sdk";
import { readFile } from "fs/promises";
import sharp from "sharp";
import { pdf } from "pdf-to-img";

const MODEL = "xiaomi/mimo-v2.5";

async function getSamplePageBase64(): Promise<string> {
    const pdfPath = "sample-data/137X/137X_Timesheets.pdf";
    const document = await pdf(pdfPath, { scale: 2.0 });
    for await (const pageBuffer of document) {
        return pageBuffer.toString("base64");
    }
    throw new Error("no pages rendered");
}

async function cropTopLeftQuadrant(base64Image: string): Promise<string> {
    const buf = Buffer.from(base64Image, "base64");
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 1000;
    const h = meta.height ?? 1000;
    const out = await sharp(buf).extract({ left: 0, top: 0, width: Math.floor(w / 2), height: Math.floor(h / 2) }).png().toBuffer();
    return out.toString("base64");
}

async function main() {
    const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });
    const pageImage = await getSamplePageBase64();

    const tools = [
        {
            type: "function",
            function: {
                name: "cropRegion",
                description: "Crop a rectangular region of the page image to look closer, using fractional 0-1 coordinates.",
                parameters: {
                    type: "object",
                    properties: {
                        left: { type: "number" },
                        top: { type: "number" },
                        width: { type: "number" },
                        height: { type: "number" },
                    },
                    required: ["left", "top", "width", "height"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: "emitAnswer",
                description: "Call this when you are done, with a short text answer.",
                parameters: {
                    type: "object",
                    properties: { answer: { type: "string" } },
                    required: ["answer"],
                },
            },
        },
    ];

    for (const toolChoice of ["auto", "required"] as const) {
        console.log(`\n=== toolChoice: ${toolChoice} ===`);
        const response = await client.chat.send({
            chatRequest: {
                model: MODEL,
                maxTokens: 2000,
                temperature: 0,
                seed: 42,
                tools,
                toolChoice,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Look at this timesheet page. Call the cropRegion tool to zoom into the top-left area first, then call emitAnswer with a one-sentence description of what you see there." },
                            { type: "image_url", imageUrl: { url: `data:image/png;base64,${pageImage}` } },
                        ],
                    },
                ],
            } as any,
        });

        const choice = (response as any).choices[0];
        console.log("finishReason:", choice.finishReason);
        console.log("content:", choice.message.content);
        console.log("toolCalls:", JSON.stringify(choice.message.toolCalls, null, 2));

        const toolCalls = choice.message.toolCalls;
        if (!toolCalls || toolCalls.length === 0) {
            console.log("NO TOOL CALLS RETURNED — model answered in prose instead.");
            continue;
        }

        // Part B: if the model called cropRegion, execute it and feed the cropped image back as a
        // tool-result follow-up turn, see if the model accepts an image inside a tool message.
        const cropCall = toolCalls.find((tc: any) => tc.function.name === "cropRegion");
        if (!cropCall) {
            console.log("Model didn't call cropRegion first — skipping image-in-tool-result test for this toolChoice.");
            continue;
        }

        const croppedBase64 = await cropTopLeftQuadrant(pageImage);

        console.log("\n--- sending cropped image back as tool result ---");
        const followUp = await client.chat.send({
            chatRequest: {
                model: MODEL,
                maxTokens: 2000,
                temperature: 0,
                seed: 42,
                tools,
                toolChoice: "auto",
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Look at this timesheet page. Call the cropRegion tool to zoom into the top-left area first, then call emitAnswer with a one-sentence description of what you see there." },
                            { type: "image_url", imageUrl: { url: `data:image/png;base64,${pageImage}` } },
                        ],
                    },
                    {
                        role: "assistant",
                        content: choice.message.content ?? "",
                        toolCalls,
                    },
                    {
                        role: "tool",
                        toolCallId: cropCall.id,
                        content: [
                            { type: "text", text: "Here is the cropped top-left region:" },
                            { type: "image_url", imageUrl: { url: `data:image/png;base64,${croppedBase64}` } },
                        ],
                    },
                ],
            } as any,
        });

        const followUpChoice = (followUp as any).choices[0];
        console.log("follow-up finishReason:", followUpChoice.finishReason);
        console.log("follow-up content:", followUpChoice.message.content);
        console.log("follow-up toolCalls:", JSON.stringify(followUpChoice.message.toolCalls, null, 2));
    }
}

main().catch(err => {
    console.error("SMOKE TEST FAILED:", err);
    process.exit(1);
});
