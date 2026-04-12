import {
	NOTE_VERSION,
	NOTE_NS,
	NOTE_NS_LINK,
	NOTE_NS_SIZE,
	escapeXml,
	formatTomboyDate,
	type NoteData
} from './note.js';

/**
 * Parse a .note XML file string into a NoteData object.
 * Mirrors the C# NoteArchiver.Read() logic.
 */
export function parseNote(xml: string, uri?: string): NoteData {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, 'text/xml');
	const noteEl = doc.documentElement;

	const guid = extractGuidFromUri(uri ?? '') || '';

	const getText = (tagName: string): string => {
		const el = noteEl.getElementsByTagName(tagName)[0];
		return el?.textContent ?? '';
	};

	const getInt = (tagName: string, defaultVal = 0): number => {
		const text = getText(tagName);
		const n = parseInt(text, 10);
		return isNaN(n) ? defaultVal : n;
	};

	// Extract <text> inner XML as raw string — preserves note-content exactly
	const xmlContent = extractXmlContent(xml);

	// Parse tags
	const tags: string[] = [];
	const tagsEl = noteEl.getElementsByTagName('tags')[0];
	if (tagsEl) {
		const tagEls = tagsEl.getElementsByTagName('tag');
		for (let i = 0; i < tagEls.length; i++) {
			const t = tagEls[i].textContent;
			if (t) tags.push(t);
		}
	}

	const openOnStartupText = getText('open-on-startup');
	const openOnStartup = openOnStartupText.toLowerCase() === 'true';

	return {
		uri: uri ?? `note://tomboy/${guid}`,
		guid,
		title: getText('title'),
		xmlContent,
		createDate: getText('create-date'),
		changeDate: getText('last-change-date'),
		metadataChangeDate: getText('last-metadata-change-date'),
		cursorPosition: getInt('cursor-position', 0),
		selectionBoundPosition: getInt('selection-bound-position', -1),
		width: getInt('width', 450),
		height: getInt('height', 360),
		x: getInt('x', 0),
		y: getInt('y', 0),
		tags,
		openOnStartup,
		localDirty: false,
		deleted: false
	};
}

/**
 * Serialize a NoteData object to a .note XML file string.
 * Uses string templates to match exact Tomboy output format.
 * Mirrors the C# NoteArchiver.Write() logic.
 */
export function serializeNote(note: NoteData): string {
	const lines: string[] = [];
	lines.push(`<?xml version="1.0" encoding="utf-8"?>`);
	lines.push(`<note version="${NOTE_VERSION}" xmlns:link="${NOTE_NS_LINK}" xmlns:size="${NOTE_NS_SIZE}" xmlns="${NOTE_NS}">`);
	lines.push(`  <title>${escapeXml(note.title)}</title>`);
	lines.push(`  <text xml:space="preserve">${note.xmlContent}</text>`);
	lines.push(`  <last-change-date>${note.changeDate}</last-change-date>`);
	lines.push(`  <last-metadata-change-date>${note.metadataChangeDate}</last-metadata-change-date>`);
	lines.push(`  <create-date>${note.createDate}</create-date>`);
	lines.push(`  <cursor-position>${note.cursorPosition}</cursor-position>`);
	lines.push(`  <selection-bound-position>${note.selectionBoundPosition}</selection-bound-position>`);
	lines.push(`  <width>${note.width}</width>`);
	lines.push(`  <height>${note.height}</height>`);
	lines.push(`  <x>${note.x}</x>`);
	lines.push(`  <y>${note.y}</y>`);

	if (note.tags.length > 0) {
		lines.push(`  <tags>`);
		for (const tag of note.tags) {
			lines.push(`    <tag>${escapeXml(tag)}</tag>`);
		}
		lines.push(`  </tags>`);
	}

	lines.push(`  <open-on-startup>${note.openOnStartup ? 'True' : 'False'}</open-on-startup>`);
	lines.push(`</note>`);

	return lines.join('\n');
}

/**
 * Extract the title from the first line of note-content XML.
 * The first line of note-content (before the first newline) is the title.
 */
export function extractTitleFromContent(xmlContent: string): string {
	const match = xmlContent.match(/<note-content[^>]*>([\s\S]*?)<\/note-content>/);
	if (!match) return '';

	const content = match[1];
	const firstLine = content.split('\n')[0];
	// Strip any XML tags from the title line
	return firstLine.replace(/<[^>]+>/g, '').trim();
}

/**
 * Extract the raw <note-content>...</note-content> blob from the XML string.
 * We use string matching rather than DOM to preserve the exact XML as-is.
 */
function extractXmlContent(xml: string): string {
	const startTag = '<note-content';
	const endTag = '</note-content>';

	const startIdx = xml.indexOf(startTag);
	const endIdx = xml.indexOf(endTag);

	if (startIdx === -1 || endIdx === -1) return '';

	return xml.substring(startIdx, endIdx + endTag.length);
}

/** Extract a GUID from a note://tomboy/<guid> URI */
function extractGuidFromUri(uri: string): string {
	const match = uri.match(/note:\/\/tomboy\/(.+)/);
	return match ? match[1] : '';
}

/**
 * Derive the GUID from a .note filename.
 * Typical filename: "12345678-1234-1234-1234-123456789abc.note"
 */
export function guidFromFilename(filename: string): string {
	return filename.replace(/\.note$/, '');
}

/**
 * Build a .note filename from a GUID.
 */
export function filenameFromGuid(guid: string): string {
	return `${guid}.note`;
}

/**
 * Parse a .note XML string and derive the GUID from the filename.
 * Convenience function combining parseNote + guid assignment.
 */
export function parseNoteFromFile(xml: string, filename: string): NoteData {
	const guid = guidFromFilename(filename);
	const uri = `note://tomboy/${guid}`;
	const note = parseNote(xml, uri);
	note.guid = guid;
	return note;
}
