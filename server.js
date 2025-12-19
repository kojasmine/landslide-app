const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { OAuth2Client } = require('google-auth-library'); // NEW LIBRARY
const https = require('https');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID); // GOOGLE SETUP

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '/index.html')));

// --- GOOGLE LOGIN ROUTE (NEW) ---
app.post('/api/auth/google', async (req, res) => {
    const { token } = req.body;
    try {
        // 1. Verify token with Google
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const email = payload.email;

        // 2. Check if user exists
        const check = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        let user;
        if (check.rows.length > 0) {
            // User exists - Login
            user = check.rows[0];
        } else {
            // User new - Register automatically (No password needed for Google users)
            await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, 'GOOGLE_AUTH']);
            const newUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
            user = newUser.rows[0];
        }

        res.json({ success: true, user: { id: user.id, email: user.email } });

    } catch (e) {
        console.error("Google Auth Error:", e);
        res.status(401).json({ success: false, message: "Invalid Token" });
    }
});

// ... [KEEP ALL YOUR OTHER ROUTES BELOW: SEARCH, UPLOAD, HIKES, ETC.] ...
// (I am skipping pasting the rest to save space, but DO NOT DELETE your other routes!)

// --- ADDRESS SEARCH ---
app.get('/api/address/search', async (req, res) => {
    // ... (Your existing code)
});

// ... (Paste the rest of your previous server.js here) ...
// (Parcels, Hikes, AI, etc.)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));