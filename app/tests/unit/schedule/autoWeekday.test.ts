import { describe, it, expect } from 'vitest';
import {
	getWeekdayChar,
	formatDayWithWeekday,
	transformDayPrefixLine,
	transformMultilineDayPrefix
} from '$lib/schedule/autoWeekday.js';

// Helper: compute correct weekday char for a date using the same Date math as prod.
const WEEKDAY_CHARS = ['일', '월', '화', '수', '목', '금', '토'] as const;
function expectedWeekday(year: number, month: number, day: number): string {
	return WEEKDAY_CHARS[new Date(year, month - 1, day).getDay()];
}

// Constant shortcuts for Apr 2026
const Y = 2026;
const M = 4;
// Apr 12 2026 — computed in test via Date, not hard-coded
const APR12_WD = expectedWeekday(Y, M, 12); // should be '일' (Sunday)
const APR30_WD = expectedWeekday(Y, M, 30); // should be '목' (Thursday)
const APR1_WD = expectedWeekday(Y, M, 1); // should be '수' (Wednesday)
const APR15_WD = expectedWeekday(Y, M, 15); // should be '수' (Wednesday) → actually check
// Verify APR15 is not a fixed assumption — the test uses the helper.

describe('getWeekdayChar', () => {
	it('returns correct char for Apr 12 2026 (Sunday)', () => {
		expect(getWeekdayChar(Y, M, 12)).toBe(APR12_WD);
	});

	it('returns correct char for Apr 30 2026', () => {
		expect(getWeekdayChar(Y, M, 30)).toBe(APR30_WD);
	});

	it('returns correct char for Feb 29 2024 (leap year, Thursday)', () => {
		const wd = expectedWeekday(2024, 2, 29);
		expect(getWeekdayChar(2024, 2, 29)).toBe(wd);
	});

	it('throws for invalid date: Feb 30', () => {
		expect(() => getWeekdayChar(2026, 2, 30)).toThrow();
	});

	it('throws for day 0', () => {
		expect(() => getWeekdayChar(2026, 4, 0)).toThrow();
	});

	it('throws for day 32', () => {
		expect(() => getWeekdayChar(2026, 4, 32)).toThrow();
	});

	it('throws for Apr 31', () => {
		expect(() => getWeekdayChar(2026, 4, 31)).toThrow();
	});

	it('all weekday chars are valid', () => {
		// One week starting Jan 4 2026 (Sunday)
		const expected = ['일', '월', '화', '수', '목', '금', '토'];
		for (let i = 0; i < 7; i++) {
			expect(getWeekdayChar(2026, 1, 4 + i)).toBe(expected[i]);
		}
	});
});

describe('formatDayWithWeekday', () => {
	it('formats Apr 12 2026 as "12(<wd>)"', () => {
		expect(formatDayWithWeekday(Y, M, 12)).toBe(`12(${APR12_WD})`);
	});

	it('formats Apr 1 2026 as "1(<wd>)"', () => {
		expect(formatDayWithWeekday(Y, M, 1)).toBe(`1(${APR1_WD})`);
	});

	it('throws for invalid date', () => {
		expect(() => formatDayWithWeekday(2026, 2, 30)).toThrow();
	});
});

describe('transformDayPrefixLine', () => {
	describe('auto-fill bare number + space', () => {
		it('basic: "12 " → "12(<wd>) "', () => {
			const result = transformDayPrefixLine('12 ', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) `);
		});

		it('with label: "12 등산 7시" → "12(<wd>) 등산 7시"', () => {
			const result = transformDayPrefixLine('12 등산 7시', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산 7시`);
		});

		it('day 1: "1 일정" → "1(<wd>) 일정"', () => {
			const result = transformDayPrefixLine('1 일정', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`1(${APR1_WD}) 일정`);
		});

		it('day 30 (April): "30 " → "30(<wd>) "', () => {
			const result = transformDayPrefixLine('30 ', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`30(${APR30_WD}) `);
		});

		it('multiple spaces preserved: "12  등산" → "12(<wd>)  등산"', () => {
			const result = transformDayPrefixLine('12  등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD})  등산`);
		});
	});

	describe('leading whitespace preserved', () => {
		it('"  12 등산" → "  12(<wd>) 등산"', () => {
			const result = transformDayPrefixLine('  12 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`  12(${APR12_WD}) 등산`);
		});

		it('"\\t12 등산" → "\\t12(<wd>) 등산"', () => {
			const result = transformDayPrefixLine('\t12 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`\t12(${APR12_WD}) 등산`);
		});
	});

	describe('already correct weekday — no change', () => {
		it('"12(<correct>) 등산" → unchanged', () => {
			const correct = APR12_WD;
			const result = transformDayPrefixLine(`12(${correct}) 등산`, Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe(`12(${correct}) 등산`);
		});

		it('"30(<correct>) " → unchanged', () => {
			const result = transformDayPrefixLine(`30(${APR30_WD}) `, Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe(`30(${APR30_WD}) `);
		});
	});

	describe('wrong weekday corrected', () => {
		it('"12(월) 등산" → "12(<correct>) 등산" with changed:true', () => {
			// Apr 12 2026 is Sunday ('일'), not 월
			const result = transformDayPrefixLine('12(월) 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});

		it('"30(?) " for April 30 → corrected', () => {
			const result = transformDayPrefixLine('30(?) ', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`30(${APR30_WD}) `);
		});

		it('garbage in parens: "12(?) 등산" → corrected', () => {
			const result = transformDayPrefixLine('12(?) 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});

		it('empty parens: "12() 등산" → corrected', () => {
			const result = transformDayPrefixLine('12() 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});

		it('trailing content after parens preserved: "12(목) abc" → "12(<correct>) abc"', () => {
			const result = transformDayPrefixLine('12(목) abc', Y, M);
			// Apr 12 is Sunday (일), not 목
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) abc`);
		});
	});

	describe('invalid day — unchanged', () => {
		it('"31 abc" for month=2 → unchanged', () => {
			const result = transformDayPrefixLine('31 abc', Y, 2);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('31 abc');
		});

		it('"31 abc" for April (31 not in April) → unchanged', () => {
			const result = transformDayPrefixLine('31 abc', Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('31 abc');
		});

		it('"0 abc" → unchanged', () => {
			const result = transformDayPrefixLine('0 abc', Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('0 abc');
		});
	});

	describe('no change cases', () => {
		it('no day prefix: "abc 12 def" → unchanged', () => {
			const result = transformDayPrefixLine('abc 12 def', Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('abc 12 def');
		});

		it('just a number, no trailing space: "12" → unchanged', () => {
			const result = transformDayPrefixLine('12', Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('12');
		});

		it('empty string → unchanged', () => {
			const result = transformDayPrefixLine('', Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('');
		});
	});

	describe('idempotency', () => {
		it('applying transform twice yields same string for "12 등산"', () => {
			const first = transformDayPrefixLine('12 등산', Y, M);
			const second = transformDayPrefixLine(first.output, Y, M);
			expect(second.changed).toBe(false);
			expect(second.output).toBe(first.output);
		});

		it('applying transform twice yields same string for "30(?) abc"', () => {
			const first = transformDayPrefixLine('30(?) abc', Y, M);
			const second = transformDayPrefixLine(first.output, Y, M);
			expect(second.changed).toBe(false);
			expect(second.output).toBe(first.output);
		});
	});

	describe('leap year', () => {
		it('Feb 29 2024 (Thursday) — gets correct weekday', () => {
			const wd = expectedWeekday(2024, 2, 29);
			const result = transformDayPrefixLine('29 산책', 2024, 2);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`29(${wd}) 산책`);
		});

		it('Feb 29 2024 wrong weekday → corrected', () => {
			const wd = expectedWeekday(2024, 2, 29);
			const result = transformDayPrefixLine('29(월) 산책', 2024, 2);
			expect(result.changed).toBe(wd !== '월');
			if (wd !== '월') {
				expect(result.output).toBe(`29(${wd}) 산책`);
			}
		});
	});

	describe('boundary days', () => {
		it('day 1 fills correctly', () => {
			const wd = expectedWeekday(Y, M, 1);
			const result = transformDayPrefixLine('1 일정', Y, M);
			expect(result.output).toBe(`1(${wd}) 일정`);
		});

		it('day 31 valid month (Jan 31 2026)', () => {
			const wd = expectedWeekday(2026, 1, 31);
			const result = transformDayPrefixLine('31 운동', 2026, 1);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`31(${wd}) 운동`);
		});

		it('day 31 invalid month (Apr) → unchanged', () => {
			const result = transformDayPrefixLine('31 운동', Y, M);
			expect(result.changed).toBe(false);
		});
	});
});

describe('transformDayPrefixLine — improvement B edge cases', () => {
	describe('B1: whitespace inside parens', () => {
		it('"12( 수 ) 등산" → corrected to actual weekday', () => {
			const result = transformDayPrefixLine('12( 수 ) 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});

		it('"12(  일  ) abc" with extra spaces inside — corrected', () => {
			const result = transformDayPrefixLine('12(  일  ) abc', Y, M);
			// Apr 12 2026 is '일' — inner trims to '일' which equals correct weekday
			// so changed = false only if inner === wd after trim
			const wd = APR12_WD;
			if (wd === '일') {
				expect(result.changed).toBe(false);
				expect(result.output).toBe('12(  일  ) abc');
			} else {
				expect(result.changed).toBe(true);
				expect(result.output).toBe(`12(${wd}) abc`);
			}
		});
	});

	describe('B2: English weekday text in parens', () => {
		it('"12(Wed) 등산" → corrected to actual weekday (Apr 12 2026)', () => {
			const result = transformDayPrefixLine('12(Wed) 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});

		it('"12(Sun) 등산" → corrected (Sun is English, replace with Korean)', () => {
			const result = transformDayPrefixLine('12(Sun) 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});

		it('"12(mon) 등산" → corrected (lowercase English)', () => {
			const result = transformDayPrefixLine('12(mon) 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});
	});

	describe('B3: multiple chars in parens', () => {
		it('"12(수목) 등산" → corrected (treat as garbage)', () => {
			const result = transformDayPrefixLine('12(수목) 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});

		it('"12(월화수) 등산" → corrected', () => {
			const result = transformDayPrefixLine('12(월화수) 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});
	});

	describe('B4: whitespace before parens (space between number and open paren)', () => {
		it('"12 (수) 등산" — space before parens → collapses to "12(<correct>) 등산"', () => {
			const result = transformDayPrefixLine('12 (수) 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) 등산`);
		});

		it('"12 (일) abc" where 일 is correct weekday — still corrects format (collapses gap)', () => {
			// Even if the weekday char inside is correct, the gap means formatting is wrong.
			const result = transformDayPrefixLine(`12 (${APR12_WD}) abc`, Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${APR12_WD}) abc`);
		});
	});

	describe('B5: leading zero in day number', () => {
		it('"04 등산" → treated as day 4, fills weekday', () => {
			const wd = expectedWeekday(Y, M, 4);
			const result = transformDayPrefixLine('04 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`4(${wd}) 등산`);
		});

		it('"01 회의" → day 1', () => {
			const wd = expectedWeekday(Y, M, 1);
			const result = transformDayPrefixLine('01 회의', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`1(${wd}) 회의`);
		});

		it('"09(수) abc" with leading zero + parens → corrected', () => {
			const wd = expectedWeekday(Y, M, 9);
			const result = transformDayPrefixLine('09(수) abc', Y, M);
			const correct = wd === '수';
			if (!correct) {
				expect(result.changed).toBe(true);
				expect(result.output).toBe(`9(${wd}) abc`);
			} else {
				// Still normalises the leading zero even if weekday was right
				expect(result.output).toBe(`9(${wd}) abc`);
			}
		});
	});
});

describe('transformMultilineDayPrefix', () => {
	it('fills weekdays on each line', () => {
		const input = ['12 산', '13 강', '14 '].join('\n');
		const result = transformMultilineDayPrefix(input, Y, M);
		const wd12 = expectedWeekday(Y, M, 12);
		const wd13 = expectedWeekday(Y, M, 13);
		const wd14 = expectedWeekday(Y, M, 14);
		expect(result).toBe([`12(${wd12}) 산`, `13(${wd13}) 강`, `14(${wd14}) `].join('\n'));
	});

	it('lines without day prefix stay as-is', () => {
		const input = ['노트 열심히', '12 산', 'abc'].join('\n');
		const result = transformMultilineDayPrefix(input, Y, M);
		const wd12 = expectedWeekday(Y, M, 12);
		expect(result).toBe([`노트 열심히`, `12(${wd12}) 산`, `abc`].join('\n'));
	});

	it('preserves \\r\\n line endings', () => {
		const input = '12 산\r\n13 강';
		const result = transformMultilineDayPrefix(input, Y, M);
		expect(result).toContain('\r\n');
		const wd12 = expectedWeekday(Y, M, 12);
		const wd13 = expectedWeekday(Y, M, 13);
		expect(result).toBe(`12(${wd12}) 산\r\n13(${wd13}) 강`);
	});

	it('single line input works', () => {
		const result = transformMultilineDayPrefix('12 산', Y, M);
		const wd12 = expectedWeekday(Y, M, 12);
		expect(result).toBe(`12(${wd12}) 산`);
	});

	it('empty string → empty string', () => {
		expect(transformMultilineDayPrefix('', Y, M)).toBe('');
	});

	it('mixed valid/invalid lines', () => {
		const input = '31 abc\n12 산';
		const result = transformMultilineDayPrefix(input, Y, M);
		const wd12 = expectedWeekday(Y, M, 12);
		// Apr 31 is invalid → unchanged; Apr 12 is filled
		expect(result).toBe(`31 abc\n12(${wd12}) 산`);
	});

	it('idempotent over multi-line', () => {
		const input = '12 산\n13 강';
		const first = transformMultilineDayPrefix(input, Y, M);
		const second = transformMultilineDayPrefix(first, Y, M);
		expect(second).toBe(first);
	});
});
