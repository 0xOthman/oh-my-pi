import * as ffi from "bun:ffi";
import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as tui from "@oh-my-pi/pi-tui";
import { CURSOR_MARKER, visibleWidth } from "@oh-my-pi/pi-tui";
import { createArabicRowRenderer } from "../examples/extensions/arabic-rtl";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Arabic display failure safety", () => {
	test("an unavailable native library preserves the complete row and is retried", () => {
		const load = spyOn(ffi, "dlopen").mockImplementation(() => {
			throw new Error("ICU unavailable");
		});
		const render = createArabicRowRenderer();
		const row = `\x1b[31mمرحبا 👩‍💻 中\x1b[0m${CURSOR_MARKER}`;
		expect(render(row)).toBe(row);
		expect(render(row)).toBe(row);
		expect(load).toHaveBeenCalledTimes(2);
	});

	test("opaque terminal commands are preserved without loading ICU", () => {
		const load = spyOn(ffi, "dlopen").mockImplementation(() => {
			throw new Error("Opaque commands must not reach ICU");
		});
		const render = createArabicRowRenderer();
		// Recognized CSI command that is not SGR, and an opaque DCS sequence.
		for (const row of ["بت\x1b[2K", "بت\x1bPopaque\x1b\\"]) {
			expect(render(row)).toBe(row);
		}
		expect(load).not.toHaveBeenCalled();
	});
});

describe.skipIf(process.platform !== "win32")("Windows Arabic display extension", () => {
	test("joins letters and puts an Arabic word in visual order", () => {
		const render = createArabicRowRenderer();
		// Beh initial + teh final in logical order become teh final + beh initial.
		expect(Bun.stripANSI(render("بت"))).toBe("\ufe96\ufe91");
	});

	test("lam-alef keeps both editor cells and the logical cursor boundary", () => {
		const render = createArabicRowRenderer();
		const row = `ل${CURSOR_MARKER}ا`;
		const visual = render(row);
		expect(Bun.stripANSI(visual.replace(CURSOR_MARKER, ""))).toBe("\ufe8e\ufedf");
		expect(visual.split(CURSOR_MARKER)).toHaveLength(2);
		expect(visibleWidth(visual.slice(0, visual.indexOf(CURSOR_MARKER)))).toBe(1);
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});

	test("diacritics stay attached to their base letter without adding cells", () => {
		const render = createArabicRowRenderer();
		const row = "بَت";
		expect(Bun.stripANSI(render(row))).toBe("\ufe96\ufe91َ");
		expect(visibleWidth(render(row))).toBe(visibleWidth(row));
	});

	test("reordering keeps colors with letters and leaves table cells separate", () => {
		const render = createArabicRowRenderer();
		const row = "│ \x1b[31mب\x1b[32mت\x1b[0m │ path/file.ts 123 │";
		const visual = render(row);
		expect(Bun.stripANSI(visual)).toBe("│ \ufe96\ufe91 │ path/file.ts 123 │");
		expect(visual).toContain("\x1b[32m\ufe96");
		expect(visual).toContain("\x1b[0m\x1b[31m\ufe91");
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});

	test.each(["╰─ ", "❯ "])("the %s Composer gutter stays left of Arabic input and its cursor", gutter => {
		const render = createArabicRowRenderer();
		const row = `${gutter}بت${CURSOR_MARKER}   `;
		const visual = render(row);
		expect(Bun.stripANSI(visual.replace(CURSOR_MARKER, ""))).toBe(`${gutter}\ufe96\ufe91   `);
		expect(visibleWidth(visual.slice(0, visual.indexOf(CURSOR_MARKER)))).toBe(visibleWidth(gutter));
		expect(visual.split(CURSOR_MARKER)).toHaveLength(2);
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});

	test("styled band and blank continuation gutters stay aligned across Arabic rows", () => {
		const render = createArabicRowRenderer();
		const rows = ["\x1b[36m╰─ \x1b[0m\x1b[31mبت\x1b[0m   ", `   بت${CURSOR_MARKER}   `];
		const visual = rows.map(render);
		expect(Bun.stripANSI(visual[0])).toBe("╰─ \ufe96\ufe91   ");
		expect(visual[0]).toContain("\x1b[36m╰─ ");
		expect(visual[0]).toContain("\x1b[31m\ufe96\ufe91");
		expect(Bun.stripANSI(visual[1].replace(CURSOR_MARKER, ""))).toBe("   \ufe96\ufe91   ");
		expect(visibleWidth(visual[1].slice(0, visual[1].indexOf(CURSOR_MARKER)))).toBe(3);
		expect(visual.map(visibleWidth)).toEqual(rows.map(visibleWidth));
	});

	test("the logical end-of-word cursor is placed at the visual left boundary", () => {
		const render = createArabicRowRenderer();
		const row = `بت${CURSOR_MARKER}`;
		const visual = render(row);
		expect(Bun.stripANSI(visual.replace(CURSOR_MARKER, ""))).toBe("\ufe96\ufe91");
		expect(visibleWidth(visual.slice(0, visual.indexOf(CURSOR_MARKER)))).toBe(0);
		expect(visual.split(CURSOR_MARKER)).toHaveLength(2);
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});

	test.each(["", "╰─ "])("typed trailing spaces precede the visual Arabic word with gutter %j", gutter => {
		const render = createArabicRowRenderer();
		const row = `${gutter}مرحبا ${CURSOR_MARKER}    `;
		const visual = render(row);
		expect(Bun.stripANSI(visual.replace(CURSOR_MARKER, ""))).toBe(`${gutter} \ufe8e\ufe92\ufea3\ufeae\ufee3    `);
		expect(visibleWidth(visual.slice(0, visual.indexOf(CURSOR_MARKER)))).toBe(visibleWidth(gutter));
		expect(visual.split(CURSOR_MARKER)).toHaveLength(2);
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});

	test("the logical start cursor stays at the opposite boundary from the Arabic end cursor", () => {
		const render = createArabicRowRenderer();
		const row = `╰─ ${CURSOR_MARKER}مرحبا     `;
		const visual = render(row);
		expect(Bun.stripANSI(visual.replace(CURSOR_MARKER, ""))).toBe("╰─ \ufe8e\ufe92\ufea3\ufeae\ufee3     ");
		expect(visibleWidth(visual.slice(0, visual.indexOf(CURSOR_MARKER)))).toBe(8);
		expect(visual.split(CURSOR_MARKER)).toHaveLength(2);
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});

	test("a width-changing transform preserves the row and can recover without a stale cache", () => {
		const render = createArabicRowRenderer();
		const measure = visibleWidth;
		const width = spyOn(tui, "visibleWidth").mockImplementation(
			row => measure(row) + (/[\ufe70-\ufeff]/.test(row) ? 1 : 0),
		);
		const row = `\x1b[31mبت 👩‍💻 中\x1b[0m${CURSOR_MARKER}`;
		expect(render(row)).toBe(row);
		width.mockRestore();
		const visual = render(row);
		expect(Bun.stripANSI(visual.replace(CURSOR_MARKER, ""))).toContain("\ufe96\ufe91");
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});
});
