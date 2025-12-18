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

// --- 1. ADDRESS AUTOCOMPLETE (PHOTON) ---
app.get('/api/address/suggestions', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 3) return res.json([]); 
    
    // Search Photon API (Global, OpenStreetMap)
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`;
    
    https.get(url, (resp) => {
        let data = '';
        resp.on('data', (chunk) => data += chunk);
        resp.on('end', () => {
            try {
                const json = JSON.parse(data);
                if (json.features) {
                    const results = json.features.map(f => {
                        const p = f.properties;
                        // Create a clean label: "Name, Street, City, State"
                        const label = [p.name, p.street, p.city, p.state, p.country].filter(Boolean).join(', ');
                        return { 
                            label: label, 
                            lat: f.geometry.coordinates[1], 
                            lng: f.geometry.coordinates[0] 
                        };
                    });
                    res.json(results);
                } else { res.json([]); }
            } catch(e) { res.json([]); }
        });
    }).on('error', () => res.json([]));
});

// --- 2. EXACT SEARCH (CENSUS + PHOTON) ---
function fetchJson(url) {
    return new Promise((resolve) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

app.get('/api/address/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: "No query" });

    // Try US Census first (Best for house numbers)
    const censusUrl = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`;
    const censusData = await fetchJson(censusUrl);
    if (censusData?.result?.addressMatches?.length > 0) {
        const match = censusData.result.addressMatches[0];
        return res.json({ lat: match.coordinates.y, lng: match.coordinates.x, address: match.matchedAddress });
    }

    // Fallback to Photon (Best for streets/places)
    const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`;
    const photonData = await fetchJson(photonUrl);
    if (photonData?.features?.length > 0) {
        const f = photonData.features[0];
        const p = f.properties;
        const addr = [p.name, p.housenumber, p.street, p.city, p.state].filter(Boolean).join(', ');
        return res.json({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], address: addr });
    }

    res.json({ error: "Address not found" });
});

// --- 3. CORE FEATURES ---
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

app.post('/api/image/upload', upload.single('image'), (req, res) => {
    if(!req.file) return res.status(400).json({success:false, message:"No file"});
    const uploadStream = cloudinary.uploader.upload_stream({ folder: "land_survey_app" }, (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, url: result.secure_url });
    });
    require('stream').Readable.from(req.file.buffer).pipe(uploadStream);
});

app.post('/api/ai/analyze', async (req, res) => {
    const { filename } = req.body;
    const imageUrl = filename.startsWith('http') ? filename : `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/land_survey_app/${filename}`;
    try {
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
        
        // Simple fetch for AI image
        const imgResp = await new Promise((resolve) => https.get(imageUrl, (r) => {
             const data = []; r.on('data', c=>data.push(c)); r.on('end', ()=>resolve(Buffer.concat(data)));
        }));
        
        const result = await model.generateContent(["Analyze survey photo.", { inlineData: { data: imgResp.toString("base64"), mimeType: "image/jpeg" } }]);
        res.json({ analysis: result.response.text() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

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
app.delete('/api/cloud/delete/:id', async (req, res) => {
    await pool.query('DELETE FROM user_projects WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

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

app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    const query = `SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, ST_AsGeoJSON(p.geom) as geometry FROM "Parcels_real" p LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '') ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326) LIMIT 1;`;
    const result = await pool.query(query, [lng, lat]);
    res.json(result.rows);
});

app.listen(process.env.PORT || 3000, () => console.log(`Server on ${process.env.PORT || 3000}`));