'use strict';
// ── Firebase 즉시 초기화 ──────────────────────────────────────────────────────
if (!firebase.apps.length) {
    firebase.initializeApp(window.FIREBASE_CONFIG);
}
const _db = firebase.firestore();

function getDB() { return _db; }

function getSessionsRef() {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('로그인이 필요합니다.');
    return getDB().collection('users').doc(user.uid).collection('sessions');
}

async function dbSaveSession(data) {
    const ref = await getSessionsRef().add({
        ...data,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return ref.id;
}

async function dbLoadSessions() {
    const snap = await getSessionsRef().orderBy('startTime', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function dbDeleteSession(id) {
    await getSessionsRef().doc(id).delete();
}
