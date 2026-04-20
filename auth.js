'use strict';
// ── Firebase Auth 래퍼 ────────────────────────────────────────────────────────

async function authSignUp(email, password, nickname) {
    const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: nickname });
    await firebase.firestore()
        .collection('users').doc(cred.user.uid)
        .set({ nickname, email, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    return cred.user;
}

async function authSignIn(email, password) {
    const cred = await firebase.auth().signInWithEmailAndPassword(email, password);
    return cred.user;
}

async function authSignOut() {
    await firebase.auth().signOut();
}

function authCurrentUser() {
    return firebase.auth().currentUser;
}

// cb(user | null) — 앱 진입 시 1회 호출됨
function authOnChange(cb) {
    return firebase.auth().onAuthStateChanged(cb);
}
