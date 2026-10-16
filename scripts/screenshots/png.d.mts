/**
 * Downsample one 2x RGBA render to 1x by averaging each 2x2 block in
 * linear sRGB light. `src` is row-major RGBA at srcW x srcH (exactly 2x
 * dstW x dstH) and must be fully opaque. Returns a row-major RGBA buffer
 * at dstW x dstH.
 */
export declare function downsample2x(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Buffer;

/**
 * Encode one row-major RGBA buffer as an 8-bit truecolor + alpha PNG. The
 * same pixels always give the same bytes.
 */
export declare function encodePng(width: number, height: number, rgba: Buffer): Buffer;
