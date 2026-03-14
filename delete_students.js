const admin = require('firebase-admin');
const path = require('path');

// Load service account and init admin
const serviceAccountPath = path.join(__dirname, 'service-account.json');
try {
  const serviceAccount = require(serviceAccountPath);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (err) {
  console.error('Failed to load service-account.json. Make sure it exists in the server folder.');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}

const db = admin.firestore();

async function deleteStudents() {
  console.log('Querying Firestore for users with role=="student"...');
  const snapshot = await db.collection('users').where('role', '==', 'student').get();
  if (snapshot.empty) {
    console.log('No student profiles found.');
    return;
  }

  for (const doc of snapshot.docs) {
    const uid = doc.id;
    const data = doc.data();
    console.log(`Processing student profile uid=${uid} email=${data.email || 'N/A'}`);
    try {
      // Try to delete auth user by uid
      await admin.auth().deleteUser(uid);
      console.log(`Deleted Auth user: ${uid}`);
    } catch (authErr) {
      console.warn(`Could not delete Auth user ${uid}:`, authErr && authErr.message ? authErr.message : authErr);
      // fallback: try deleting by email if present
      if (data.email) {
        try {
          const user = await admin.auth().getUserByEmail(data.email);
          await admin.auth().deleteUser(user.uid);
          console.log(`Deleted Auth user by email: ${user.uid}`);
        } catch (byEmailErr) {
          console.warn(`Failed to delete by email for ${data.email}:`, byEmailErr && byEmailErr.message ? byEmailErr.message : byEmailErr);
        }
      }
    }

    try {
      await db.collection('users').doc(uid).delete();
      console.log(`Deleted Firestore profile: ${uid}`);
    } catch (fsErr) {
      console.warn(`Failed to delete Firestore profile ${uid}:`, fsErr && fsErr.message ? fsErr.message : fsErr);
    }
  }
}

deleteStudents()
  .then(() => {
    console.log('Finished deleting student profiles.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error deleting students:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
