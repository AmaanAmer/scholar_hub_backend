require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
const corsOptions = {
    origin: [
        'https://scholar-hub-backend.vercel.app',
        /\.vercel\.app$/,
        'http://localhost:5173',
        'http://localhost:3000',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json());
// allow preflight for all routes
app.options('*', cors(corsOptions));

// Initialize Firebase Admin
// On Vercel: set FIREBASE_SERVICE_ACCOUNT_JSON env var to the full service account JSON string
// Locally: place service-account.json in this directory
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else {
        const serviceAccountPath = path.join(__dirname, 'service-account.json');
        serviceAccount = require(serviceAccountPath);
    }
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized.');
} catch (err) {
    console.error('ERROR: Firebase Admin init failed. Set FIREBASE_SERVICE_ACCOUNT_JSON env var or place service-account.json locally.', err?.message);
}

const db = admin.firestore();

// Helper to ensure Admin SDK is initialized before performing admin actions
function ensureAdminInitialized(req, res, next) {
    if (!admin.apps || admin.apps.length === 0) {
        console.error('Attempted admin operation while Firebase Admin is not initialized');
        return res.status(500).json({ error: 'Server misconfiguration: Firebase Admin not initialized. Place service-account.json in the server folder.' });
    }
    next();
}

// Global process handlers for improved debugging
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
});

app.post('/createStudent', ensureAdminInitialized, async (req, res) => {
    const { email, password, name, degree, semester } = req.body;

    if (!email || !password || !name) {
        return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    try {
        // 1. Create User in Auth
        const userRecord = await admin.auth().createUser({
            email,
            password,
            displayName: name,
        });

        // 2. Create Profile in Firestore
        const profileData = {
            email,
            name,
            role: 'student',
            degree: degree || '',
            semester: semester || '',
            createdAt: new Date().toISOString()
        }
        await db.collection('users').doc(userRecord.uid).set({
            ...profileData,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Return profile and uid so clients can immediately show the created student
        const resp = { ok: true, uid: userRecord.uid, profile: { id: userRecord.uid, ...profileData } };
        // Do NOT return plaintext passwords in responses. Password is set in Auth server-side only.
        res.json(resp);
    } catch (err) {
        console.error('Failure creating student:', err && err.stack ? err.stack : err);
        // If email already exists in Auth, create Firestore profile for existing user and return it
        if (err && (err.code === 'auth/email-already-exists' || (err.message && err.message.includes('email address is already in use')))) {
            try {
                const existing = await admin.auth().getUserByEmail(email)
                const uid = existing.uid
                // Prefer the existing Auth displayName if present
                const displayName = existing.displayName || name
                const profileData = {
                    email,
                    name: displayName,
                    role: 'student',
                    degree: degree || '',
                    semester: semester || '',
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                }
                // ensure profile exists (merge to avoid overwriting)
                await db.collection('users').doc(uid).set(profileData, { merge: true })
                // If admin provided a password, update the existing Auth user to set that password
                if (password) {
                    try {
                        await admin.auth().updateUser(uid, { password });
                    } catch (pwErr) {
                        console.warn('Could not update password for existing user:', pwErr && pwErr.message ? pwErr.message : pwErr);
                    }
                }
                const out = { ok: true, uid, profile: { id: uid, email, name: displayName, role: 'student', degree: degree || '', semester: semester || '', createdAt: new Date().toISOString() } };
                // Do NOT include plaintext password in response. Password applied to Auth above.
                return res.json(out);
                } catch (innerErr) {
                    console.error('Failure handling existing email during createStudent:', innerErr && innerErr.stack ? innerErr.stack : innerErr)
                    return res.status(500).json({ error: innerErr.message || String(innerErr) })
                }
        }
        return res.status(500).json({ error: err.message || String(err) });
    }
});

app.post('/deleteStudent', ensureAdminInitialized, async (req, res) => {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid is required' });
    try {
        // Delete from Auth
        await admin.auth().deleteUser(uid);
        // Delete Firestore profile
        await db.collection('users').doc(uid).delete();
        res.json({ ok: true });
    } catch (err) {
        console.error('Failure deleting student:', err && err.stack ? err.stack : err);
        return res.status(500).json({ error: err.message || String(err) });
    }
});

// Delete a student by email (convenience for local testing)
app.post('/deleteStudentByEmail', ensureAdminInitialized, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    try {
        const userRecord = await admin.auth().getUserByEmail(email);
        const uid = userRecord.uid;
        await admin.auth().deleteUser(uid);
        await db.collection('users').doc(uid).delete();
        res.json({ ok: true, uid });
    } catch (err) {
        console.error('Failure deleting student by email:', err && err.stack ? err.stack : err);
        return res.status(500).json({ error: err.message || String(err) });
    }
});

// Set/Reset a student's password (admin-only). Body: { uid, password }
app.post('/setPassword', ensureAdminInitialized, async (req, res) => {
    const { uid, password } = req.body;
    if (!uid || !password) return res.status(400).json({ error: 'uid and password are required' });
    try {
        await admin.auth().updateUser(uid, { password });
        res.json({ ok: true });
    } catch (err) {
        console.error('Failure setting password for user', uid, err && err.stack ? err.stack : err);
        return res.status(500).json({ error: err.message || String(err) });
    }
});

// Health and root status endpoints
app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime(), timestamp: Date.now() })
})

app.get('/', (req, res) => {
    res.send('<h1>Admin backend running</h1><p>Available endpoints:<ul><li>POST /createStudent</li><li>GET /health</li></ul></p>')
})

// Export for Vercel serverless
module.exports = app;

// Local dev only
if (require.main === module) {
    const PORT = 3001;
    app.listen(PORT, () => {
        console.log(`Admin backend running on http://localhost:${PORT}`);
    });
}
