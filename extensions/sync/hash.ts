import { createHash } from "node:crypto";

/** sha256 hex of a UTF-8 string. The content identity of one Snapshot file. */
export function sha256Hex(content: string): string {
	const hash = createHash("sha256");
	hash.update(content, "utf8");
	return hash.digest("hex");
}

/** True when the buffer is valid UTF-8 (gist files are text only). */
export function isUtf8(buffer: Buffer): boolean {
	if (buffer.length === 0) return true;
	for (let i = 0; i < buffer.length; i++) {
		const byte = buffer[i];
		if (byte <= 0x7f) continue; // ASCII
		if (byte >= 0xc2 && byte <= 0xdf) {
			if (i + 1 >= buffer.length || (buffer[i + 1] & 0xc0) !== 0x80) return false;
			i += 1;
		} else if (byte >= 0xe0 && byte <= 0xef) {
			if (i + 2 >= buffer.length || (buffer[i + 1] & 0xc0) !== 0x80 || (buffer[i + 2] & 0xc0) !== 0x80) return false;
			i += 2;
		} else if (byte >= 0xf0 && byte <= 0xf4) {
			if (i + 3 >= buffer.length || (buffer[i + 1] & 0xc0) !== 0x80 || (buffer[i + 2] & 0xc0) !== 0x80 || (buffer[i + 3] & 0xc0) !== 0x80) return false;
			i += 3;
		} else {
			return false; // 0x80-0xc1, 0xf5-0xff are never valid lead bytes
		}
	}
	return true;
}
