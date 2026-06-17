/**
 * 집계 투표 Firestore 클라이언트.
 *
 * 데이터 모델(전용 top-level 컬렉션):
 *   polls/{noteGuid}                    메타(ownerUid, resultsPublic) — 호스트 작성
 *   polls/{noteGuid}/ballots/{voterUid} 표(answers) — 투표자당 1개, 불변
 *
 * voterUid = 현재 Firebase uid(게스트=익명, 호스트=Dropbox 브리지). 1인 1표는
 * 브라우저(=익명 uid) 단위 soft 강제. correctIndex 는 노트 본문에서 파싱하므로
 * 여기 저장하지 않는다.
 *
 * firestore.rules 의 polls 블록과 짝이다(solo 에서 강제, shared 에서는 blanket
 * catch-all 이 우선해 soft). install.ts 가 시작 시 호스트/게스트 모두 로그인시키므로
 * currentUser 는 대개 이미 존재한다.
 */
import {
	collection,
	doc,
	getDoc,
	setDoc,
	updateDoc,
	onSnapshot,
	serverTimestamp
} from 'firebase/firestore';
import {
	getFirebaseAuth,
	getFirebaseFirestore,
	ensureGuestSignedIn
} from '$lib/firebase/app.js';
import { mode } from '$lib/stores/guestMode.svelte.js';
import type { Ballot, PollMeta } from './types.js';

/**
 * 현재 투표자 uid. 호스트/게스트 모두 install 단계에서 로그인되어 있어
 * currentUser 가 보통 존재. 비어 있고 게스트 모드일 때만 익명 로그인을 보장한다
 * (호스트일 때 ensureGuestSignedIn 을 부르면 호스트 세션을 로그아웃시키므로 금지).
 */
async function currentUid(): Promise<string | null> {
	const auth = getFirebaseAuth();
	await auth.authStateReady();
	if (auth.currentUser) return auth.currentUser.uid;
	if (mode.value === 'guest') {
		const u = await ensureGuestSignedIn();
		return u.uid;
	}
	return null;
}

function metaRef(guid: string) {
	return doc(getFirebaseFirestore(), 'polls', guid);
}
function ballotsCol(guid: string) {
	return collection(getFirebaseFirestore(), 'polls', guid, 'ballots');
}
function ballotRef(guid: string, voterUid: string) {
	return doc(getFirebaseFirestore(), 'polls', guid, 'ballots', voterUid);
}

/** 메타 문서가 없으면 ownerUid=현재 uid 로 생성(호스트 전용 — 게스트면 no-op). */
export async function ensurePollMeta(guid: string): Promise<void> {
	if (mode.value === 'guest') return;
	const uid = await currentUid();
	if (!uid) return;
	const ref = metaRef(guid);
	const snap = await getDoc(ref);
	if (snap.exists()) return;
	await setDoc(ref, { ownerUid: uid, resultsPublic: false, updatedAt: serverTimestamp() });
}

/** 결과 공개 여부 토글(호스트 전용). 메타가 없으면 먼저 만든다. */
export async function setResultsPublic(guid: string, pub: boolean): Promise<void> {
	await ensurePollMeta(guid);
	await updateDoc(metaRef(guid), { resultsPublic: pub, updatedAt: serverTimestamp() });
}

/** 메타 문서 실시간 구독. 없으면 null. */
export function subscribePollMeta(guid: string, cb: (meta: PollMeta | null) => void): () => void {
	return onSnapshot(
		metaRef(guid),
		(snap) => cb(snap.exists() ? (snap.data() as PollMeta) : null),
		() => cb(null)
	);
}

/** 내 표(이미 투표했는지) 조회. */
export async function getMyBallot(guid: string): Promise<Ballot | null> {
	const uid = await currentUid();
	if (!uid) return null;
	const snap = await getDoc(ballotRef(guid, uid));
	if (!snap.exists()) return null;
	const d = snap.data();
	return { voterUid: uid, answers: (d.answers ?? {}) as Record<number, number[]> };
}

/**
 * 표 제출 — create only. 이미 표가 있으면 rule 이 update 를 막아(solo) 실패하거나,
 * shared 에서는 덮어쓰므로 호출 전에 getMyBallot 으로 막는다(UI 책임).
 */
export async function castBallot(
	guid: string,
	answers: Record<number, number[]>
): Promise<void> {
	const uid = await currentUid();
	if (!uid) throw new Error('투표하려면 먼저 로그인이 필요합니다.');
	await setDoc(ballotRef(guid, uid), { answers, at: serverTimestamp() });
}

/** 표 컬렉션 실시간 구독. 권한 없으면(비공개·비소유) onError → 빈 배열. */
export function subscribeBallots(guid: string, cb: (ballots: Ballot[]) => void): () => void {
	return onSnapshot(
		ballotsCol(guid),
		(snap) => {
			const out: Ballot[] = [];
			snap.forEach((d) => {
				const data = d.data();
				out.push({ voterUid: d.id, answers: (data.answers ?? {}) as Record<number, number[]> });
			});
			cb(out);
		},
		() => cb([])
	);
}
