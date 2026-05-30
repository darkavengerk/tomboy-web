import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import {
	getClaudeDefaultSystem,
	setClaudeDefaultSystem,
	getClaudeDefaultModel,
	setClaudeDefaultModel,
	getClaudeDefaultEffort,
	setClaudeDefaultEffort
} from '$lib/storage/appSettings.js';

describe('appSettings — claude defaults', () => {
	it('returns minimal default system when unset', async () => {
		expect(await getClaudeDefaultSystem()).toBe('당신은 사용자를 돕는 어시스턴트입니다.');
	});

	it('returns opus model default when unset', async () => {
		expect(await getClaudeDefaultModel()).toBe('opus');
	});

	it('returns high effort default when unset', async () => {
		expect(await getClaudeDefaultEffort()).toBe('high');
	});

	it('round-trips system + model', async () => {
		await setClaudeDefaultSystem('번역기 페르소나');
		await setClaudeDefaultModel('claude-opus-4-8');
		expect(await getClaudeDefaultSystem()).toBe('번역기 페르소나');
		expect(await getClaudeDefaultModel()).toBe('claude-opus-4-8');
	});

	it('rejects invalid effort, accepts valid', async () => {
		await setClaudeDefaultEffort('nonsense');
		expect(await getClaudeDefaultEffort()).toBe('high');
		await setClaudeDefaultEffort('max');
		expect(await getClaudeDefaultEffort()).toBe('max');
	});

	it('falls back to opus when model set to blank', async () => {
		await setClaudeDefaultModel('   ');
		expect(await getClaudeDefaultModel()).toBe('opus');
	});
});
