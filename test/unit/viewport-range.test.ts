import { describe, expect, it } from 'vitest';
import { growViewRange } from '../../src/viewer/webview/components/viewportMath';

describe('growing recording viewport', () => {
    it('keeps the whole recording fitted', () => {
        expect(growViewRange([10, 20], [10, 20], [10, 29])).toEqual([10, 29]);
    });
    it('keeps a historical zoom window fixed', () => {
        expect(growViewRange([12, 15], [10, 20], [10, 29])).toEqual([12, 15]);
    });
    it('follows the tail without changing the zoom span', () => {
        expect(growViewRange([17, 20], [10, 20], [10, 29])).toEqual([26, 29]);
    });
    it('tolerates floating point rounding at the tail', () => {
        expect(growViewRange([17, 20 - 1e-10], [10, 20], [10, 29])[1]).toBe(29);
    });
    it('fits a truncated, replaced or initially empty recording', () => {
        expect(growViewRange([17, 20], [10, 20], [10, 12])).toEqual([10, 12]);
        expect(growViewRange([17, 20], [10, 20], [0, 30])).toEqual([0, 30]);
        expect(growViewRange([0, 0], [0, 0], [0, 1])).toEqual([0, 1]);
    });
});