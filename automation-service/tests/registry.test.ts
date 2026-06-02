import { describe, it, expect } from 'vitest';
import { parseRegistry, lookupCommand } from '../src/registry.js';

const VALID = JSON.stringify({
  commands: {
    'loc-history': [
      { project: 'tomboy', exec: ['python3', '/home/u/loc-history.py', '/repo', '--csv-only'] },
      { project: 'robotC', exec: ['python3', '/home/u/loc-history.py', '/repo2', '--csv-only'] }
    ]
  }
});

describe('parseRegistry', () => {
  it('parses a valid registry', () => {
    const reg = parseRegistry(VALID);
    expect(Object.keys(reg.commands)).toEqual(['loc-history']);
    expect(reg.commands['loc-history']).toHaveLength(2);
    expect(reg.commands['loc-history'][0]).toEqual({
      project: 'tomboy',
      exec: ['python3', '/home/u/loc-history.py', '/repo', '--csv-only']
    });
  });

  it('throws when commands key is missing', () => {
    expect(() => parseRegistry('{}')).toThrow(/commands/);
  });

  it('throws when an entry is missing project', () => {
    const bad = JSON.stringify({ commands: { x: [{ exec: ['ls'] }] } });
    expect(() => parseRegistry(bad)).toThrow(/project/);
  });

  it('throws when exec is empty or non-string', () => {
    const bad = JSON.stringify({ commands: { x: [{ project: 'p', exec: [] }] } });
    expect(() => parseRegistry(bad)).toThrow(/exec/);
  });
});

describe('lookupCommand', () => {
  it('returns entries for a known command and null for unknown', () => {
    const reg = parseRegistry(VALID);
    expect(lookupCommand(reg, 'loc-history')).toHaveLength(2);
    expect(lookupCommand(reg, 'nope')).toBeNull();
  });
});
