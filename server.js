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

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '/index.html')));

// --- AUTH & ACCOUNT ---
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hash]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({success:false, message:"Email exists"}); }
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

app.put('/api/user/update-profile', async (req, res) => {
    const { userId, newEmail } = req.body;
    try {
        await pool.query('UPDATE users SET email = $1 WHERE id = $2', [newEmail, userId]);
        res.json({ success: true, message: "Email updated" });
    } catch (e) { res.status(500).json({ success: false, message: "Error" }); }
});

app.put('/api/user/change-password', async (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    try {
        const result = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
        const match = await bcrypt.compare(oldPassword, result.rows[0].password);
        if (!match) return res.json({ success: false, message: "Old password wrong" });
        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, userId]);
        res.json({ success: true, message: "Password updated" });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.delete('/api/user/delete-account/:userId', async (req, res) => {
    try {
        await pool.query('DELETE FROM user_hikes WHERE user_id = $1', [req.params.userId]);
        await pool.query('DELETE FROM user_projects WHERE user_id = $1', [req.params.userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.userId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- AI ANALYZE ---
function downloadImage(url) { return new Promise((resolve) => { https.get(url, (res) => { const data = []; res.on('data', (chunk) => data.push(chunk)); res.on('end', () => resolve(Buffer.concat(data))); }); }); }
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

// --- HIKES & PARCELS ---
app.post('/api/hikes/save', async (req, res) => {
    const { id, userId, name, distance, path, stakes } = req.body;
    const check = await pool.query('SELECT id FROM user_hikes WHERE user_id = $1 AND name = $2', [userId, name]);
    if (!id && check.rows.length > 0) return res.json({ success: false, status: 'EXISTS', existingId: check.rows[0].id });
    if (!id) {
        const r = await pool.query('INSERT INTO user_hikes (user_id, name, distance_ft, path_json, stakes_json) VALUES ($1, $2, $3, $4, $5) RETURNING id', [userId, name, distance, JSON.stringify(path), JSON.stringify(stakes)]);
        res.json({ success: true, newId: r.rows[0].id });
    } else {
        await pool.query('UPDATE user_hikes SET name=$1, distance_ft=$2, path_json=$3, stakes_json=$4 WHERE id=$5', [name, distance, JSON.stringify(path), JSON.stringify(stakes), id]);
        res.json({ success: true, newId: id });
    }
});
app.get('/api/hikes/list/:userId', async (req, res) => { const r = await pool.query('SELECT * FROM user_hikes WHERE user_id = $1 ORDER BY start_time DESC', [req.params.userId]); res.json(r.rows); });
app.get('/api/hikes/get/:id', async (req, res) => { const r = await pool.query('SELECT * FROM user_hikes WHERE id = $1', [req.params.id]); res.json(r.rows[0]); });
app.delete('/api/hikes/delete/:id', async (req, res) => { await pool.query('DELETE FROM user_hikes WHERE id = $1', [req.params.id]); res.json({ success: true }); });

app.post('/api/image/upload', upload.single('image'), (req, res) => {
    const uploadStream = cloudinary.uploader.upload_stream({ folder: "land_survey_app" }, (err, result) => res.json({ success: true, url: result.secure_url }));
    require('stream').Readable.from(req.file.buffer).pipe(uploadStream);
});

app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    const query = `SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, ST_AsGeoJSON(p.geom) as geometry FROM "Parcels_real" p LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '') ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326) LIMIT 1;`;
    const result = await pool.query(query, [lng, lat]);
    res.json(result.rows);
});

app.get('/api/address/search', async (req, res) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(req.query.q)}&limit=1`;
    https.get(url, { headers: { 'User-Agent': 'LandScout' } }, (resp) => {
        let d = ''; resp.on('data', c => d += c);
        resp.on('end', () => { const j = JSON.parse(d); if (j.length > 0) res.json({ lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) }); else res.json({ error: "Not found" }); });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));