import { describe, expect, it } from "vitest";
import { extractJsonBlock } from "../../lib/ocr/visionClient";

describe("extractJsonBlock", () => {
    it("strips a ```json fenced block", () => {
        const text = "```json\n[{\"day\":1}]\n```";
        expect(extractJsonBlock(text)).toBe('[{"day":1}]');
    });

    it("strips a fenced block with no language tag", () => {
        const text = "```\n{\"a\":1}\n```";
        expect(extractJsonBlock(text)).toBe('{"a":1}');
    });

    it("slices from the first [ to the last ] when the reply is an unfenced array with surrounding prose", () => {
        const text = 'Sure, here you go: [{"day":1},{"day":2}] hope that helps!';
        expect(extractJsonBlock(text)).toBe('[{"day":1},{"day":2}]');
    });

    it("slices from the first { to the last } when the reply is an unfenced object with surrounding prose", () => {
        const text = '> {"worker": "Ali", "salary": 1200} <- extracted';
        expect(extractJsonBlock(text)).toBe('{"worker": "Ali", "salary": 1200}');
    });

    it("prefers the object when it opens before an array nested inside it", () => {
        const text = '{"fixedMonthlyAllowances": [], "basicSalary": 1200}';
        expect(extractJsonBlock(text)).toBe(text);
    });

    it("prefers the array when the reply's top-level shape is genuinely an array", () => {
        const text = '[{"times": [800, 1700]}, {"times": [900, 1800]}]';
        expect(extractJsonBlock(text)).toBe(text);
    });

    it("returns the text unchanged when no bracket can be found at all", () => {
        const text = "I could not read this page.";
        expect(extractJsonBlock(text)).toBe(text);
    });
});
