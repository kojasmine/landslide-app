const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs'); 
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());

// --- CRITICAL FOR PHOTOS: INCREASE DATA LIMIT TO 50MB ---
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

// ==========================================
// 1. AUTHENTICATION
// ==========================================

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

// ==========================================
// 2. CLOUD SAVE (HANDLES PHOTOS)
// ==========================================

app.post('/api/cloud/save', async (req, res) => {
    // Note: 'data' contains the huge string of stakes + photos
    const { id, userId, name, data } = req.body;
    
    try {
        if (!id) {
            // New Save: Check Duplicate Name
            const check = await pool.query('SELECT id FROM user_projects WHERE user_id = $1 AND name = $2', [userId, name]);
            if (check.rows.length > 0) return res.json({ success: false, message: "File name already exists!" });
            
            // Insert New
            const result = await pool.query(
                'INSERT INTO user_projects (user_id, name, data) VALUES ($1, $2, $3) RETURNING id',
                [userId, name, JSON.stringify(data)]
            );
            return res.json({ success: true, mode: 'create', newId: result.rows[0].id });
        } else {
            // Update Existing
            await pool.query(
                'UPDATE user_projects SET data = $1, name = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
                [JSON.stringify(data), name, id, userId]
            );
            return res.json({ success: true, mode: 'update', newId: id });
        }
    } catch (err) { 
        console.error("Save Error:", err.message); // Log exact error to Render
        res.status(500).json({ success: false, message: "Server Error (File too big?)" }); 
    }
});

app.get('/api/cloud/load/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM user_projects WHERE user_id = $1 ORDER BY updated_at DESC', 
            [req.params.userId]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cloud/delete/:projectId', async (req, res) => {
    try {
        await pool.query('DELETE FROM user_projects WHERE id = $1', [req.params.projectId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ==========================================
// 3. MAP DATA
// ==========================================

app.get('/api/search', async (req, res) => {
    let { q } = req.query; if (!q || q.length < 1) return res.json([]);
    let cleanQ = q.toLowerCase().replace(/\bdrive\b|\bdr\b/g, '').replace(/\bstreet\b|\bst\b/g, '').trim();

    const query = `
        SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, 
               ST_X(ST_Centroid(p.geom)) as lng, ST_Y(ST_Centroid(p.geom)) as lat, ST_AsGeoJSON(p.geom) as geometry
        FROM taxdata t JOIN "Parcels_real" p ON REPLACE(t."PARID", ' ', '') = REPLACE(p."PIN", ' ', '')
        WHERE CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $1 OR CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $2 OR t."PARID"::text ILIKE $2 LIMIT 5;
    `;
    try { const result = await pool.query(query, [`%${cleanQ}%`, `%${q}%`]); res.json(result.rows); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    const query = `
        SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '')
        ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326) LIMIT 1;
    `;
    try { const result = await pool.query(query, [lng, lat]); res.json(result.rows); } 
    catch (e) { res.status(500).send("Error"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));