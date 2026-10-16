import { expect, test } from "bun:test";
import { openArchive } from "../../src/ar/open";
import type { ArchiveFormat } from "../../src/ar/types";
import { arFixture } from "./fixtures";

// `maxMemberSize` bounds extraction, not indexing: a member over the cap must
// still list with its real size (issue #16018), and only reading it fails.
test.each<[string, ArchiveFormat]>([
	["tar-ustar.tar", "tar"],
	["zip-basic.zip", "zip"],
	["sevenzip-copy.7z", "7z"],
	["rar5-store.rar", "rar"],
	["rock-ridge-joliet.iso", "iso"],
	["cab-none.cab", "cab"],
	["unix-gnu.a", "ar"],
	["cpio-newc.cpio", "cpio"],
	["lzh-level2-stored.lzh", "lzh"],
	["arj-method0.arj", "arj"],
	["asar-valid.asar", "asar"],
])("%s lists members over maxMemberSize and refuses to extract them", async (name, format) => {
	const bytes = await arFixture(name);
	const members = [...(await openArchive({ bytes, format })).indexEntries()].filter(
		entry => !entry.isDirectory && entry.storage?.type === "member",
	);
	const largest = members.reduce((max, entry) => (entry.size > max.size ? entry : max));
	expect(largest.size).toBeGreaterThan(0);

	const capped = await openArchive({ bytes, format }, { limits: { maxMemberSize: largest.size - 1 } });
	expect(capped.getNode(largest.path)?.size).toBe(largest.size);
	await expect(capped.readFile(largest.path)).rejects.toThrow("too large to extract");
});
