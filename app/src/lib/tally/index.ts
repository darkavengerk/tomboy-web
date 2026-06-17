export type { TallySpec, TallyQuestion, Ballot, PollMeta, QuestionResult } from './types.js';
export { isTallyTitle, tallyName, parseTallyNote } from './parseTally.js';
export { aggregate, scoreBallot } from './aggregate.js';
export {
	ensurePollMeta,
	setResultsPublic,
	subscribePollMeta,
	getMyBallot,
	castBallot,
	subscribeBallots
} from './tallyClient.js';
