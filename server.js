const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// --- 1. CONFIGURATION ---

// Database Config
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Cloudinary Config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer Config (Storage in memory temporarily)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- 2. ROUTES ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

// Config check
app.get('/api/config', (_req, res) => {
    res.json({ status: "ok", version: "cloudinary-enabled" });
});

// --- AUTHENTICATION ---
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

// --- CLOUD PROJECT SAVE ---
app.post('/api/cloud/save', async (req, res) => {
    const { id, userId, name, data } = req.body;
    try {
        if (!id) {
            const check = await pool.query('SELECT id FROM user_projects WHERE user_id = $1 AND name = $2', [userId, name]);
            if (check.rows.length > 0) return res.json({ success: false, message: "NAME_EXISTS" });
            
            const result = await pool.query(
                'INSERT INTO user_projects (user_id, name, data) VALUES ($1, $2, $3) RETURNING id',
                [userId, name, JSON.stringify(data)]
            );
            return res.json({ success: true, mode: 'create', newId: result.rows[0].id });
        } else {
            await pool.query(
                'UPDATE user_projects SET data = $1, name = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
                [JSON.stringify(data), name, id, userId]
            );
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
    try {
        await pool.query('DELETE FROM user_projects WHERE id = $1', [req.params.projectId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// --- CLOUDINARY IMAGE ROUTES ---

// Upload Endpoint
app.post('/api/image/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "No image provided" });

    // Use a stream to upload buffer directly to Cloudinary
    const uploadStream = cloudinary.uploader.upload_stream(
        { 
            folder: "land_survey_app", // Keeps your Cloudinary organized
            resource_type: "image"
        },
        (error, result) => {
            if (error) {
                console.error("Cloudinary Error:", error);
                return res.status(500).json({ success: false, message: "Upload failed" });
            }
            // Return the secure URL to the frontend
            res.json({ success: true, url: result.secure_url, public_id: result.public_id });
        }
    );

    // Pipe the file buffer from memory to the upload stream
    const bufferStream = require('stream').Readable.from(req.file.buffer);
    bufferStream.pipe(uploadStream);
});

// Delete Image Endpoint
app.delete('/api/image/:filename', async (req, res) => {
    const filename = req.params.filename;
    // Note: Cloudinary needs the 'public_id' to delete.
    // Since we store the full URL in frontend, extracting the exact public_id 
    // without the folder path might be tricky depending on how URL is parsed.
    // For now, we will assume the filename passed includes the folder if needed 
    // or we construct it. This is a basic implementation:
    
    // We try to guess the public_id based on the filename (removing extension)
    const publicId = "land_survey_app/" + filename.split('.')[0]; 

    try {
        await cloudinary.uploader.destroy(publicId);
        res.json({ success: true });
    } catch (e) {
        // Even if it fails, we return success so frontend removes it from UI
        console.error("Delete error", e);
        res.json({ success: true });
    }
});



// --- AI ANALYSIS ROUTE (GOOGLE GEMINI - FREE) ---
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Helper to download image from Cloudinary as a buffer
async function fetchImageToBuffer(url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

app.post('/api/ai/analyze', async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: "No filename provided" });

    // 1. Get the full Cloudinary URL
    let imageUrl = filename;
    if (!filename.startsWith('http')) {
        imageUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/land_survey_app/${filename}`;
    }

    try {
        // 2. Initialize Google AI
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        // Use 'gemini-1.5-flash' which is fast and free for this use case
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // 3. Download the image data (Gemini needs the raw data, not just a URL)
        const imageBuffer = await fetchImageToBuffer(imageUrl);

        // 4. Send to Google
        const prompt = "Analyze this land survey photo. Describe the terrain (flat, sloped), vegetation (dense, sparse), and any visible man-made objects like fences, stakes, or buildings. Keep it brief.";
        
        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: imageBuffer.toString("base64"),
                    mimeType: "image/jpeg",
                },
            },
        ]);

        const response = await result.response;
        const analysis = response.text();
        
        res.json({ analysis: analysis });

    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: "AI analysis failed. Check server logs." });
    }
});

// --- MAP DATA ROUTES ---
app.get('/api/search', async (req, res) => {
    let { q } = req.query; if (!q || q.length < 1) return res.json([]);
    let cleanQ = q.toLowerCase().replace(/\bdrive\b|\bdr\b/g, '').replace(/\bstreet\b|\bst\b/g, '').trim();

    const query = `
        SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, 
               ST_X(ST_Centroid(p.geom)) as lng, ST_Y(ST_Centroid(p.geom)) as lat, ST_AsGeoJSON(p.geom) as geometry
        FROM taxdata t JOIN "Parcels_real" p ON REPLACE(t."PARID", ' ', '') = REPLACE(p."PIN", ' ', '')
        WHERE CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $1 OR CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $2 OR t."PARID"::text ILIKE $2 LIMIT 5;
    `;
    try { const result = await pool.query(query, [`%${cleanQ}%`, `%${q}%`]); res.json(result.rows); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    const query = `SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '')
        ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326) LIMIT 1;`;
    try { const result = await pool.query(query, [lng, lat]); res.json(result.rows); } catch (e) { res.status(500).send("Error"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));