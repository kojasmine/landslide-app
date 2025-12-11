const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // Security for passwords
require('dotenv').config();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/index.html'));
});

// --- AUTHENTICATION APIs ---

// 1. REGISTER
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        
        const result = await pool.query(
            `INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email`,
            [email, hash]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: "Email already exists or error." });
    }
});

// 2. LOGIN
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        
        if (result.rows.length === 0) return res.json({ success: false, message: "User not found" });
        
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        
        if (!isMatch) return res.json({ success: false, message: "Wrong password" });
        
        res.json({ success: true, user: { id: user.id, email: user.email } });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// --- CLOUD SAVE/LOAD APIs ---

// 3. SAVE PROJECT
app.post('/api/cloud/save', async (req, res) => {
    const { userId, name, data } = req.body;
    try {
        // Check if project exists, update it. If not, insert new.
        // For MVP simplicity, we just INSERT a new row every time (History)
        // or Update if we tracked project ID. Let's just Insert for now.
        await pool.query(
            `INSERT INTO user_projects (user_id, name, data) VALUES ($1, $2, $3)`,
            [userId, name, JSON.stringify(data)]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// 4. LOAD PROJECTS
app.get('/api/cloud/load/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM user_projects WHERE user_id = $1 ORDER BY updated_at DESC`, 
            [req.params.userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- EXISTING SEARCH & MAP APIs ---
app.get('/api/search', async (req, res) => {
    const { q } = req.query; 
    if (!q || q.length < 1) return res.json([]);
    const query = `
        SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, 
               ST_X(ST_Centroid(p.geom)) as lng, ST_Y(ST_Centroid(p.geom)) as lat, ST_AsGeoJSON(p.geom) as geometry
        FROM taxdata t JOIN "Parcels_real" p ON REPLACE(t."PARID", ' ', '') = REPLACE(p."PIN", ' ', '')
        WHERE CONCAT(t."ADRNO", ' ', t."ADRSTR") ILIKE $1 OR t."PARID"::text ILIKE $1 OR t."ADRSTR" ILIKE $1 LIMIT 5;
    `;
    try {
        const result = await pool.query(query, [`%${q}%`]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/parcels', async (req, res) => {
    const { lat, lng } = req.query;
    const query = `
        SELECT p.id, t."PARID" as owner_name, CONCAT(t."ADRNO", ' ', t."ADRSTR") as address, ST_AsGeoJSON(p.geom) as geometry
        FROM "Parcels_real" p LEFT JOIN taxdata t ON REPLACE(p."PIN", ' ', '') = REPLACE(t."PARID", ' ', '')
        ORDER BY p.geom <-> ST_SetSRID(ST_Point($1, $2), 4326) LIMIT 1;
    `;
    try {
        const result = await pool.query(query, [lng, lat]);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Server Error"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});