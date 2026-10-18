import * as ffi from "bun:ffi";
import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as tui from "@oh-my-pi/pi-tui";
import {
	BUILTIN_EDITOR_BORDER_STYLES,
	type ComposerRowContext,
	CURSOR_MARKER,
	getComposerStyle,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import arabicRtlExtension, { createArabicRowRenderer } from "../examples/extensions/arabic-rtl";

afterEach(() => {
	vi.restoreAllMocks();
});

function withArabicExtension<T>(run: () => T): T {
	const prototype = Composer.prototype;
	const frame = prototype.renderFrame;
	const resize = prototype.renderResizeFrame;
	const installed = Symbol.for("omp.arabic-rtl.composer.v1");
	const descriptor = Object.getOwnPropertyDescriptor(prototype, installed);
	const styles = BUILTIN_EDITOR_BORDER_STYLES.map(id => {
		const style = getComposerStyle(id);
		return { style, renderRow: style.renderRow };
	});
	try {
		arabicRtlExtension({} as ExtensionAPI);
		return run();
	} finally {
		for (const { style, renderRow } of styles) style.renderRow = renderRow;
		prototype.renderFrame = frame;
		prototype.renderResizeFrame = resize;
		if (descriptor) Object.defineProperty(prototype, installed, descriptor);
		else Reflect.deleteProperty(prototype, installed);
	}
}

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

	test("leading quote and callout rails stay fixed without treating inline rails as chrome", () => {
		const render = createArabicRowRenderer();
		const row = "  \x1b[36m▏\x1b[0m \x1b[33m▎\x1b[0mمرحبا";
		const visual = render(row);
		expect(Bun.stripANSI(visual)).toBe("  ▏ ▎\ufe8e\ufe92\ufea3\ufeae\ufee3");
		expect(visual).toContain("\x1b[36m▏");
		expect(visual).toContain("\x1b[33m▎");
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
		expect(Bun.stripANSI(render("مرحبا ▏ path"))).toBe("path ▏ \ufe8e\ufe92\ufea3\ufeae\ufee3");
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

	test.each([0, 5, 6, 7])("editor caret %i preserves typed whitespace on both sides", cursor => {
		const render = createArabicRowRenderer();
		const text = "مرحبا  ";
		const row = text.slice(0, cursor) + CURSOR_MARKER + text.slice(cursor);
		const visual = render(row, true);
		expect(Bun.stripANSI(visual.replace(CURSOR_MARKER, ""))).toBe("  \ufe8e\ufe92\ufea3\ufeae\ufee3");
		expect(visibleWidth(visual.slice(0, visual.indexOf(CURSOR_MARKER)))).toBe(text.length - cursor);
		expect(visual.split(CURSOR_MARKER)).toHaveLength(2);
		expect(visibleWidth(visual)).toBe(visibleWidth(row));
	});

	test("editor text and padded transcript rows do not share cached layout", () => {
		const render = createArabicRowRenderer();
		const row = "مرحبا ";
		expect(Bun.stripANSI(render(row))).toBe("\ufe8e\ufe92\ufea3\ufeae\ufee3 ");
		expect(Bun.stripANSI(render(row, true))).toBe(" \ufe8e\ufe92\ufea3\ufeae\ufee3");
		expect(Bun.stripANSI(render(row))).toBe("\ufe8e\ufe92\ufea3\ufeae\ufee3 ");
	});

	test.each([...BUILTIN_EDITOR_BORDER_STYLES])("the %s shape preserves chrome and padding around typed spaces", id => {
		const style = getComposerStyle(id);
		const color = (text: string): string => text;
		const context: ComposerRowContext = {
			width: 30,
			paddingX: style.defaultPaddingX(undefined),
			borderColor: color,
			accentColor: color,
			surfaceColor: color,
			box: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
			text: `مرحبا${CURSOR_MARKER} `,
			pad: "    ",
			gutter: style.defaultPromptGutter ?? "",
			isLastRow: true,
			cursorOverflow: 0,
			imeSafeCursorTail: false,
			scrollbarThumb: false,
		};
		const logical = style.renderRow(context);
		withArabicExtension(() => {
			const visual = style.renderRow(context);
			expect(visual.map(row => Bun.stripANSI(row.replace(CURSOR_MARKER, "")))).toEqual(
				logical.map(row =>
					Bun.stripANSI(row.replace(CURSOR_MARKER, "")).replace("مرحبا ", " \ufe8e\ufe92\ufea3\ufeae\ufee3"),
				),
			);
			const word = logical[0].indexOf("مرحبا");
			expect(visibleWidth(visual[0].slice(0, visual[0].indexOf(CURSOR_MARKER)))).toBe(
				visibleWidth(logical[0].slice(0, word)) + 1,
			);
			expect(visual.map(visibleWidth)).toEqual(logical.map(visibleWidth));
		});
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
