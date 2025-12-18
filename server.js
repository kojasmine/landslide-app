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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '/index.html')));

// --- ADDRESS SEARCH (PHOTON / OPENSTREETMAP) ---
// Docs: https://photon.komoot.io/
// This is much more reliable than raw Nominatim
app.get('/api/address/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "No query" });
    
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`;
    
    https.get(url, (resp) => {
        let data = '';
        resp.on('data', (chunk) => data += chunk);
        resp.on('end', () => {
            try {
                const json = JSON.parse(data);
                if (json.features && json.features.length > 0) {
                    const feat = json.features[0];
                    const coords = feat.geometry.coordinates; // Photon returns [lon, lat]
                    
                    // Build address label
                    const p = feat.properties;
                    const address = [p.name, p.street, p.city, p.state, p.country].filter(Boolean).join(', ');

                    // Send back [lat, lng] for Leaflet
                    res.json({ lat: coords[1], lng: coords[0], address: address });
                } else {
                    res.json({ error: "Address not found" });
                }
            } catch(e) { 
                console.error("Search Error:", e);
                res.status(500).json({ error: "Search Provider Error" }); 
            }
        });
    }).on('error', (err) => res.status(500).json({ error: err.message }));
});

// --- AUTH ---
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const check = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (check.rows.length > 0) return res.json({success:false, message:"Email exists"});
        const hash = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hash]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({success:false, message: e.message}); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.json({success:false, message:"User not found"});
        const match = await bcrypt.compare(password, result.rows[0].password);
        if(!match) return res.json({success:false, message:"Wrong password"});
        res.json({ success: true, user: { id: result.rows[0].id, email: result.rows[0].email } });
    } catch (e) { res.status(500).json({success:false, message: e.message}); }
});

// --- IMAGE UPLOAD ---
app.post('/api/image/upload', upload.single('image'), (req, res) => {
    if(!req.file) return res.status(400).json({success:false, message:"No file"});
    const uploadStream = cloudinary.uploader.upload_stream({ folder: "land_survey_app" }, (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, url: result.secure_url });
    });
    require('stream').Readable.from(req.file.buffer).pipe(uploadStream);
});

// --- AI ---
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
    const imageUrl = filename.startsWith('http') ? filename : `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/land_survey_app/${filename}`;
    try {
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
        const imageBuffer = await downloadImage(imageUrl);
        const result = await model.generateContent(["Analyze land survey photo.", { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } }]);
        res.json({ analysis: result.response.text() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- CLOUD SAVE ---
app.post('/api/cloud/save', async (req, res) => {
    const { id, userId, name, data } = req.body;
    try {
        if (!id) {
            const check = await pool.query('SELECT id FROM user_projects WHERE user_id = $1 AND name = $2', [userId, name]);
            if (check.rows.length > 0) return res.json({ success: false, status: 'EXISTS', existingId: check.rows[0].id });
            const result = await pool.query('INSERT INTO user_projects (user_id, name, data) VALUES ($1, $2, $3) RETURNING id', [userId, name, JSON.stringify(data)]);
            res.json({ success: true, newId: result.rows[0].id });
        } else {
            await pool.query('UPDATE user_projects SET data = $1, name = $2, updated_at = NOW() WHERE id = $3', [JSON.stringify(data), name, id]);
            res.json({ success: true, newId: id });
        }
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/cloud/load/:userId', async (req, res) => {
    const r = await pool.query('SELECT * FROM user_projects WHERE user_id = $1 ORDER BY updated_at DESC', [req.params.userId]);
    res.json(r.rows);
});

app.delete('/api/cloud/delete/:projectId', async (req, res) => {
    await pool.query('DELETE FROM user_projects WHERE id = $1', [req.params.projectId]);
    res.json({ success: true });
});

// --- HIKES ---
app.post('/api/hikes/save', async (req, res) => {
    const { userId, name, distance, path, stakes } = req.body;
    await pool.query('INSERT INTO user_hikes (user_id, name, distance_ft, path_json, stakes_json) VALUES ($1, $2, $3, $4, $5)', [userId, name, distance, JSON.stringify(path), JSON.stringify(stakes)]);
    res.json({ success: true });
});

app.get('/api/hikes/list/:userId', async (req, res) => {
    const r = await pool.query('SELECT id, name, distance_ft, start_time FROM user_hikes WHERE user_id = $1 ORDER BY start_time DESC', [req.params.userId]);
    res.json(r.rows);
});

app.get('/api/hikes/get/:id', async (req, res) => {
    const r = await pool.query('SELECT * FROM user_hikes WHERE id = $1', [req.params.id]);
    res.json(r.rows[0]);
});

app.delete('/api/hikes/delete/:id', async (req, res) => {
    await pool.query('DELETE FROM user_hikes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

// --- PARCELS ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    const query = `SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, ST_AsGeoJSON(p.geom) as geometry FROM "Parcels_real" p LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '') ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326) LIMIT 1;`;
    const result = await pool.query(query, [lng, lat]);
    res.json(result.rows);
});

app.listen(process.env.PORT || 3000, () => console.log(`Server on ${process.env.PORT || 3000}`));