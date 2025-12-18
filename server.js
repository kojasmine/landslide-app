const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { GoogleGenerativeAI } = require("@google/generative-ai");
const https = require('https');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());

// INCREASE UPLOAD LIMITS
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// --- CONFIGURATION ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

if (!process.env.CLOUDINARY_CLOUD_NAME) console.error("⚠️ WARNING: Cloudinary Keys Missing!");

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- ROUTES ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

app.get('/api/config', (_req, res) => {
    res.json({ status: "ok", version: "1.0.4" });
});

// --- AUTH ---
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const check = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (check.rows.length > 0) return res.json({success:false, message:"Email exists"});
        const hash = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hash]);
        const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        res.json({ success: true, user: user.rows[0] });
    } catch (e) { res.status(500).json({success:false, message: e.message}); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.json({success:false, message:"User not found"});
        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);
        if(!match) return res.json({success:false, message:"Wrong password"});
        res.json({ success: true, user: { id: user.id, email: user.email } });
    } catch (e) { res.status(500).json({success:false, message: e.message}); }
});

// --- IMAGE UPLOAD ---
app.post('/api/image/upload', (req, res) => {
    upload.single('image')(req, res, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Upload error: " + err.message });
        if (!req.file) return res.status(400).json({ success: false, message: "No image received" });

        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: "land_survey_app", resource_type: "image" },
            (error, result) => {
                if (error) return res.status(500).json({ success: false, message: "Cloudinary Error: " + error.message });
                res.json({ success: true, url: result.secure_url, public_id: result.public_id });
            }
        );
        try {
            const bufferStream = require('stream').Readable.from(req.file.buffer);
            bufferStream.pipe(uploadStream);
        } catch (e) { res.status(500).json({ success: false, message: "Stream Error" }); }
    });
});

app.delete('/api/image/:filename', async (req, res) => {
    const filename = req.params.filename;
    const publicId = "land_survey_app/" + filename.split('.')[0]; 
    try { await cloudinary.uploader.destroy(publicId); res.json({ success: true }); } 
    catch (e) { res.json({ success: true }); }
});

// --- AI ANALYSIS ---
function downloadImage(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) { reject(new Error(`Status ${res.statusCode}`)); return; }
            const data = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', (err) => reject(err));
    });
}

app.post('/api/ai/analyze', async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: "No filename" });

    let imageUrl = filename;
    if (!filename.startsWith('http')) {
        imageUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/land_survey_app/${filename}`;
    }

    try {
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        // Using "gemini-flash-latest" as the safe free model
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        const imageBuffer = await downloadImage(imageUrl);
        const result = await model.generateContent([
            "Analyze this land survey photo. Describe terrain, vegetation, and man-made markers.",
            { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } },
        ]);
        const response = await result.response;
        res.json({ analysis: response.text() });
    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: error.message || "AI Failed" });
    }
});

// --- CLOUD SAVE (UPDATED FOR OVERWRITE) ---
app.post('/api/cloud/save', async (req, res) => {
    const { id, userId, name, data } = req.body;
    try {
        if (!id) {
            // New Save: Check Duplicate
            const check = await pool.query('SELECT id FROM user_projects WHERE user_id = $1 AND name = $2', [userId, name]);
            if (check.rows.length > 0) {
                // RETURN THE EXISTING ID SO FRONTEND CAN OVERWRITE
                return res.json({ success: false, status: 'EXISTS', existingId: check.rows[0].id, message: "Name exists" });
            }
            
            const result = await pool.query('INSERT INTO user_projects (user_id, name, data) VALUES ($1, $2, $3) RETURNING id', [userId, name, JSON.stringify(data)]);
            return res.json({ success: true, mode: 'create', newId: result.rows[0].id });
        } else {
            // Overwrite (Update)
            await pool.query('UPDATE user_projects SET data = $1, name = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4', [JSON.stringify(data), name, id, userId]);
            return res.json({ success: true, mode: 'update', newId: id });
        }
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/cloud/load/:userId', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, user_id, name, updated_at, data FROM user_projects WHERE user_id = $1 ORDER BY updated_at DESC', [req.params.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cloud/delete/:projectId', async (req, res) => {
    try { await pool.query('DELETE FROM user_projects WHERE id = $1', [req.params.projectId]); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// --- HIKE ROUTES ---
app.post('/api/hikes/save', async (req, res) => {
    const { userId, name, distance, path, stakes } = req.body;
    try {
        const result = await pool.query('INSERT INTO user_hikes (user_id, name, distance_ft, path_json, stakes_json) VALUES ($1, $2, $3, $4, $5) RETURNING id', [userId, name, distance, JSON.stringify(path), JSON.stringify(stakes)]);
        res.json({ success: true, newId: result.rows[0].id });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/hikes/list/:userId', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, distance_ft, start_time FROM user_hikes WHERE user_id = $1 ORDER BY start_time DESC', [req.params.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hikes/get/:hikeId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM user_hikes WHERE id = $1', [req.params.hikeId]);
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ message: "Hike not found" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/hikes/delete/:hikeId', async (req, res) => {
    try { await pool.query('DELETE FROM user_hikes WHERE id = $1', [req.params.hikeId]); res.json({ success: true }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- MAP SEARCH ---
app.get('/api/search', async (req, res) => {
    let { q } = req.query; if (!q || q.length < 1) return res.json([]);
    let cleanQ = q.toLowerCase().replace(/\bdrive\b|\bdr\b/g, '').replace(/\bstreet\b|\bst\b/g, '').trim();
    const query = `SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, ST_AsGeoJSON(p.geom) as geometry FROM taxdata t JOIN "Parcels_real" p ON REPLACE(t."PARID", ' ', '') = REPLACE(p."PIN", ' ', '') WHERE CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $1 OR CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $2 OR t."PARID"::text ILIKE $2 LIMIT 5;`;
    try { const result = await pool.query(query, [`%${cleanQ}%`, `%${q}%`]); res.json(result.rows); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    const query = `SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, ST_AsGeoJSON(p.geom) as geometry FROM "Parcels_real" p LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '') ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326) LIMIT 1;`;
    try { const result = await pool.query(query, [lng, lat]); res.json(result.rows); } catch (e) { res.status(500).send("Error"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));