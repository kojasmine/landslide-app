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

// --- UTILS ---
function fetchJson(url, headers = {}) {
    return new Promise((resolve) => {
        const urlObj = new URL(url);
        const options = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers: { 'User-Agent': 'LandScout/1.0', ...headers } };
        https.get(options, (resp) => { let d=''; resp.on('data', c=>d+=c); resp.on('end', ()=>{ try{resolve(JSON.parse(d))}catch(e){resolve(null)} }); }).on('error', ()=>resolve(null));
    });
}

// --- SEARCH & GEOCODING ---
app.get('/api/address/suggestions', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 3) return res.json([]); 
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&addressdetails=1&limit=5&countrycodes=us`;
    const data = await fetchJson(url);
    if (Array.isArray(data)) res.json(data.map(i => ({ label: i.display_name, lat: parseFloat(i.lat), lng: parseFloat(i.lon) })));
    else res.json([]);
});

app.get('/api/address/search', async (req, res) => {
    const { q } = req.query; if (!q) return res.status(400).json({ error: "No query" });
    const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
    const nomData = await fetchJson(nomUrl);
    if (Array.isArray(nomData) && nomData.length > 0) return res.json({ lat: parseFloat(nomData[0].lat), lng: parseFloat(nomData[0].lon), address: nomData[0].display_name });
    res.json({ error: "Address not found" });
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

// --- HIKE STORAGE ---
app.post('/api/hikes/save', async (req, res) => {
    const { userId, name, distance, path, stakes } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO user_hikes (user_id, name, distance_ft, path_json, stakes_json) VALUES ($1, $2, $3, $4, $5) RETURNING id', 
            [userId, name, distance, JSON.stringify(path), JSON.stringify(stakes)]
        );
        res.json({ success: true, newId: result.rows[0].id });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
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

// --- PARCEL LOOKUP ---
app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    const query = `SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, ST_AsGeoJSON(p.geom) as geometry FROM "Parcels_real" p LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '') ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326) LIMIT 1;`;
    const result = await pool.query(query, [lng, lat]);
    res.json(result.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));