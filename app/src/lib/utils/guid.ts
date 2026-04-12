import { v4 as uuidv4 } from 'uuid';

/** Generate a new UUID v4 for a note */
export function generateGuid(): string {
	return uuidv4();
}

/** Build a Tomboy note URI from a GUID */
export function noteUri(guid: string): string {
	return `note://tomboy/${guid}`;
}
