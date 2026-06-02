import { readFileSync } from 'node:fs';

export interface CommandEntry {
  project: string;
  exec: string[];
}
export interface Registry {
  commands: Record<string, CommandEntry[]>;
}

export function parseRegistry(raw: string): Registry {
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== 'object' || !('commands' in data)) {
    throw new Error('registry: missing "commands"');
  }
  const commandsIn = (data as { commands: unknown }).commands;
  if (!commandsIn || typeof commandsIn !== 'object' || Array.isArray(commandsIn)) {
    throw new Error('registry: "commands" must be an object');
  }
  const commands: Record<string, CommandEntry[]> = {};
  for (const [id, entriesIn] of Object.entries(commandsIn as Record<string, unknown>)) {
    if (!Array.isArray(entriesIn)) {
      throw new Error(`registry: command "${id}" must be an array`);
    }
    commands[id] = entriesIn.map((e, i) => {
      const entry = e as { project?: unknown; exec?: unknown };
      if (typeof entry.project !== 'string' || !entry.project) {
        throw new Error(`registry: ${id}[${i}] missing project`);
      }
      if (
        !Array.isArray(entry.exec) ||
        entry.exec.length === 0 ||
        !entry.exec.every((x) => typeof x === 'string')
      ) {
        throw new Error(`registry: ${id}[${i}] exec must be a non-empty string[]`);
      }
      return { project: entry.project, exec: entry.exec as string[] };
    });
  }
  return { commands };
}

export function loadRegistry(path: string): Registry {
  return parseRegistry(readFileSync(path, 'utf8'));
}

export function lookupCommand(reg: Registry, command: string): CommandEntry[] | null {
  return Object.prototype.hasOwnProperty.call(reg.commands, command)
    ? reg.commands[command]
    : null;
}
