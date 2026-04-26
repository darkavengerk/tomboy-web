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

describe('transformDayPrefixLine — comprehensive edge cases (Group 1)', () => {
	// G1-1: no space after parens — body immediately follows
	describe('G1-1: no space after parens (body immediately follows)', () => {
		it('"12(수)등산" with correct weekday → unchanged', () => {
			// Use a month/day where the correct weekday IS '수' so we can test no-change path.
			// Apr 15 2026 is a Wednesday ('수').
			const wd15 = expectedWeekday(Y, M, 15);
			// Pin: the no-space-after-parens format is preserved when correct.
			if (wd15 === '수') {
				const result = transformDayPrefixLine('15(수)등산', Y, M);
				expect(result.changed).toBe(false);
				expect(result.output).toBe('15(수)등산');
			} else {
				// Dynamic: test that the correct weekday IS actually used (guard)
				const result = transformDayPrefixLine(`15(${wd15})등산`, Y, M);
				expect(result.changed).toBe(false);
				expect(result.output).toBe(`15(${wd15})등산`);
			}
		});

		it('"12(수)등산" with wrong weekday → corrects weekday, preserves no-space format', () => {
			// Apr 12 2026 is '일' (Sunday). Using '수' (Wednesday) as wrong.
			const wd = APR12_WD; // '일'
			const result = transformDayPrefixLine('12(수)등산', Y, M);
			// If wd !== '수', it should be corrected; rest="등산" is preserved.
			if (wd !== '수') {
				expect(result.changed).toBe(true);
				expect(result.output).toBe(`12(${wd})등산`);
			} else {
				expect(result.changed).toBe(false);
				expect(result.output).toBe('12(수)등산');
			}
		});
	});

	// G1-2: parens only, no trailing content
	describe('G1-2: parens only, no trailing content', () => {
		it('"12(<correct>)" → unchanged (no trailing content invented)', () => {
			const wd = APR12_WD;
			const result = transformDayPrefixLine(`12(${wd})`, Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe(`12(${wd})`);
		});

		it('"12(월)" with wrong weekday → corrected, no trailing content added', () => {
			// Apr 12 is '일', not '월'
			const wd = APR12_WD;
			const result = transformDayPrefixLine('12(월)', Y, M);
			if (wd !== '월') {
				expect(result.changed).toBe(true);
				// rest="" → output ends right after the parens
				expect(result.output).toBe(`12(${wd})`);
			} else {
				expect(result.changed).toBe(false);
				expect(result.output).toBe('12(월)');
			}
		});
	});

	// G1-3: trailing-space-only
	describe('G1-3: trailing space only after parens', () => {
		it('"12(<correct>) " → unchanged', () => {
			const wd = APR12_WD;
			const result = transformDayPrefixLine(`12(${wd}) `, Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe(`12(${wd}) `);
		});

		it('"12(월) " with wrong weekday → corrected, space preserved', () => {
			const wd = APR12_WD;
			const result = transformDayPrefixLine('12(월) ', Y, M);
			if (wd !== '월') {
				expect(result.changed).toBe(true);
				expect(result.output).toBe(`12(${wd}) `);
			} else {
				expect(result.changed).toBe(false);
				expect(result.output).toBe('12(월) ');
			}
		});
	});

	// G1-4: leading whitespace preserved (pin — already covered but explicit)
	describe('G1-4: leading whitespace preserved (pin)', () => {
		it('"  12 등산" → "  12(<wd>) 등산" (leading spaces preserved)', () => {
			const wd = APR12_WD;
			const result = transformDayPrefixLine('  12 등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`  12(${wd}) 등산`);
		});
	});

	// G1-5: multiple spaces between number and label
	describe('G1-5: multiple spaces between number and label', () => {
		it('"12  등산" → "12(<wd>)  등산" (multi-space preserved in output)', () => {
			// BARE_SPACE_RE captures the spaces as a group and re-inserts them.
			// So "12  등산" → leadingWs="", dayStr="12", spaces="  ", rest="등산"
			// output = "12(<wd>)  등산" — multi-space IS preserved.
			const wd = APR12_WD;
			const result = transformDayPrefixLine('12  등산', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`12(${wd})  등산`);
		});
	});

	// G1-6: tab inside parens
	describe('G1-6: tab inside parens', () => {
		it('"12(\\t수\\t) 등산" — inner whitespace trimmed for comparison', () => {
			// WITH_PARENS_RE matches; inner = "\t수\t".trim() = "수"
			// Apr 15 is '수'; Apr 12 is '일'.
			const wd = APR12_WD;
			const result = transformDayPrefixLine('12(\t수\t) 등산', Y, M);
			if (wd === '수') {
				// inner trims to '수' === wd → unchanged
				expect(result.changed).toBe(false);
				expect(result.output).toBe('12(\t수\t) 등산');
			} else {
				// inner trims to '수' !== wd → corrected
				expect(result.changed).toBe(true);
				expect(result.output).toBe(`12(${wd}) 등산`);
			}
		});
	});

	// G1-7: Dec 31 (valid)
	describe('G1-7: Dec 31 (valid day for month=12)', () => {
		it('"31 abc" for month=12 (valid day) → fills weekday', () => {
			const wd = expectedWeekday(Y, 12, 31);
			const result = transformDayPrefixLine('31 abc', Y, 12);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`31(${wd}) abc`);
		});
	});

	// G1-8: invalid day 32
	describe('G1-8: invalid day 32', () => {
		it('"32 abc" (day > 31) → unchanged', () => {
			const result = transformDayPrefixLine('32 abc', Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('32 abc');
		});
	});

	// G1-9: day zero
	describe('G1-9: day zero', () => {
		it('"00 abc" (day zero, leading-zero form) → unchanged', () => {
			const result = transformDayPrefixLine('00 abc', Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('00 abc');
		});
	});

	// G1-10: single digit
	describe('G1-10: single digit day', () => {
		it('"1 abc" → fills weekday for day 1', () => {
			const wd = expectedWeekday(Y, M, 1);
			const result = transformDayPrefixLine('1 abc', Y, M);
			expect(result.changed).toBe(true);
			expect(result.output).toBe(`1(${wd}) abc`);
		});
	});

	// G1-11: 3-digit number — should NOT match
	describe('G1-11: three-digit number (100) — does not match DAY_PREFIX_RE', () => {
		it('"100 abc" → unchanged (3-digit numbers not matched by 1-2 digit regex)', () => {
			const result = transformDayPrefixLine('100 abc', Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('100 abc');
		});

		it('"999 xyz" → unchanged', () => {
			const result = transformDayPrefixLine('999 xyz', Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe('999 xyz');
		});
	});

	// G1-12: tab between parens and label
	describe('G1-12: tab between parens and label', () => {
		it('"12(<correct>)\\t등산" → unchanged (tab is part of rest, preserved)', () => {
			const wd = APR12_WD;
			const result = transformDayPrefixLine(`12(${wd})\t등산`, Y, M);
			expect(result.changed).toBe(false);
			expect(result.output).toBe(`12(${wd})\t등산`);
		});

		it('"12(월)\\t등산" with wrong weekday → corrected, tab preserved in rest', () => {
			const wd = APR12_WD;
			const result = transformDayPrefixLine('12(월)\t등산', Y, M);
			if (wd !== '월') {
				expect(result.changed).toBe(true);
				expect(result.output).toBe(`12(${wd})\t등산`);
			} else {
				expect(result.changed).toBe(false);
				expect(result.output).toBe('12(월)\t등산');
			}
		});
	});
});

describe('transformMultilineDayPrefix — additional edge cases (Group 1)', () => {
	// G1-13: just \n (single newline, two empty lines)
	describe('G1-13: single newline only (two empty lines)', () => {
		it('"\\n" → "\\n" (both empty lines unchanged)', () => {
			const result = transformMultilineDayPrefix('\n', Y, M);
			expect(result).toBe('\n');
		});
	});

	// G1-14: mixed CRLF and LF
	describe('G1-14: mixed CRLF and LF line endings', () => {
		it('input with both \\r\\n and \\n: usesCRLF detected, all \\n converted to \\r\\n in output', () => {
			// "12 산\r\n13 강\n14 들" → usesCRLF=true (has \r\n)
			// normalize: replace \r\n with \n → "12 산\n13 강\n14 들"
			// transform each line, join with \n, then replace \n with \r\n
			// → "12(wd12) 산\r\n13(wd13) 강\r\n14(wd14) 들"
			// Note: the bare \n in the input also becomes \r\n in the output
			// because the final join+replace is applied to ALL \n.
			const wd12 = expectedWeekday(Y, M, 12);
			const wd13 = expectedWeekday(Y, M, 13);
			const wd14 = expectedWeekday(Y, M, 14);
			const input = '12 산\r\n13 강\n14 들';
			const result = transformMultilineDayPrefix(input, Y, M);
			// All newlines become \r\n because the final replace is global.
			expect(result).toBe(`12(${wd12}) 산\r\n13(${wd13}) 강\r\n14(${wd14}) 들`);
		});

		it('pure LF input → pure LF output (no CRLF introduced)', () => {
			const wd12 = expectedWeekday(Y, M, 12);
			const wd13 = expectedWeekday(Y, M, 13);
			const input = '12 산\n13 강';
			const result = transformMultilineDayPrefix(input, Y, M);
			expect(result).not.toContain('\r\n');
			expect(result).toBe(`12(${wd12}) 산\n13(${wd13}) 강`);
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
